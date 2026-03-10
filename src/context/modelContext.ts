import fs from "node:fs";
import path from "node:path";
import {
  DbtRepositoryService,
  LlmProvider,
  TenantWarehouseProvider,
  WarehouseAdapter,
} from "../core/interfaces.js";
import { DbtModelInfo, QueryResult } from "../core/types.js";
import { log, ui } from "./prompt.js";

interface ModelProfile {
  modelName: string;
  relativePath: string;
  dbtSql: string | null;
  columns: Array<{ column_name: string; data_type: string }>;
  rowCount: number | null;
  sampleRows: Record<string, unknown>[];
  columnStats: Array<{
    column: string;
    distinctCount: number | null;
    nullCount: number | null;
    minValue: string | null;
    maxValue: string | null;
  }>;
}

function inferSchemaFromPath(
  relativePath: string,
  defaultSchema: string
): string {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/marts/")) return "MARTS";
  if (normalized.includes("/intermediate/") || normalized.includes("/int/"))
    return "INT";
  if (normalized.includes("/staging/") || normalized.includes("/stg/"))
    return "STAGING";
  if (normalized.includes("/core/")) return "CORE";
  return defaultSchema || "PUBLIC";
}

function fqTable(
  model: DbtModelInfo,
  database: string,
  defaultSchema: string,
  provider: TenantWarehouseProvider
): string {
  const schema = inferSchemaFromPath(model.relativePath, defaultSchema);
  if (provider === "bigquery") {
    return `\`${database}.${schema}.${model.name}\``;
  }
  return `"${database}"."${schema}"."${model.name}"`;
}

function buildColumnsSql(
  database: string,
  schema: string,
  tableName: string,
  provider: TenantWarehouseProvider
): string {
  if (provider === "bigquery") {
    return `SELECT column_name, data_type FROM \`${database}.${schema}\`.INFORMATION_SCHEMA.COLUMNS WHERE table_name = '${tableName}' ORDER BY ordinal_position`;
  }
  return `SELECT COLUMN_NAME, DATA_TYPE FROM "${database}".INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = '${schema}' AND TABLE_NAME = '${tableName}' ORDER BY ORDINAL_POSITION`;
}

function buildRowCountSql(fqRef: string): string {
  return `SELECT COUNT(*) AS row_count FROM ${fqRef}`;
}

function buildSampleSql(fqRef: string): string {
  return `SELECT * FROM ${fqRef} LIMIT 5`;
}

async function safeQuery(
  warehouse: WarehouseAdapter,
  sql: string
): Promise<QueryResult | null> {
  try {
    return await warehouse.query(sql, { timeoutMs: 30_000 });
  } catch {
    return null;
  }
}

async function profileModel(
  model: DbtModelInfo,
  dbt: DbtRepositoryService,
  tenantId: string,
  warehouse: WarehouseAdapter,
  database: string,
  defaultSchema: string,
  provider: TenantWarehouseProvider
): Promise<ModelProfile> {
  const schema = inferSchemaFromPath(model.relativePath, defaultSchema);
  const fqRef = fqTable(model, database, defaultSchema, provider);

  const [dbtSql, columnsResult, countResult, sampleResult] = await Promise.all(
    [
      dbt.getModelSql(tenantId, model.name).catch(() => null),
      safeQuery(
        warehouse,
        buildColumnsSql(database, schema, model.name, provider)
      ),
      safeQuery(warehouse, buildRowCountSql(fqRef)),
      safeQuery(warehouse, buildSampleSql(fqRef)),
    ]
  );

  const columns: ModelProfile["columns"] =
    columnsResult?.rows.map((r) => ({
      column_name: String(
        r.column_name ?? r.COLUMN_NAME ?? ""
      ),
      data_type: String(r.data_type ?? r.DATA_TYPE ?? ""),
    })) ?? [];

  const rowCount =
    countResult?.rows[0] != null
      ? Number(
          countResult.rows[0].row_count ??
            countResult.rows[0].ROW_COUNT ??
            0
        )
      : null;

  const sampleRows = sampleResult?.rows.slice(0, 5) ?? [];

  return {
    modelName: model.name,
    relativePath: model.relativePath,
    dbtSql,
    columns,
    rowCount,
    sampleRows,
    columnStats: [],
  };
}

