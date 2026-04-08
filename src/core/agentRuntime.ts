import { CronTime } from "cron";
import { z } from "zod";
import { env } from "../config/env.js";
import {
  ChartBuildRequest,
  ChartTool,
  ConversationStore,
  DbtRepositoryService,
  LlmMessage,
  LlmProvider,
  LlmUsage,
  TenantWarehouseProvider,
  WarehouseAdapter
} from "./interfaces.js";
import { AgentArtifact, AgentContext, AgentResponse, QueryResult, ScheduleChannelType, TenantMemory } from "./types.js";
import { SqlGuard } from "./sqlGuard.js";

export const TENANT_MEMORY_MAX_CONTENT_CHARS = 300;
export const TENANT_MEMORY_MAX_PROMPT_ITEMS = 10;
export const TENANT_MEMORY_MAX_PROMPT_CHARS = 1800;

const metadataLookupSchema = z.object({
  kind: z.enum(["schemas", "tables", "columns"]),
  database: z.string().optional(),
  schema: z.string().optional(),
  table: z.string().optional(),
  search: z.string().optional()
});

const chartRequestSchema = z.object({
  type: z.enum(["bar", "line", "pie", "doughnut"]).optional(),
  title: z.string().optional(),
  xKey: z.string().optional(),
  yKey: z.string().optional(),
  seriesKey: z.string().optional(),
  horizontal: z.boolean().optional(),
  stacked: z.boolean().optional(),
  grouped: z.boolean().optional(),
  percentStacked: z.boolean().optional(),
  sort: z.enum(["none", "asc", "desc", "label_asc", "label_desc"]).optional(),
  smooth: z.boolean().optional(),
  tension: z.number().min(0).max(1).optional(),
  fill: z.boolean().optional(),
  step: z.boolean().optional(),
  pointRadius: z.number().min(0).max(20).optional(),
  donutCutout: z.number().int().min(0).max(95).optional(),
  showPercentLabels: z.boolean().optional(),
  topN: z.number().int().positive().max(200).optional(),
  otherLabel: z.string().optional(),
  stackId: z.string().optional(),
  maxPoints: z.number().int().positive().max(500).optional()
});

const tenantMemorySaveSchema = z.object({
  content: z.string().trim().min(1).max(TENANT_MEMORY_MAX_CONTENT_CHARS)
});

const warehouseExportCsvSchema = z.object({
  sql: z.string().trim().min(1),
  fileName: z.string().trim().min(1).max(120).optional()
});

const toolDecisionSchema = z.object({
  type: z.enum(["tool_call", "final_answer"]),
  tool: z
    .enum([
      "warehouse.query",
      "warehouse.exportCsv",
      "dbt.listModels",
      "dbt.getModelSql",
      "warehouse.lookupMetadata",
      "chartjs.build",
      "tenantMemory.save",
      "schedule.create"
    ])
    .optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  answer: z.string().optional(),
  reasoning: z.string().optional()
});

const scheduleCreateSchema = z.object({
  userRequest: z.string().trim().min(1),
  cron: z.string().trim().optional(),
  channelType: z.enum(["slack", "telegram", "console", "custom"]).optional(),
  channelRef: z.string().trim().optional(),
  active: z.boolean().optional()
});

function asJsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function normalizeMemoryContent(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function memoryDedupKey(value: string): string {
  return normalizeMemoryContent(value).toLowerCase();
}

function buildTenantMemoryPromptBlock(memories: TenantMemory[]): string | null {
  const selected: string[] = [];
  const seen = new Set<string>();
  let totalChars = 0;

  for (const memory of memories) {
    const normalized = normalizeMemoryContent(memory.content);
    if (!normalized) {
      continue;
    }
    const key = memoryDedupKey(normalized);
    if (seen.has(key)) {
      continue;
    }
    if (selected.length >= TENANT_MEMORY_MAX_PROMPT_ITEMS) {
      break;
    }
    const projectedChars = totalChars + normalized.length;
    if (selected.length > 0 && projectedChars > TENANT_MEMORY_MAX_PROMPT_CHARS) {
      break;
    }
    selected.push(normalized);
    seen.add(key);
    totalChars = projectedChars;
  }

  if (selected.length === 0) {
    return null;
  }

  return ["Tenant memory (user-saved facts, newest first):", ...selected.map((item) => `- ${item}`)].join("\n");
}

function buildTenantMemorySystemMessage(memories: TenantMemory[]): LlmMessage[] {
  const content = buildTenantMemoryPromptBlock(memories);
  return content ? [{ role: "system", content }] : [];
}

function userExplicitlyAskedToSaveMemory(userText: string): boolean {
  const patterns = [
    /\bremember\b/i,
    /\bmemorize\b/i,
    /\bdon'?t forget\b/i,
    /\bstore\b.+\b(for later|as memory|this|that|it)\b/i,
    /\bsave\b.+\b(for later|as memory|this|that|it)\b/i,
    /\bguarda(?:r|me|lo|la)?\b.*\b(memoria|memory|para (?:despu[eé]s|luego)|esto|eso)\b/i,
    /\bguardar\b.*\b(memoria|memory|para (?:despu[eé]s|luego)|esto|eso)\b/i,
    /\brecuerda\b.*\b(esto|eso|para (?:despu[eé]s|luego)|memoria|memory)\b/i,
    /\bmemoriza\b/i,
    /\bno te olvides\b/i
  ];
  return patterns.some((pattern) => pattern.test(userText));
}

function userExplicitlyRequestedSchedule(userText: string): boolean {
  const patterns = [
    /\b(schedule|scheduled|scheduling)\b/i,
    /\brecurr(?:ing|ence)\b/i,
    /\brepeat(?:ing)?\b/i,
    /\bremind(?:er)?\b/i,
    /\bdaily\b/i,
    /\bweekly\b/i,
    /\bmonthly\b/i,
    /\bcada\s+d[ií]a\b/i,
    /\bcada\s+semana\b/i,
    /\bcada\s+mes\b/i,
    /\brecordatorio\b/i,
    /\bprograma(?:r)?\b/i
  ];
  return patterns.some((pattern) => pattern.test(userText));
}

function defaultChannelTypeFromOrigin(origin: AgentContext["origin"]): ScheduleChannelType {
  if (!origin) {
    return "console";
  }
  if (origin.source === "slack") {
    return "slack";
  }
  if (origin.source === "telegram") {
    return "telegram";
  }
  return "console";
}

function defaultChannelRefFromOrigin(origin: AgentContext["origin"]): string | undefined {
  if (!origin) {
    return undefined;
  }
  if (origin.channelId?.trim()) {
    return origin.channelId.trim();
  }
  if (origin.userId?.trim()) {
    return origin.userId.trim();
  }
  return undefined;
}

const positiveTenantMemorySaveClaimPatterns = [
  /\bI saved\b/i,
  /\bI(?: have|'ve)\s+saved\b/i,
  /\bI(?:'ll| will) remember that\b/i,
  /\bHe guardado\b/i,
  /\bLo he guardado\b/i,
  /\bQued[oa]\s+guardad[oa]\b/i,
  /\bguardad[oa]\s+en\s+la\s+memoria\b/i,
  /\bguardad[oa]\s+en\s+memoria\b/i
];

function claimsTenantMemoryWasSaved(text: string): boolean {
  return positiveTenantMemorySaveClaimPatterns.some((pattern) => pattern.test(text));
}

function removeTenantMemorySaveClaimLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !claimsTenantMemoryWasSaved(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const scheduleSuccessClaimPatterns = [
  /\bscheduled\b/i,
  /\brecurring\b/i,
  /\breminder set\b/i,
  /\bprogramad[ao]\b/i,
  /\brecordatorio\b/i
];

function claimsScheduleWasCreated(text: string): boolean {
  return scheduleSuccessClaimPatterns.some((pattern) => pattern.test(text));
}

function ensureAccurateTenantMemorySaveText(text: string, memorySaveSucceededThisTurn: boolean): string {
  if (memorySaveSucceededThisTurn || !claimsTenantMemoryWasSaved(text)) {
    return text;
  }

  const stripped = removeTenantMemorySaveClaimLines(text);
  const note = "I could not confirm that the tenant memory was saved, so treat it as not persisted.";
  return stripped ? `${stripped}\n\n${note}` : note;
}

function quoteSqlIdent(value: string, provider?: TenantWarehouseProvider): string {
  if (provider === "bigquery") {
    return `\`${value.replace(/`/g, "\\`")}\``;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function likeFilter(column: string, search: string, provider?: TenantWarehouseProvider): string {
  if (provider === "bigquery") {
    return `LOWER(${column}) LIKE LOWER(${sqlLiteral(`%${search}%`)})`;
  }
  return `${column} ILIKE ${sqlLiteral(`%${search}%`)}`;
}

function buildMetadataLookupSql(
  lookup: z.infer<typeof metadataLookupSchema>,
  defaultDatabase: string,
  defaultSchema: string,
  maxRows: number,
  provider?: TenantWarehouseProvider
): string | null {
  if (provider === "bigquery") {
    return buildBigQueryMetadataLookupSql(lookup, defaultDatabase, defaultSchema, maxRows);
  }
  return buildSnowflakeMetadataLookupSql(lookup, defaultDatabase, defaultSchema, maxRows);
}

function buildSnowflakeMetadataLookupSql(
  lookup: z.infer<typeof metadataLookupSchema>,
  defaultDatabase: string,
  defaultSchema: string,
  maxRows: number
): string | null {
  const database = (lookup.database?.trim() || defaultDatabase).toUpperCase();
  const schema = (lookup.schema?.trim() || defaultSchema).toUpperCase();
  const table = (lookup.table?.trim() || "").toUpperCase();
  const search = lookup.search?.trim();
  if (!database) {
    return null;
  }

  const informationSchema = `${quoteSqlIdent(database)}.INFORMATION_SCHEMA`;
  if (lookup.kind === "schemas") {
    const where = search ? `WHERE SCHEMA_NAME ILIKE ${sqlLiteral(`%${search}%`)}` : "";
    return `SELECT SCHEMA_NAME FROM ${informationSchema}.SCHEMATA ${where} ORDER BY SCHEMA_NAME LIMIT ${maxRows}`;
  }
  if (lookup.kind === "tables") {
    const where: string[] = [];
    if (schema) {
      where.push(`TABLE_SCHEMA = ${sqlLiteral(schema)}`);
    }
    if (search) {
      where.push(`TABLE_NAME ILIKE ${sqlLiteral(`%${search}%`)}`);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return `SELECT TABLE_SCHEMA, TABLE_NAME FROM ${informationSchema}.TABLES ${whereClause} ORDER BY TABLE_SCHEMA, TABLE_NAME LIMIT ${maxRows}`;
  }

  const where: string[] = [];
  if (schema) {
    where.push(`TABLE_SCHEMA = ${sqlLiteral(schema)}`);
  }
  if (table) {
    where.push(`TABLE_NAME = ${sqlLiteral(table)}`);
  }
  if (search) {
    where.push(`COLUMN_NAME ILIKE ${sqlLiteral(`%${search}%`)}`);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  return `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM ${informationSchema}.COLUMNS ${whereClause} ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION LIMIT ${maxRows}`;
}

function buildBigQueryMetadataLookupSql(
  lookup: z.infer<typeof metadataLookupSchema>,
  defaultProject: string,
  defaultDataset: string,
  maxRows: number
): string | null {
  const project = lookup.database?.trim() || defaultProject;
  const dataset = lookup.schema?.trim() || defaultDataset;
  const table = lookup.table?.trim() || "";
  const search = lookup.search?.trim();
  if (!project) {
    return null;
  }

  if (lookup.kind === "schemas") {
    const where = search ? `WHERE ${likeFilter("schema_name", search, "bigquery")}` : "";
    return `SELECT schema_name FROM \`${project}\`.INFORMATION_SCHEMA.SCHEMATA ${where} ORDER BY schema_name LIMIT ${maxRows}`;
  }
  if (lookup.kind === "tables") {
    if (!dataset) {
      return null;
    }
    const where: string[] = [];
    if (search) {
      where.push(likeFilter("table_name", search, "bigquery"));
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return `SELECT table_name, table_type FROM \`${project}.${dataset}\`.INFORMATION_SCHEMA.TABLES ${whereClause} ORDER BY table_name LIMIT ${maxRows}`;
  }

  if (!dataset || !table) {
    return null;
  }
  const where: string[] = [`table_name = ${sqlLiteral(table)}`];
  if (search) {
    where.push(likeFilter("column_name", search, "bigquery"));
  }
  const whereClause = `WHERE ${where.join(" AND ")}`;
  return `SELECT table_name, column_name, data_type FROM \`${project}.${dataset}\`.INFORMATION_SCHEMA.COLUMNS ${whereClause} ORDER BY ordinal_position LIMIT ${maxRows}`;
}

function inferSchemaHintFromModelPath(relativePath: string, fallbackSchema: string): string {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/marts/")) {
    return "MARTS";
  }
  if (normalized.includes("/intermediate/") || normalized.includes("/int/")) {
    return "INT";
  }
  if (normalized.includes("/staging/") || normalized.includes("/stg/")) {
    return "STAGING";
  }
  if (normalized.includes("/core/")) {
    return "CORE";
  }
  return fallbackSchema || "PUBLIC";
}

export type WarehouseResolver = WarehouseAdapter | ((tenantId: string) => WarehouseAdapter);

export interface RuntimeRespondOptions {
  promptText?: string;
}

export class AnalyticsAgentRuntime {
  constructor(
    private readonly llm: LlmProvider,
    private readonly warehouse: WarehouseResolver,
    private readonly chartTool: ChartTool,
    private readonly dbtRepo: DbtRepositoryService,
    private readonly store: ConversationStore,
    private readonly sqlGuard: SqlGuard
  ) {}

  private resolveWarehouse(tenantId: string): WarehouseAdapter {
    return typeof this.warehouse === "function" ? this.warehouse(tenantId) : this.warehouse;
  }

  async respond(context: AgentContext, userText: string, options: RuntimeRespondOptions = {}): Promise<AgentResponse> {
    const startedAt = Date.now();
    const persistedUserText = userText;
    const effectivePromptText = options.promptText?.trim() ? options.promptText : persistedUserText;
    const timings: Record<string, number> = {};
    const maxToolSteps = 35;
    const plannerAttempts: Array<{ step: number; raw?: string; parseError?: string; plan?: Record<string, unknown> }> = [];
    const attemptedSql = new Set<string>();
    const toolCalls: Array<{
      tool: string;
      input: Record<string, unknown>;
      status: "ok" | "error";
      durationMs: number;
      outputSummary?: Record<string, unknown>;
      output?: unknown;
      error?: string;
    }> = [];
    const measure = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const stepStart = Date.now();
      const result = await fn();
      timings[label] = Date.now() - stepStart;
      return result;
    };
    const runTool = async <T>(
      tool: string,
      input: Record<string, unknown>,
      fn: () => Promise<T>,
      summarize?: (value: T) => Record<string, unknown>,
      fullOutput?: (value: T) => unknown
    ): Promise<T> => {
      const start = Date.now();
      try {
        const value = await fn();
        toolCalls.push({
          tool,
          input,
          status: "ok",
          durationMs: Date.now() - start,
          outputSummary: summarize ? summarize(value) : undefined,
          output: fullOutput ? fullOutput(value) : undefined
        });
        return value;
      } catch (error) {
        toolCalls.push({
          tool,
          input,
          status: "error",
          durationMs: Date.now() - start,
          error: (error as Error).message
        });
        throw error;
      }
    };

    this.store.createConversation(context);
    if (context.origin) {
      this.store.upsertConversationOrigin(context.conversationId, context.tenantId, context.origin);
    }
    this.store.addMessage({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      role: "user",
      content: persistedUserText
    });
    const executionTurn = this.store.createExecutionTurn({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      source: context.origin?.source ?? "cli",
      rawUserText: persistedUserText,
      promptText: effectivePromptText,
      status: "running"
    });

    const llmCallSnapshots: Array<{
      callIndex: number;
      model: string;
      usage?: LlmUsage;
      generationId?: string;
    }> = [];
    let llmCallSeq = 0;
    let llmUsagePersisted = false;

    const persistLlmUsageToStore = (): void => {
      if (llmUsagePersisted) {
        return;
      }
      llmUsagePersisted = true;
      for (const snap of llmCallSnapshots) {
        this.store.insertLlmUsageEvent({
          tenantId: context.tenantId,
          executionTurnId: executionTurn.id,
          conversationId: context.conversationId,
          model: snap.model,
          generationId: snap.generationId ?? null,
          promptTokens: snap.usage?.promptTokens ?? 0,
          completionTokens: snap.usage?.completionTokens ?? 0,
          totalTokens: snap.usage?.totalTokens ?? 0,
          cost: snap.usage?.cost ?? null,
          callIndex: snap.callIndex
        });
      }
    };

    const buildLlmUsageDebug = (): Record<string, unknown> => {
      const totals = llmCallSnapshots.reduce(
        (acc, c) => ({
          promptTokens: acc.promptTokens + (c.usage?.promptTokens ?? 0),
          completionTokens: acc.completionTokens + (c.usage?.completionTokens ?? 0),
          totalTokens: acc.totalTokens + (c.usage?.totalTokens ?? 0),
          totalCost: acc.totalCost + (c.usage?.cost ?? 0)
        }),
        { promptTokens: 0, completionTokens: 0, totalTokens: 0, totalCost: 0 }
      );
      return {
        totals,
        calls: llmCallSnapshots.map((c) => ({
          callIndex: c.callIndex,
          model: c.model,
          promptTokens: c.usage?.promptTokens ?? 0,
          completionTokens: c.usage?.completionTokens ?? 0,
          totalTokens: c.usage?.totalTokens ?? 0,
          cost: c.usage?.cost,
          generationId: c.generationId
        }))
      };
    };

    try {
      const profile = this.store.getOrCreateProfile(context.tenantId, context.profileName);
      timings.profileMs = Date.now() - startedAt;
      const history = this.store.getMessages(context.conversationId, 12);
      let tenantMemories = this.store.listTenantMemories(context.tenantId, 500);
      const tenantRepo = this.store.getTenantRepo(context.tenantId);
      const tenantWhConfig = this.store.getTenantWarehouseConfig(context.tenantId);
      const warehouse = this.resolveWarehouse(context.tenantId);
      const whProvider: TenantWarehouseProvider = warehouse.provider ?? tenantWhConfig?.provider ?? "snowflake";
      const isBigQuery = whProvider === "bigquery";

      const whDatabase = isBigQuery
        ? (tenantWhConfig?.bigquery?.projectId?.trim() ?? process.env.BIGQUERY_PROJECT_ID?.trim() ?? "")
        : (tenantWhConfig?.snowflake?.database?.trim() ?? process.env.SNOWFLAKE_DATABASE?.trim() ?? "");
      const whSchema = isBigQuery
        ? (tenantWhConfig?.bigquery?.dataset?.trim() ?? process.env.BIGQUERY_DATASET?.trim() ?? "")
        : (tenantWhConfig?.snowflake?.schema?.trim() ?? process.env.SNOWFLAKE_SCHEMA?.trim() ?? "");

      const tenantLlmOverride = this.store.getTenantLlmSettings(context.tenantId)?.llmModel?.trim();
      const llmModel =
        (tenantLlmOverride && tenantLlmOverride.length > 0 ? tenantLlmOverride : "") ||
        context.llmModel?.trim() ||
        env.llmModel ||
        "openai/gpt-4o-mini";

      const runLlm = async (input: { messages: LlmMessage[]; temperature: number }): Promise<string> => {
        const callIndex = llmCallSeq++;
        const result = await this.llm.generateText({
          model: llmModel,
          messages: input.messages,
          temperature: input.temperature
        });
        llmCallSnapshots.push({
          callIndex,
          model: llmModel,
          usage: result.usage,
          generationId: result.generationId
        });
        return result.text;
      };

      const now = new Date();
      const currentDateIso = now.toISOString();
      const currentDate = currentDateIso.slice(0, 10);
      const userAskedToSaveMemory = userExplicitlyAskedToSaveMemory(persistedUserText);
      const userRequestedSchedule = userExplicitlyRequestedSchedule(persistedUserText);
      const hasWarehouseDefaults = whDatabase.length > 0 && whSchema.length > 0;
      const fqPrefix = hasWarehouseDefaults
        ? isBigQuery
          ? `\`${whDatabase}.${whSchema}\``
          : `${quoteSqlIdent(whDatabase)}.${quoteSqlIdent(whSchema)}`
        : "";
      const dbtModels = await measure("dbtModelsMs", async () => {
        try {
          return await runTool(
            "dbt.listModels",
            { tenantId: context.tenantId },
            async () => this.dbtRepo.listModels(context.tenantId),
            (models) => ({ modelCount: models.length })
          );
        } catch {
          return [];
        }
      });
      const schemaCandidates = isBigQuery
        ? [whSchema].filter((v) => v.length > 0)
        : Array.from(
            new Set(
              [whSchema.toUpperCase(), "INT", "MARTS", "STAGING", "CORE", "PUBLIC"].filter(
                (value) => value.length > 0
              )
            )
          );

      const historyMessages: LlmMessage[] = history
        .filter((m) => m.role !== "tool" && m.role !== "system")
        .map((m): LlmMessage => ({
          role: m.role === "user" ? "user" : "assistant",
          content: m.content
        }));

      const sqlGuidanceLines = isBigQuery
        ? [
            "SQL generation requirements (strict):",
            "- The warehouse is Google BigQuery. Write Standard SQL (not Legacy SQL).",
            "- Use fully-qualified BigQuery object names: `project.dataset.table`.",
            "- Never use unqualified table names like `fct_transactions`.",
            hasWarehouseDefaults
              ? `- Start with ${fqPrefix} as a default guess, but verify with warehouse.lookupMetadata if unsure.`
              : "- BigQuery project/dataset defaults are unavailable, so infer carefully and avoid guessing.",
            `- Known dataset candidates: ${schemaCandidates.join(", ") || "(none)"}.`,
            "- Use dbt model path hints and inspected dbt SQL to choose dataset.",
            "- If table/dataset/column names are uncertain, use warehouse.lookupMetadata.",
            "- If dbt lineage is uncertain, use dbt.getModelSql.",
            "- If visualization is requested, call chartjs.build after at least one successful query.",
            "- When a chart artifact is generated with chartjs.build, do NOT draw an ASCII/Markdown/text chart in the answer.",
            "- With chart artifacts, keep the narrative concise: key takeaway(s), notable outliers, and caveats only.",
            "- For chart queries with time on x-axis, ALWAYS return a normalized time label column:",
            "  - monthly: FORMAT_TIMESTAMP('%Y-%m', TIMESTAMP_TRUNC(<timestamp_col>, MONTH)) AS period_label",
            "  - daily: FORMAT_TIMESTAMP('%Y-%m-%d', TIMESTAMP_TRUNC(<timestamp_col>, DAY)) AS period_label",
            "- Always ORDER BY the same normalized period label ascending.",
            "- Prefer using the normalized label column as xKey for chartjs.build.",
            "- Do not repeat the exact same failing SQL."
          ]
        : [
            "SQL generation requirements (strict):",
            "- The warehouse is Snowflake. Write Snowflake SQL.",
            "- Use fully-qualified Snowflake object names in every query: DATABASE.SCHEMA.OBJECT.",
            "- Never use unqualified table names like `fct_transactions`.",
            hasWarehouseDefaults
              ? `- Start with ${fqPrefix} as a default guess, but do not treat schema as fixed.`
              : "- SNOWFLAKE_DATABASE/SCHEMA defaults are unavailable, so infer carefully and avoid guessing.",
            `- Allowed/expected schema candidates to consider: ${schemaCandidates.join(", ")}.`,
            "- Use dbt model path hints and inspected dbt SQL to choose schema.",
            "- If table/schema/column names are uncertain, use warehouse.lookupMetadata.",
            "- If dbt lineage is uncertain, use dbt.getModelSql.",
            "- If visualization is requested, call chartjs.build after at least one successful query.",
            "- When a chart artifact is generated with chartjs.build, do NOT draw an ASCII/Markdown/text chart in the answer.",
            "- With chart artifacts, keep the narrative concise: key takeaway(s), notable outliers, and caveats only.",
            "- For chart queries with time on x-axis, ALWAYS return a normalized time label column:",
            "  - monthly: TO_CHAR(DATE_TRUNC('month', <timestamp_col>), 'YYYY-MM') AS period_label",
            "  - daily: TO_CHAR(DATE_TRUNC('day', <timestamp_col>), 'YYYY-MM-DD') AS period_label",
            "- Always ORDER BY the same normalized period label (or underlying truncated date) ascending.",
            "- Prefer using the normalized label column as xKey for chartjs.build.",
            "- Do not repeat the exact same failing SQL."
          ];

      const dbLabel = isBigQuery ? "project" : "database";
      const schemaLabel = isBigQuery ? "dataset" : "schema";
      const exampleRelation = hasWarehouseDefaults
        ? isBigQuery
          ? `- example fully-qualified relation: \`${whDatabase}.${whSchema}.fct_transactions\``
          : `- example fully-qualified relation: ${fqPrefix}.${quoteSqlIdent("fct_transactions")}`
        : "- fully-qualified relation prefix could not be derived from env.";

      const baseMessages = (): LlmMessage[] => [
      {
        role: "system",
        content: [
          "Identity and scope (highest priority):",
          "- You are Agent Blue.",
          "- Your owner is Blueprintdata (https://blueprintdata.xyz/).",
          "- Tenant context may change per request, but your identity and owner never change.",
          "- You ONLY answer analytical questions related to data, metrics, SQL, BI, dbt models, and business performance analysis.",
          "- For any non-analytical or unrelated request, do not call tools and return final_answer refusing the request.",
          '- Refusal text for non-analytical requests: "I can only help with analytical questions about data and business metrics."',
          "",
          profile.soulPrompt,
          "",
          "You are an analytics assistant with tools. Use tools iteratively and then provide a final answer.",
          `Current date/time (UTC): ${currentDateIso}`,
          `Current date (UTC): ${currentDate}`,
          "",
          ...sqlGuidanceLines,
          "",
          "Tenant memory rules:",
          "- Tenant memories are shared across this tenant and may be injected into future prompts.",
          "- If the user explicitly asks in any language to remember/save/store a durable fact or preference, prefer tenantMemory.save before final_answer.",
          "- Use tenantMemory.save only when the user explicitly asks you to remember/save/store a durable fact or preference for later.",
          "- Save one concise durable fact or preference, not a transcript or large passage.",
          "- Never save secrets, credentials, access tokens, or long blobs.",
          "- If the user did not explicitly ask, do not call tenantMemory.save.",
          "- Never claim that memory was saved unless you already received a successful Tool result (tenantMemory.save) in this turn.",
          "- If tenantMemory.save fails or is rejected, explicitly say that the save did not happen.",
          "",
          "Schedule rules:",
          "- Only call schedule.create when the user explicitly asks for a recurring/scheduled/reminder-style action (any language).",
          "- Default cron to 0 9 * * * (UTC) when the user says 'daily' without a time.",
          "- Default channelType from origin (slack/telegram/console) and channelRef from the origin channel/user when not provided.",
          "- Never claim a schedule was created unless you already received a successful Tool result (schedule.create) in this turn.",
          "- If schedule.create fails or is rejected, explicitly say that scheduling did not happen.",
          "",
          "CSV export rules:",
          "- Use warehouse.exportCsv when the user explicitly asks for CSV/export/download/file output, or when a table would be too large for chat.",
          "- warehouse.exportCsv writes the result out of band and returns only compact metadata to you; do not expect rows in the tool result.",
          "- Prefer warehouse.query for normal analytical reasoning over small result sets.",
          "",
          "Available tools and args:",
          "- warehouse.query: { sql: string }",
          '- warehouse.exportCsv: { sql: string, fileName?: string }',
          "- dbt.listModels: {}",
          "- dbt.getModelSql: { modelName: string }",
          `- warehouse.lookupMetadata: { kind: "schemas"|"tables"|"columns", ${dbLabel}?: string, ${schemaLabel}?: string, table?: string, search?: string }`,
          "- tenantMemory.save: { content: string }",
          '- chartjs.build: { type?: "bar"|"line"|"pie"|"doughnut", title?: string, xKey?: string, yKey?: string, seriesKey?: string, horizontal?: boolean, stacked?: boolean, grouped?: boolean, percentStacked?: boolean, sort?: "none"|"asc"|"desc"|"label_asc"|"label_desc", smooth?: boolean, tension?: number, fill?: boolean, step?: boolean, pointRadius?: number, donutCutout?: number, showPercentLabels?: boolean, topN?: number, otherLabel?: string, stackId?: string, maxPoints?: number }',
          '- schedule.create: { userRequest: string, cron: string, channelType?: "slack"|"telegram"|"console"|"custom", channelRef?: string, active?: boolean }',
          "",
          "Return ONLY valid JSON in one of these shapes:",
          '{ "type": "tool_call", "tool": "warehouse.query|warehouse.exportCsv|dbt.listModels|dbt.getModelSql|warehouse.lookupMetadata|tenantMemory.save|chartjs.build|schedule.create", "args": { ... }, "reasoning"?: string }',
          '{ "type": "final_answer", "answer": string, "reasoning"?: string }',
          "- If the user request is not analytical, ALWAYS return final_answer with the refusal text and do not call tools.",
          "",
          `Max query rows per profile: ${profile.maxRowsPerQuery}.`
        ].join("\n")
      },
      {
        role: "system",
        content: [
          "Warehouse context:",
          `- provider: ${whProvider}`,
          `- current_date_utc: ${currentDate}`,
          `- current_datetime_utc: ${currentDateIso}`,
          `- tenantId: ${context.tenantId}`,
          `- ${dbLabel}: ${whDatabase || "(not set)"}`,
          `- ${schemaLabel}: ${whSchema || "(not set)"}`,
          isBigQuery ? "" : `- schema_candidates: ${schemaCandidates.join(", ")}`,
          `- dbt subpath: ${tenantRepo?.dbtSubpath ?? "(unknown)"}`,
          exampleRelation
        ].filter(Boolean).join("\n")
      },
      ...buildTenantMemorySystemMessage(tenantMemories),
      {
        role: "system",
        content: `dbt models currently available (name -> path, suggested relation):\n${dbtModels
          .slice(0, 300)
          .map((m) => {
            if (!hasWarehouseDefaults) {
              return `${m.name} -> ${m.relativePath}`;
            }
            if (isBigQuery) {
              return `${m.name} -> ${m.relativePath} -> \`${whDatabase}.${whSchema}.${m.name}\``;
            }
            const hintedSchema = inferSchemaHintFromModelPath(m.relativePath, whSchema.toUpperCase());
            return `${m.name} -> ${m.relativePath} -> "${whDatabase}"."${hintedSchema}".${quoteSqlIdent(m.name)}`;
          })
          .join("\n")}`
      },
      ...historyMessages,
      {
        role: "user",
        content: effectivePromptText
      }
      ];

      const finalizeSuccess = (
        text: string,
        debug: Record<string, unknown>,
        artifacts?: AgentArtifact[]
      ): AgentResponse => {
        persistLlmUsageToStore();
        const mergedDebug = { ...debug, llmUsage: buildLlmUsageDebug() };
        this.store.addMessage({
          tenantId: context.tenantId,
          conversationId: context.conversationId,
          role: "assistant",
          content: text
        });
        this.store.completeExecutionTurn({
          turnId: executionTurn.id,
          status: "completed",
          assistantText: text,
          debug: mergedDebug
        });
        return {
          text,
          artifacts,
          debug: mergedDebug
        };
      };

      const loopMessages: LlmMessage[] = [];
      let finalPlan: z.infer<typeof toolDecisionSchema> | undefined;
      let finalSql: string | undefined;
      let lastSuccessfulQuery: { sql: string; result: QueryResult } | undefined;
      const responseArtifacts: AgentArtifact[] = [];
      let memorySaveAttemptedThisTurn = false;
      let memorySaveSucceededThisTurn = false;
      let scheduleCreateSucceededThisTurn = false;

      for (let step = 1; step <= maxToolSteps; step += 1) {
      const planRaw = await measure(`plannerMs_step${step}`, async () =>
        runLlm({
          messages: [...baseMessages(), ...loopMessages],
          temperature: 0
        })
      );

      let plan: z.infer<typeof toolDecisionSchema>;
      try {
        plan = toolDecisionSchema.parse(JSON.parse(planRaw));
        plannerAttempts.push({ step, raw: planRaw, plan: plan as Record<string, unknown> });
      } catch (error) {
        plannerAttempts.push({ step, raw: planRaw, parseError: (error as Error).message });
        loopMessages.push({
          role: "user",
          content: `Invalid JSON response. Error: ${(error as Error).message}. Return valid JSON only.`
        });
        continue;
      }
      finalPlan = plan;
      loopMessages.push({ role: "assistant", content: planRaw });

      if (plan.type === "final_answer") {
        const candidateText = plan.answer?.trim() ? plan.answer : "I need more details to answer that.";
        if (claimsTenantMemoryWasSaved(candidateText) && !memorySaveSucceededThisTurn && step < maxToolSteps) {
          loopMessages.push({
            role: "user",
            content: userAskedToSaveMemory
              ? "You claimed that tenant memory was saved, but there is no successful Tool result (tenantMemory.save) in this turn. Before claiming success, call tenantMemory.save and wait for its tool result. If you cannot save it, return final_answer explicitly saying the save did not happen."
            : "You claimed that tenant memory was saved, but there is no successful Tool result (tenantMemory.save) in this turn. Do not claim success. Return a corrected final_answer, or only use tenantMemory.save if the user explicitly asked for memory persistence."
          });
          continue;
        }
        if (claimsScheduleWasCreated(candidateText) && !scheduleCreateSucceededThisTurn && step < maxToolSteps) {
          loopMessages.push({
            role: "user",
            content:
              "You claimed that a schedule/reminder was created, but there is no successful Tool result (schedule.create) in this turn. Call schedule.create and wait for its tool result, or explicitly state that scheduling did not happen."
          });
          continue;
        }
        const text = ensureAccurateTenantMemorySaveText(candidateText, memorySaveSucceededThisTurn);
        return finalizeSuccess(
          text,
          {
            plan,
            plannerAttempts,
            sql: finalSql,
            toolCalls,
            mode: "direct_tool_loop",
            timings: { ...timings, totalMs: Date.now() - startedAt }
          },
          responseArtifacts.length > 0 ? responseArtifacts : undefined
        );
      }

      if (plan.type !== "tool_call" || !plan.tool) {
        loopMessages.push({
          role: "user",
          content: "Return either a valid tool_call or final_answer JSON."
        });
        continue;
      }

      const args = (plan.args ?? {}) as Record<string, unknown>;
      try {
        if (plan.tool === "dbt.listModels") {
          const models = await runTool(
            "dbt.listModels",
            { tenantId: context.tenantId },
            async () => this.dbtRepo.listModels(context.tenantId),
            (value) => ({ modelCount: value.length }),
            (value) => ({
              modelCount: value.length,
              models: value.slice(0, 100).map((m) => ({ name: m.name, relativePath: m.relativePath }))
            })
          );
          loopMessages.push({
            role: "user",
            content: `Tool result (dbt.listModels): ${asJsonBlock({
              modelCount: models.length,
              models: models.slice(0, 100).map((m) => ({ name: m.name, relativePath: m.relativePath }))
            })}`
          });
          continue;
        }

        if (plan.tool === "dbt.getModelSql") {
          const modelName = typeof args.modelName === "string" ? args.modelName.trim() : "";
          if (!modelName) {
            throw new Error("dbt.getModelSql requires args.modelName.");
          }
          const modelSql = await measure("getModelSqlMs", async () =>
            runTool(
              "dbt.getModelSql",
              { tenantId: context.tenantId, modelName },
              async () => this.dbtRepo.getModelSql(context.tenantId, modelName),
              (sqlText) => ({ found: Boolean(sqlText), modelName }),
              (sqlText) => ({ modelName, sql: sqlText })
            )
          );
          if (!modelSql) {
            throw new Error(`Model "${modelName}" was not found in configured dbt repo.`);
          }
          loopMessages.push({
            role: "user",
            content: `Tool result (dbt.getModelSql): ${asJsonBlock({ modelName, sql: modelSql })}`
          });
          continue;
        }

        if (plan.tool === "warehouse.lookupMetadata") {
          const parsedLookup = metadataLookupSchema.safeParse(args);
          if (!parsedLookup.success) {
            throw new Error("warehouse.lookupMetadata requires valid lookup args.");
          }
          const metadataSql = buildMetadataLookupSql(
            parsedLookup.data,
            whDatabase,
            whSchema,
            profile.maxRowsPerQuery,
            whProvider
          );
          if (!metadataSql) {
            throw new Error(`Metadata lookup requires ${isBigQuery ? "project" : "database"} context.`);
          }
          const metadataResult = await runTool(
            "warehouse.lookupMetadata",
            { ...parsedLookup.data, sql: metadataSql },
            async () => warehouse.query(metadataSql),
            (result) => ({ rowCount: result.rowCount, columns: result.columns }),
            (result) => ({
              columns: result.columns,
              rowCount: result.rowCount,
              rows: result.rows.slice(0, profile.maxRowsPerQuery)
            })
          );
          loopMessages.push({
            role: "user",
            content: `Tool result (warehouse.lookupMetadata): ${asJsonBlock({
              columns: metadataResult.columns,
              rowCount: metadataResult.rowCount,
              rows: metadataResult.rows.slice(0, profile.maxRowsPerQuery)
            })}`
          });
          continue;
        }

        if (plan.tool === "tenantMemory.save") {
          memorySaveAttemptedThisTurn = true;
          const parsedMemory = tenantMemorySaveSchema.safeParse(args);
          if (!parsedMemory.success) {
            throw new Error("tenantMemory.save requires args.content as a short string.");
          }
          if (!userAskedToSaveMemory) {
            throw new Error("tenantMemory.save can only be used when the user explicitly asks to remember or save something.");
          }
          const normalizedContent = normalizeMemoryContent(parsedMemory.data.content);
          const existingMemory = this.store
            .listTenantMemories(context.tenantId, 500)
            .find((memory) => memoryDedupKey(memory.content) === memoryDedupKey(normalizedContent));
          const savedMemory = existingMemory
            ? await runTool(
                "tenantMemory.save",
                { content: normalizedContent, deduped: true },
                async () => existingMemory,
                (memory) => ({ saved: false, deduped: true, memoryId: memory.id }),
                (memory) => ({ saved: false, deduped: true, memoryId: memory.id, content: memory.content })
              )
            : await runTool(
                "tenantMemory.save",
                { content: normalizedContent },
                async () =>
                  this.store.createTenantMemory({
                    tenantId: context.tenantId,
                    content: normalizedContent,
                    source: "agent"
                  }),
                (memory) => ({ saved: true, deduped: false, memoryId: memory.id }),
                (memory) => ({ saved: true, deduped: false, memoryId: memory.id, content: memory.content })
              );
          memorySaveSucceededThisTurn = true;
          tenantMemories = this.store.listTenantMemories(context.tenantId, 500);
          loopMessages.push({
            role: "user",
            content: `Tool result (tenantMemory.save): ${asJsonBlock({
              saved: !existingMemory,
              deduped: Boolean(existingMemory),
              memoryId: savedMemory.id,
              content: savedMemory.content
            })}`
          });
          continue;
        }

        if (plan.tool === "schedule.create") {
          const parsedSchedule = scheduleCreateSchema.safeParse(args);
          if (!parsedSchedule.success) {
            throw new Error("schedule.create requires userRequest, cron, and valid channel fields.");
          }
          if (!userRequestedSchedule) {
            throw new Error(
              "schedule.create can only be used when the user explicitly requests a recurring schedule or reminder."
            );
          }
          const requestedCron = parsedSchedule.data.cron?.trim();
          const cron = requestedCron || (/\bdaily\b/i.test(persistedUserText) ? "0 9 * * *" : "");
          if (!cron) {
            throw new Error("cron is required. Use 0 9 * * * for a daily schedule if no time was given.");
          }
          try {
            // eslint-disable-next-line no-new
            new CronTime(cron);
          } catch (error) {
            throw new Error(`Invalid cron expression: ${(error as Error).message}`);
          }
          const channelType = parsedSchedule.data.channelType ?? defaultChannelTypeFromOrigin(context.origin);
          const channelRef = parsedSchedule.data.channelRef ?? defaultChannelRefFromOrigin(context.origin);
          if ((channelType === "slack" || channelType === "telegram") && !channelRef) {
            throw new Error("channelRef is required for slack or telegram delivery.");
          }
          const schedule = await runTool(
            "schedule.create",
            {
              userRequest: parsedSchedule.data.userRequest,
              cron,
              channelType,
              channelRef,
              active: parsedSchedule.data.active ?? true
            },
            async () =>
              this.store.createTenantSchedule({
                tenantId: context.tenantId,
                userRequest: parsedSchedule.data.userRequest || persistedUserText,
                cron,
                channelType,
                channelRef,
                active: parsedSchedule.data.active ?? true
              }),
            (value) => ({ scheduleId: value.id, active: value.active, channelType: value.channelType })
          );
          scheduleCreateSucceededThisTurn = true;
          loopMessages.push({
            role: "user",
            content: `Tool result (schedule.create): ${asJsonBlock({
              id: schedule.id,
              cron: schedule.cron,
              channelType: schedule.channelType,
              channelRef: schedule.channelRef,
              active: schedule.active
            })}`
          });
          continue;
        }

        if (plan.tool === "chartjs.build") {
          const parsedRequest = chartRequestSchema.safeParse(args);
          if (!parsedRequest.success) {
            throw new Error("chartjs.build requires valid chart args.");
          }
          if (!lastSuccessfulQuery) {
            throw new Error("No successful query result available yet. Run warehouse.query first.");
          }
          const successfulQuery = lastSuccessfulQuery;
          const chartBuild = await runTool(
            "chartjs.build",
            { chartRequest: parsedRequest.data as ChartBuildRequest, sourceSql: successfulQuery.sql },
            async () =>
              this.chartTool.buildFromQueryResult({
                request: parsedRequest.data as ChartBuildRequest,
                result: successfulQuery.result,
                maxPoints: profile.maxRowsPerQuery
              }),
            (result) => result.summary,
            (result) => ({ config: result.config, summary: result.summary })
          );
          responseArtifacts.push({
            type: "chartjs_config",
            format: "json",
            payload: chartBuild.config,
            summary: chartBuild.summary
          });
          loopMessages.push({
            role: "user",
            content: `Tool result (chartjs.build): ${asJsonBlock(chartBuild.summary)}`
          });
          continue;
        }

        if (plan.tool === "warehouse.exportCsv") {
          const parsedExport = warehouseExportCsvSchema.safeParse(args);
          if (!parsedExport.success) {
            throw new Error("warehouse.exportCsv requires args.sql and an optional args.fileName.");
          }
          const normalizedSql = this.sqlGuard.normalizeForExport(parsedExport.data.sql);
          if (attemptedSql.has(normalizedSql)) {
            throw new Error("Duplicate SQL attempt in this turn. Generate a different query.");
          }
          attemptedSql.add(normalizedSql);
          finalSql = normalizedSql;
          const exported = await measure("warehouseExportMs", async () =>
            runTool(
              "warehouse.exportCsv",
              { sql: normalizedSql, fileName: parsedExport.data.fileName },
              async () => warehouse.exportCsv(normalizedSql, { fileName: parsedExport.data.fileName }),
              (result) => ({
                fileName: result.fileName,
                rowCount: result.rowCount,
                columns: result.columns,
                bytes: result.bytes,
                mimeType: result.mimeType
              })
            )
          );
          responseArtifacts.push({
            type: "file",
            format: "csv",
            payload: exported,
            summary: {
              fileName: exported.fileName,
              rowCount: exported.rowCount,
              columns: exported.columns,
              bytes: exported.bytes
            }
          });
          loopMessages.push({
            role: "user",
            content: `Tool result (warehouse.exportCsv): ${asJsonBlock({
              sql: normalizedSql,
              fileName: exported.fileName,
              rowCount: exported.rowCount,
              columns: exported.columns,
              bytes: exported.bytes,
              mimeType: exported.mimeType
            })}`
          });
          continue;
        }

        if (plan.tool === "warehouse.query") {
          const sql = typeof args.sql === "string" ? args.sql.trim() : "";
          if (!sql) {
            throw new Error("warehouse.query requires args.sql.");
          }
          const normalizedSql = this.sqlGuard
            .normalize(sql)
            .replace(/\blimit\s+\d+\b/i, `LIMIT ${profile.maxRowsPerQuery}`);
          if (attemptedSql.has(normalizedSql)) {
            throw new Error("Duplicate SQL attempt in this turn. Generate a different query.");
          }
          attemptedSql.add(normalizedSql);
          finalSql = normalizedSql;
          const queryResult = await measure("warehouseMs", async () =>
            runTool(
              "warehouse.query",
              { sql: normalizedSql },
              async () => warehouse.query(normalizedSql),
              (result) => ({ rowCount: result.rowCount, columns: result.columns }),
              (result) => ({
                columns: result.columns,
                rowCount: result.rowCount,
                rows: result.rows.slice(0, profile.maxRowsPerQuery)
              })
            )
          );
          lastSuccessfulQuery = { sql: normalizedSql, result: queryResult };
          loopMessages.push({
            role: "user",
            content: `Tool result (warehouse.query): ${asJsonBlock({
              sql: normalizedSql,
              columns: queryResult.columns,
              rowCount: queryResult.rowCount,
              rows: queryResult.rows.slice(0, profile.maxRowsPerQuery)
            })}`
          });
          continue;
        }

        throw new Error(`Unsupported tool: ${plan.tool}`);
      } catch (error) {
        loopMessages.push({
          role: "user",
          content: plan.tool === "tenantMemory.save"
            ? `Tool error (tenantMemory.save): ${(error as Error).message}. Do NOT claim that memory was saved. Either issue a corrected tenantMemory.save call or return final_answer explicitly saying the save did not happen.`
            : `Tool error (${plan.tool}): ${(error as Error).message}. Choose a corrected tool call or final_answer.`
        });
      }
      }

      if (lastSuccessfulQuery) {
        let text = "";
        try {
          text = await runLlm({
            temperature: 0.1,
            messages: [
              {
                role: "system",
                content: [
                  "Identity and scope (highest priority):",
                  "- You are Agent Blue.",
                  "- Your owner is Blueprintdata (https://blueprintdata.xyz/).",
                  "- Tenant context may change per request, but your identity and owner never change.",
                  "- You ONLY answer analytical questions related to data, metrics, SQL, BI, dbt models, and business performance analysis.",
                  '- If the request is non-analytical, answer exactly: "I can only help with analytical questions about data and business metrics."',
                  "",
                  profile.soulPrompt,
                  "",
                  "Answer using business language and include caveats when sample size or nulls matter."
                ].join("\n")
              },
              ...buildTenantMemorySystemMessage(tenantMemories),
              {
                role: "user",
                content: [
                  `User question: ${persistedUserText}`,
                  `Executed SQL:\n${lastSuccessfulQuery.sql}`,
                  "Result JSON:",
                  asJsonBlock({
                    columns: lastSuccessfulQuery.result.columns,
                    rowCount: lastSuccessfulQuery.result.rowCount,
                    rows: lastSuccessfulQuery.result.rows.slice(0, profile.maxRowsPerQuery)
                  })
                ].join("\n\n")
              }
            ]
          });
        } catch {
          text = `I successfully executed the query but could not fully synthesize the final narrative. Raw result: ${asJsonBlock(
            {
              columns: lastSuccessfulQuery.result.columns,
              rowCount: lastSuccessfulQuery.result.rowCount,
              rows: lastSuccessfulQuery.result.rows.slice(0, profile.maxRowsPerQuery)
            }
          )}`;
        }

        return finalizeSuccess(
          text,
          {
            plan: finalPlan,
            plannerAttempts,
            sql: lastSuccessfulQuery.sql,
            toolCalls,
            mode: "direct_tool_loop",
            timings: { ...timings, totalMs: Date.now() - startedAt },
            finalizedFromLastSuccessfulQuery: true
          },
          responseArtifacts.length > 0 ? responseArtifacts : undefined
        );
      }

      const fallback = "I could not reach a reliable final answer after multiple tool attempts. Please try rephrasing.";
      return finalizeSuccess(
        fallback,
        {
          plan: finalPlan,
          plannerAttempts,
          sql: finalSql,
          toolCalls,
          mode: "direct_tool_loop",
          timings: { ...timings, totalMs: Date.now() - startedAt }
        },
        responseArtifacts.length > 0 ? responseArtifacts : undefined
      );
    } catch (error) {
      persistLlmUsageToStore();
      this.store.completeExecutionTurn({
        turnId: executionTurn.id,
        status: "failed",
        errorMessage: (error as Error).message,
        debug: {
          plannerAttempts,
          toolCalls,
          timings: { ...timings, totalMs: Date.now() - startedAt },
          llmUsage: buildLlmUsageDebug()
        }
      });
      throw error;
    }
  }
}
