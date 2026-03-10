import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import {
  LlmProvider,
  TenantWarehouseProvider,
  WarehouseAdapter,
} from "../core/interfaces.js";
import { DbtModelInfo } from "../core/types.js";
import { ask, askRequired, log, ui } from "./prompt.js";

interface MetricDefinition {
  name: string;
  description: string;
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

function buildModelCatalog(
  models: DbtModelInfo[],
  database: string,
  defaultSchema: string,
  provider: TenantWarehouseProvider
): string {
  return models
    .map((m) => {
      const schema = inferSchemaFromPath(m.relativePath, defaultSchema);
      const fqRef =
        provider === "bigquery"
          ? `\`${database}.${schema}.${m.name}\``
          : `"${database}"."${schema}"."${m.name}"`;
      return `- ${m.name} (${m.relativePath}) -> ${fqRef}`;
    })
    .join("\n");
}

export async function collectMetrics(
  rl: readline.Interface
): Promise<MetricDefinition[]> {
  log(`\n  ${ui.bold("Metrics Definition")}`);
  log(
    `  ${ui.dim("Define business metrics. For each one, we'll generate an example SQL query.")}`
  );
  log(
    `  ${ui.dim('Enter metrics one at a time. Type "done" or leave empty to finish.')}`
  );

  const metrics: MetricDefinition[] = [];

  while (true) {
    const name = await ask(
      rl,
      `\n  Metric name (or "done")`
    );
    if (!name || name.toLowerCase() === "done") {
      if (metrics.length === 0) {
        log(`  ${ui.warn("No metrics defined. Skipping metrics generation.")}`);
      }
      break;
    }

    const description = await askRequired(
      rl,
      `  Description for "${name}"`
    );
    metrics.push({ name, description });
    log(`  ${ui.success("+")} ${name}`);
  }

  return metrics;
}

async function generateMetricQuery(
  metric: MetricDefinition,
  models: DbtModelInfo[],
  database: string,
  defaultSchema: string,
  provider: TenantWarehouseProvider,
  warehouse: WarehouseAdapter,
  llm: LlmProvider,
  llmModel: string
): Promise<string> {
  const catalog = buildModelCatalog(models, database, defaultSchema, provider);
  const providerName = provider === "bigquery" ? "BigQuery" : "Snowflake";

  const result = await llm.generateText({
    model: llmModel,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: [
          `You are a senior analytics engineer writing ${providerName} SQL.`,
          "Given a metric definition and a catalog of available dbt models, produce:",
          "1. A brief explanation of the metric and which models it uses.",
          "2. An example SQL query that calculates this metric.",
          "3. Any caveats or assumptions.",
          "",
          "Rules:",
          "- Use ONLY fully-qualified table names from the catalog.",
          "- Write read-only SELECT queries only.",
          "- Keep the query practical and production-ready.",
          "- Format the SQL in a markdown code block.",
          "- If the metric cannot be computed from the available models, say so clearly and suggest what models would be needed.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Metric: ${metric.name}`,
          `Description: ${metric.description}`,
          "",
          `Available models:\n${catalog}`,
        ].join("\n"),
      },
    ],
  });

  return result;
}

export async function generateMetricsContextFiles(
  contextDir: string,
  metrics: MetricDefinition[],
  models: DbtModelInfo[],
  database: string,
  defaultSchema: string,
  provider: TenantWarehouseProvider,
  warehouse: WarehouseAdapter,
  llm: LlmProvider,
  llmModel: string
): Promise<void> {
  if (metrics.length === 0) return;

  const metricsDir = path.join(contextDir, "metrics");
  fs.mkdirSync(metricsDir, { recursive: true });

  log(
    `  ${ui.dim(`Generating context for ${metrics.length} metrics...`)}`
  );

  for (let i = 0; i < metrics.length; i++) {
    const metric = metrics[i];
    try {
      log(
        `  ${ui.dim(`[${i + 1}/${metrics.length}]`)} ${metric.name}...`
      );

      const content = await generateMetricQuery(
        metric,
        models,
        database,
        defaultSchema,
        provider,
        warehouse,
        llm,
        llmModel
      );

      const slug = metric.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");

      const md = [
        `# ${metric.name}\n`,
        `**Description:** ${metric.description}\n`,
        content,
      ].join("\n");

      const filePath = path.join(metricsDir, `${slug}.md`);
      fs.writeFileSync(filePath, md, "utf8");

      log(
        `  ${ui.success(`[${i + 1}/${metrics.length}]`)} ${metric.name}`
      );
    } catch (error) {
      log(
        `  ${ui.error(`[${i + 1}/${metrics.length}]`)} ${metric.name} — ${(error as Error).message}`
      );
    }
  }

  log(`\n  ${ui.success(`${metrics.length} metric docs generated in metrics/`)}`);
}