async function generateModelDoc(
  profile: ModelProfile,
  llm: LlmProvider,
  llmModel: string
): Promise<string> {
  const columnsTable = profile.columns
    .map((c) => `| ${c.column_name} | ${c.data_type} |`)
    .join("\n");

  const sampleSection =
    profile.sampleRows.length > 0
      ? `Sample data (first ${profile.sampleRows.length} rows):\n${JSON.stringify(profile.sampleRows, null, 2)}`
      : "No sample data available.";

  const dbtSection = profile.dbtSql
    ? `dbt SQL definition:\n\`\`\`sql\n${profile.dbtSql}\n\`\`\``
    : "dbt SQL not available.";

  const prompt = [
    `Model: ${profile.modelName}`,
    `Path: ${profile.relativePath}`,
    `Row count: ${profile.rowCount ?? "unknown"}`,
    "",
    `Columns:\n| Column | Type |\n|---|---|\n${columnsTable}`,
    "",
    sampleSection,
    "",
    dbtSection,
  ].join("\n");

  const result = await llm.generateText({
    model: llmModel,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: [
          "You are a data documentation expert. Given a data warehouse model profile, generate clear markdown documentation. Include:",
          "1. A one-paragraph **Description** of what this model represents and its business purpose (infer from column names, SQL, and sample data).",
          "2. A **Columns** table with column name, data type, and a brief description of each column.",
          "3. **Key Relationships** — any foreign keys or joins you can infer from the SQL or naming conventions.",
          "4. **Usage Notes** — tips for analysts querying this model (important filters, common aggregations, gotchas).",
          "",
          "Write in markdown. Be concise and practical. Do not include a title heading — it will be added automatically.",
        ].join("\n"),
      },
      { role: "user", content: prompt },
    ],
  });

  return result;
}

const CONCURRENCY = 5;

export async function generateModelContextFiles(
  contextDir: string,
  models: DbtModelInfo[],
  dbt: DbtRepositoryService,
  tenantId: string,
  warehouse: WarehouseAdapter,
  database: string,
  defaultSchema: string,
  provider: TenantWarehouseProvider,
  llm: LlmProvider,
  llmModel: string
): Promise<void> {
  const modelsDir = path.join(contextDir, "models");
  fs.mkdirSync(modelsDir, { recursive: true });

  log(
    `  ${ui.dim(`Profiling and documenting ${models.length} models (concurrency=${CONCURRENCY})...`)}`
  );

  let completed = 0;

  const processModel = async (model: DbtModelInfo): Promise<void> => {
    try {
      const profile = await profileModel(
        model,
        dbt,
        tenantId,
        warehouse,
        database,
        defaultSchema,
        provider
      );

      const doc = await generateModelDoc(profile, llm, llmModel);

      const content = [
        `# ${model.name}\n`,
        `**Path:** \`${model.relativePath}\`  `,
        `**Row count:** ${profile.rowCount?.toLocaleString() ?? "unknown"}\n`,
        doc,
      ].join("\n");

      const filePath = path.join(modelsDir, `${model.name}.md`);
      fs.writeFileSync(filePath, content, "utf8");

      completed++;
      log(
        `  ${ui.success(`[${completed}/${models.length}]`)} ${model.name}`
      );
    } catch (error) {
      completed++;
      log(
        `  ${ui.error(`[${completed}/${models.length}]`)} ${model.name} — ${(error as Error).message}`
      );
    }
  };

  const queue = [...models];
  const running: Promise<void>[] = [];

  while (queue.length > 0 || running.length > 0) {
    while (running.length < CONCURRENCY && queue.length > 0) {
      const model = queue.shift()!;
      const promise = processModel(model).then(() => {
        running.splice(running.indexOf(promise), 1);
      });
      running.push(promise);
    }
    if (running.length > 0) {
      await Promise.race(running);
    }
  }

  log(`\n  ${ui.success(`${completed} model docs generated in models/`)}`);
}
