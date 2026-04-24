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
import {
  AgentArtifact,
  AgentContext,
  AgentExecutionTurn,
  AgentProfile,
  AgentResponse,
  ConversationMessage,
  ContextSectionDiagnostic,
  ExecutionBudget,
  QueryResult,
  ScheduleChannelType,
  TenantMemory
} from "./types.js";
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

const toolDecisionSchema = z.object({
  type: z.enum(["tool_call", "final_answer"]),
  tool: z
    .enum([
      "warehouse.query",
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

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function resolveColumnNameCaseInsensitive(columns: string[], requested: string | null | undefined): string | null {
  if (!requested) {
    return null;
  }
  if (columns.includes(requested)) {
    return requested;
  }
  const lowered = requested.toLowerCase();
  const match = columns.find((column) => column.toLowerCase() === lowered);
  return match ?? null;
}

function getCellValueCaseInsensitive(row: Record<string, unknown>, columnName: string): unknown {
  if (columnName in row) {
    return row[columnName];
  }
  const lowered = columnName.toLowerCase();
  const match = Object.keys(row).find((key) => key.toLowerCase() === lowered);
  return match ? row[match] : undefined;
}

function pickFirstNumericColumn(result: QueryResult, maxRows: number): string | null {
  const rows = result.rows.slice(0, maxRows);
  for (const column of result.columns) {
    for (const row of rows) {
      if (asFiniteNumber(getCellValueCaseInsensitive(row, column)) !== null) {
        return column;
      }
    }
  }
  return null;
}

function pickFirstTextColumn(result: QueryResult, exclude: Set<string>, maxRows: number): string | null {
  const rows = result.rows.slice(0, maxRows);
  for (const column of result.columns) {
    if (exclude.has(column)) {
      continue;
    }
    for (const row of rows) {
      const value = getCellValueCaseInsensitive(row, column);
      if (value !== null && value !== undefined) {
        return column;
      }
    }
  }
  return null;
}

type ChartQueryPreflight = {
  ok: boolean;
  reason?: string;
  resolvedXKey?: string;
  resolvedYKey?: string;
  resolvedSeriesKey?: string;
  numericPoints?: number;
};

function preflightChartQuery(
  result: QueryResult,
  request: ChartBuildRequest,
  maxRows: number
): ChartQueryPreflight {
  const rows = result.rows.slice(0, maxRows);
  if (rows.length === 0) {
    return { ok: false, reason: "query returned 0 rows" };
  }

  const requestedYKey = request.yKey ?? pickFirstNumericColumn(result, maxRows);
  const resolvedYKey = resolveColumnNameCaseInsensitive(result.columns, requestedYKey);
  if (!resolvedYKey) {
    return {
      ok: false,
      reason: request.yKey
        ? `yKey "${request.yKey}" not found in query columns`
        : "could not infer a numeric yKey from query result"
    };
  }

  const resolvedSeriesKey = request.seriesKey
    ? (resolveColumnNameCaseInsensitive(result.columns, request.seriesKey) ?? undefined)
    : undefined;
  if (request.seriesKey && !resolvedSeriesKey) {
    return { ok: false, reason: `seriesKey "${request.seriesKey}" not found in query columns` };
  }

  const requestedXKey = request.xKey ?? pickFirstTextColumn(result, new Set([resolvedYKey]), maxRows);
  const resolvedXKey = resolveColumnNameCaseInsensitive(result.columns, requestedXKey);
  if (!resolvedXKey) {
    return {
      ok: false,
      reason: request.xKey
        ? `xKey "${request.xKey}" not found in query columns`
        : "could not infer an xKey from query result"
    };
  }

  let numericPoints = 0;
  for (const row of rows) {
    if (asFiniteNumber(getCellValueCaseInsensitive(row, resolvedYKey)) !== null) {
      numericPoints += 1;
    }
  }
  if (numericPoints === 0) {
    return {
      ok: false,
      reason: `column "${resolvedYKey}" has no numeric datapoints in first ${rows.length} rows`
    };
  }

  return { ok: true, resolvedXKey, resolvedYKey, resolvedSeriesKey, numericPoints };
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

type PlannerDecision = z.infer<typeof toolDecisionSchema>;
type ToolCallStatus = "ok" | "error" | "reused";

interface RuntimeLoopState {
  finalPlan?: PlannerDecision;
  finalSql?: string;
  loopMessages: LlmMessage[];
  attemptedSql: Set<string>;
  successfulQueries: Array<{ sql: string; result: QueryResult; step: number }>;
  lastSuccessfulQuery?: { sql: string; result: QueryResult };
  latestChartArtifact?: AgentArtifact;
  memorySaveAttemptedThisTurn: boolean;
  memorySaveSucceededThisTurn: boolean;
  scheduleCreateSucceededThisTurn: boolean;
}

interface ContextSnapshot {
  profile: AgentProfile;
  llmModel: string;
  warehouse: WarehouseAdapter;
  whProvider: TenantWarehouseProvider;
  whDatabase: string;
  whSchema: string;
  schemaCandidates: string[];
  dbtModels: Awaited<ReturnType<DbtRepositoryService["listModels"]>>;
  tenantMemories: TenantMemory[];
  userAskedToSaveMemory: boolean;
  userRequestedSchedule: boolean;
  currentDateIso: string;
  currentDate: string;
  contextDiagnostics: ContextSectionDiagnostic[];
  executionBudget: ExecutionBudget;
  historyMessages: LlmMessage[];
  buildBaseMessages: (effectivePromptText: string) => LlmMessage[];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function tokenizeForRanking(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function relevanceScore(text: string, queryTokens: string[]): number {
  const haystack = text.toLowerCase();
  return queryTokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function summarizeOlderHistory(messages: ConversationMessage[], keepLatestCount: number, maxChars: number): string | null {
  const olderMessages = messages.slice(0, Math.max(0, messages.length - keepLatestCount));
  if (olderMessages.length === 0) {
    return null;
  }
  const lines: string[] = [];
  let remaining = maxChars;
  for (const message of olderMessages.slice(-8)) {
    const prefix = message.role === "user" ? "User" : "Assistant";
    const compact = message.content.replace(/\s+/g, " ").trim();
    if (!compact) {
      continue;
    }
    const line = `- ${prefix}: ${compact}`;
    if (line.length > remaining) {
      const truncated = `${line.slice(0, Math.max(0, remaining - 1))}…`.trim();
      if (truncated.length > 2) {
        lines.push(truncated);
      }
      break;
    }
    lines.push(line);
    remaining -= line.length;
  }
  if (lines.length === 0) {
    return null;
  }
  return ["Older conversation summary (compressed):", ...lines].join("\n");
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function extractQualifiedRelations(sql: string): Array<{ schema: string; table: string }> {
  const matches = Array.from(sql.matchAll(/([A-Za-z0-9_`"]+)\.([A-Za-z0-9_`"]+)\.([A-Za-z0-9_`"]+)/g));
  return matches.map((match) => ({
    schema: match[2]?.replace(/[`"]/g, "") ?? "",
    table: match[3]?.replace(/[`"]/g, "") ?? ""
  }));
}

function deepRedact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => deepRedact(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, deepRedact(item)])
    );
  }
  if (typeof value !== "string") {
    return value;
  }
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED_KEY]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b(?:sk|rk|pk)_[A-Za-z0-9]{16,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+\b/gi, "Bearer [REDACTED_TOKEN]");
}

class TurnRecorder {
  readonly traceId: string;
  private readonly timings: Record<string, number> = {};
  private readonly plannerAttempts: Array<{ step: number; raw?: string; parseError?: string; plan?: Record<string, unknown> }> =
    [];
  private readonly toolCalls: Array<{
    tool: string;
    input: Record<string, unknown>;
    status: ToolCallStatus;
    durationMs: number;
    attemptCount?: number;
    reused?: boolean;
    outputSummary?: Record<string, unknown>;
    output?: unknown;
    error?: string;
  }> = [];
  private readonly llmCallSnapshots: Array<{
    callIndex: number;
    model: string;
    usage?: LlmUsage;
    generationId?: string;
  }> = [];
  private llmUsagePersisted = false;
  private llmCallSeq = 0;

  constructor(
    private readonly store: ConversationStore,
    readonly executionTurn: AgentExecutionTurn,
    private readonly startedAt: number
  ) {
    this.traceId = executionTurn.traceId ?? `trace_${Date.now().toString(36)}`;
  }

  async measure<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const stepStart = Date.now();
    const result = await fn();
    this.timings[label] = Date.now() - stepStart;
    return result;
  }

  appendEvent(
    type: Parameters<ConversationStore["appendExecutionEvent"]>[0]["type"],
    level: Parameters<ConversationStore["appendExecutionEvent"]>[0]["level"],
    message: string,
    payload?: Record<string, unknown>,
    step?: number
  ): void {
    this.store.appendExecutionEvent({
      turnId: this.executionTurn.id,
      tenantId: this.executionTurn.tenantId,
      conversationId: this.executionTurn.conversationId,
      step,
      type,
      level,
      message,
      payload
    });
  }

  recordPlannerAttempt(step: number, raw?: string, plan?: Record<string, unknown>, parseError?: string): void {
    this.plannerAttempts.push({ step, raw, plan, parseError });
  }

  recordLlmCall(model: string, result: { usage?: LlmUsage; generationId?: string }): void {
    this.llmCallSnapshots.push({
      callIndex: this.llmCallSeq++,
      model,
      usage: result.usage,
      generationId: result.generationId
    });
  }

  persistLlmUsage(): void {
    if (this.llmUsagePersisted) {
      return;
    }
    this.llmUsagePersisted = true;
    for (const snap of this.llmCallSnapshots) {
      this.store.insertLlmUsageEvent({
        tenantId: this.executionTurn.tenantId,
        executionTurnId: this.executionTurn.id,
        conversationId: this.executionTurn.conversationId,
        model: snap.model,
        generationId: snap.generationId ?? null,
        promptTokens: snap.usage?.promptTokens ?? 0,
        completionTokens: snap.usage?.completionTokens ?? 0,
        totalTokens: snap.usage?.totalTokens ?? 0,
        cost: snap.usage?.cost ?? null,
        callIndex: snap.callIndex
      });
    }
  }

  buildLlmUsageDebug(): Record<string, unknown> {
    const totals = this.llmCallSnapshots.reduce(
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
      calls: this.llmCallSnapshots.map((c) => ({
        callIndex: c.callIndex,
        model: c.model,
        promptTokens: c.usage?.promptTokens ?? 0,
        completionTokens: c.usage?.completionTokens ?? 0,
        totalTokens: c.usage?.totalTokens ?? 0,
        cost: c.usage?.cost,
        generationId: c.generationId
      }))
    };
  }

  recordToolCall(entry: {
    tool: string;
    input: Record<string, unknown>;
    status: ToolCallStatus;
    durationMs: number;
    attemptCount?: number;
    reused?: boolean;
    outputSummary?: Record<string, unknown>;
    output?: unknown;
    error?: string;
  }): void {
    this.toolCalls.push(entry);
  }

  buildDebug(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      ...extra,
      traceId: this.traceId,
      plannerAttempts: this.plannerAttempts,
      toolCalls: this.toolCalls,
      timings: { ...this.timings, totalMs: Date.now() - this.startedAt },
      llmUsage: this.buildLlmUsageDebug()
    };
  }
}

class ContextManager {
  constructor(private readonly store: ConversationStore, private readonly dbtRepo: DbtRepositoryService) {}

  async build(params: {
    context: AgentContext;
    persistedUserText: string;
    effectivePromptText: string;
    warehouse: WarehouseAdapter;
  }): Promise<ContextSnapshot> {
    const { context, persistedUserText, effectivePromptText, warehouse } = params;
    const now = new Date();
    const currentDateIso = now.toISOString();
    const currentDate = currentDateIso.slice(0, 10);
    const profile = this.store.getOrCreateProfile(context.tenantId, context.profileName);
    const fullHistory = this.store.getMessages(context.conversationId, 40);
    const recentHistory = fullHistory.slice(-12);
    const olderSummary = summarizeOlderHistory(fullHistory, 12, 1200);
    const tenantRepo = this.store.getTenantRepo(context.tenantId);
    const tenantWhConfig = this.store.getTenantWarehouseConfig(context.tenantId);
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
    const dbtModels = await this.dbtRepo.listModels(context.tenantId).catch(() => []);
    const queryTokens = tokenizeForRanking(`${persistedUserText} ${effectivePromptText}`);
    const rankedMemories = this.store
      .listTenantMemories(context.tenantId, 500)
      .slice()
      .sort((a, b) => {
        const diff = relevanceScore(b.content, queryTokens) - relevanceScore(a.content, queryTokens);
        return diff !== 0 ? diff : b.updatedAt.localeCompare(a.updatedAt);
      });
    const rankedModels = dbtModels
      .slice()
      .sort((a, b) => {
        const diff =
          relevanceScore(`${b.name} ${b.relativePath}`, queryTokens) -
          relevanceScore(`${a.name} ${a.relativePath}`, queryTokens);
        return diff !== 0 ? diff : a.relativePath.localeCompare(b.relativePath);
      });
    const schemaCandidates = isBigQuery
      ? Array.from(
          new Set([
            whSchema,
            ...dbtModels.map((m) => inferSchemaHintFromModelPath(m.relativePath, whSchema).toLowerCase())
          ].filter((v) => v.length > 0))
        )
      : Array.from(
          new Set([whSchema.toUpperCase(), "INT", "MARTS", "STAGING", "CORE", "PUBLIC"].filter((value) => value.length > 0))
        );
    const historyMessages: LlmMessage[] = recentHistory
      .filter((m) => m.role !== "tool" && m.role !== "system")
      .map((m): LlmMessage => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content
      }));
    const contextDiagnostics: ContextSectionDiagnostic[] = [];
    const executionBudget: ExecutionBudget = {
      maxPlannerSteps: profile.maxPlannerSteps,
      maxRowsPerQuery: profile.maxRowsPerQuery,
      toolTimeoutMs: profile.toolTimeoutMs,
      maxToolRetries: profile.maxToolRetries,
      contextBudgetChars: {
        tenantMemory: TENANT_MEMORY_MAX_PROMPT_CHARS,
        dbtModels: 5000,
        historySummary: 1200
      }
    };

    const buildBaseMessages = (promptText: string): LlmMessage[] => {
      const hasWarehouseDefaults = whDatabase.length > 0 && whSchema.length > 0;
      const fqPrefix = hasWarehouseDefaults
        ? isBigQuery
          ? `\`${whDatabase}.${whSchema}\``
          : `${quoteSqlIdent(whDatabase)}.${quoteSqlIdent(whSchema)}`
        : "";
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
            "- Do not repeat the exact same failing SQL."
          ];
      const dbLabel = isBigQuery ? "project" : "database";
      const schemaLabel = isBigQuery ? "dataset" : "schema";
      const exampleRelation = hasWarehouseDefaults
        ? isBigQuery
          ? `- example fully-qualified relation: \`${whDatabase}.${whSchema}.fct_transactions\``
          : `- example fully-qualified relation: ${fqPrefix}.${quoteSqlIdent("fct_transactions")}`
        : "- fully-qualified relation prefix could not be derived from env.";
      const rankedDbtLines = rankedModels.slice(0, 80).map((m) => {
        if (!hasWarehouseDefaults) {
          return `${m.name} -> ${m.relativePath}`;
        }
        if (isBigQuery) {
          const hintedDataset = inferSchemaHintFromModelPath(m.relativePath, whSchema).toLowerCase();
          return `${m.name} -> ${m.relativePath} -> \`${whDatabase}.${hintedDataset}.${m.name}\``;
        }
        const hintedSchema = inferSchemaHintFromModelPath(m.relativePath, whSchema.toUpperCase());
        return `${m.name} -> ${m.relativePath} -> "${whDatabase}"."${hintedSchema}".${quoteSqlIdent(m.name)}`;
      });
      contextDiagnostics.length = 0;
      const tenantMemoryPrompt = buildTenantMemoryPromptBlock(rankedMemories);
      contextDiagnostics.push({
        section: "tenant_memory",
        includedItems: tenantMemoryPrompt ? tenantMemoryPrompt.split("\n").filter((line) => line.startsWith("- ")).length : 0,
        totalItems: rankedMemories.length,
        approxChars: tenantMemoryPrompt?.length ?? 0,
        truncated: rankedMemories.length > TENANT_MEMORY_MAX_PROMPT_ITEMS
      });
      contextDiagnostics.push({
        section: "dbt_models",
        includedItems: rankedDbtLines.length,
        totalItems: rankedModels.length,
        approxChars: rankedDbtLines.join("\n").length,
        truncated: rankedDbtLines.length < rankedModels.length
      });
      contextDiagnostics.push({
        section: "history",
        includedItems: historyMessages.length,
        totalItems: fullHistory.length,
        approxChars: olderSummary?.length ?? 0,
        truncated: fullHistory.length > historyMessages.length,
        notes: olderSummary ? ["Older turns compressed into a summary block."] : undefined
      });
      return [
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
            "Available tools and args:",
            "- warehouse.query: { sql: string }",
            "- dbt.listModels: {}",
            "- dbt.getModelSql: { modelName: string }",
            `- warehouse.lookupMetadata: { kind: "schemas"|"tables"|"columns", ${dbLabel}?: string, ${schemaLabel}?: string, table?: string, search?: string }`,
            "- tenantMemory.save: { content: string }",
            '- chartjs.build: { type?: "bar"|"line"|"pie"|"doughnut", title?: string, xKey?: string, yKey?: string, seriesKey?: string, horizontal?: boolean, stacked?: boolean, grouped?: boolean, percentStacked?: boolean, sort?: "none"|"asc"|"desc"|"label_asc"|"label_desc", smooth?: boolean, tension?: number, fill?: boolean, step?: boolean, pointRadius?: number, donutCutout?: number, showPercentLabels?: boolean, topN?: number, otherLabel?: string, stackId?: string, maxPoints?: number }',
            '- schedule.create: { userRequest: string, cron: string, channelType?: "slack"|"telegram"|"console"|"custom", channelRef?: string, active?: boolean }',
            "",
            "Return ONLY valid JSON in one of these shapes:",
            '{ "type": "tool_call", "tool": "warehouse.query|dbt.listModels|dbt.getModelSql|warehouse.lookupMetadata|tenantMemory.save|chartjs.build|schedule.create", "args": { ... }, "reasoning"?: string }',
            '{ "type": "final_answer", "answer": string, "reasoning"?: string }',
            "- If the user request is not analytical, ALWAYS return final_answer with the refusal text and do not call tools.",
            "",
            `Max query rows per profile: ${profile.maxRowsPerQuery}.`,
            `Max planner steps per profile: ${profile.maxPlannerSteps}.`,
            `Tool timeout budget (ms): ${profile.toolTimeoutMs}.`
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
          ]
            .filter(Boolean)
            .join("\n")
        },
        ...(tenantMemoryPrompt ? [{ role: "system" as const, content: tenantMemoryPrompt }] : []),
        ...(olderSummary ? [{ role: "system" as const, content: olderSummary }] : []),
        {
          role: "system",
          content: `dbt models currently available (ranked by relevance):\n${rankedDbtLines.join("\n")}`
        },
        ...historyMessages,
        {
          role: "user",
          content: promptText
        }
      ];
    };

    return {
      profile,
      llmModel,
      warehouse,
      whProvider,
      whDatabase,
      whSchema,
      schemaCandidates,
      dbtModels,
      tenantMemories: rankedMemories,
      userAskedToSaveMemory: userExplicitlyAskedToSaveMemory(persistedUserText),
      userRequestedSchedule: userExplicitlyRequestedSchedule(persistedUserText),
      currentDateIso,
      currentDate,
      contextDiagnostics,
      executionBudget,
      historyMessages,
      buildBaseMessages
    };
  }
}

class PolicyGateway {
  constructor(private readonly sqlGuard: SqlGuard) {}

  approveToolCall(input: {
    context: AgentContext;
    snapshot: ContextSnapshot;
    plan: PlannerDecision;
    args: Record<string, unknown>;
  }): {
    approvedArgs: Record<string, unknown>;
    timeoutMs: number;
    cacheKey: string;
    redactedInput: Record<string, unknown>;
  } {
    const { context, snapshot, plan, args } = input;
    if (plan.type !== "tool_call" || !plan.tool) {
      throw new Error("Only tool calls can be evaluated by the policy gateway.");
    }
    if (!snapshot.profile.allowedTools.includes(plan.tool)) {
      throw new Error(`Tool "${plan.tool}" is not allowed for profile "${snapshot.profile.name}".`);
    }
    let approvedArgs = { ...args };
    if (plan.tool === "warehouse.query") {
      const sql = typeof args.sql === "string" ? args.sql.trim() : "";
      if (!sql) {
        throw new Error("warehouse.query requires args.sql.");
      }
      const normalizedSql = this.sqlGuard
        .normalize(sql)
        .replace(/\blimit\s+\d+\b/i, `LIMIT ${snapshot.profile.maxRowsPerQuery}`);
      for (const relation of extractQualifiedRelations(normalizedSql)) {
        const schemaBlocked = snapshot.profile.blockedSchemaPatterns.some((pattern) =>
          wildcardToRegex(pattern).test(relation.schema)
        );
        if (schemaBlocked) {
          throw new Error(`Query references blocked schema "${relation.schema}".`);
        }
        const tableBlocked = snapshot.profile.blockedTablePatterns.some((pattern) =>
          wildcardToRegex(pattern).test(relation.table)
        );
        if (tableBlocked) {
          throw new Error(`Query references blocked table "${relation.table}".`);
        }
      }
      approvedArgs = { sql: normalizedSql, timeoutMs: snapshot.profile.toolTimeoutMs };
    }
    if (plan.tool === "dbt.getModelSql") {
      const modelName = typeof args.modelName === "string" ? args.modelName.trim() : "";
      if (!modelName) {
        throw new Error("dbt.getModelSql requires args.modelName.");
      }
      const model = snapshot.dbtModels.find((entry) => entry.name === modelName);
      if (
        model &&
        snapshot.profile.allowedDbtPathPrefixes.length > 0 &&
        !snapshot.profile.allowedDbtPathPrefixes.some((prefix) => model.relativePath.startsWith(prefix))
      ) {
        throw new Error(`Model "${modelName}" is outside the allowed dbt path prefixes for this profile.`);
      }
      approvedArgs = { modelName };
    }
    if (plan.tool === "tenantMemory.save") {
      const content = typeof args.content === "string" ? normalizeMemoryContent(args.content) : "";
      if (!content) {
        throw new Error("tenantMemory.save requires args.content.");
      }
      approvedArgs = { content };
    }
    const timeoutMs = snapshot.profile.toolTimeoutMs;
    const redactedInput = deepRedact(approvedArgs) as Record<string, unknown>;
    return {
      approvedArgs,
      timeoutMs,
      cacheKey: stableStringify({ tenantId: context.tenantId, tool: plan.tool, args: approvedArgs }),
      redactedInput
    };
  }
}

class Planner {
  constructor(private readonly runLlm: (input: { messages: LlmMessage[]; temperature: number }) => Promise<string>) {}

  async decide(input: {
    step: number;
    promptMessages: LlmMessage[];
    recorder: TurnRecorder;
  }): Promise<
    | { ok: true; raw: string; plan: PlannerDecision }
    | { ok: false; raw: string; error: string; observation: string }
  > {
    const raw = await input.recorder.measure(`plannerMs_step${input.step}`, async () =>
      this.runLlm({ messages: input.promptMessages, temperature: 0 })
    );
    try {
      const plan = toolDecisionSchema.parse(JSON.parse(raw));
      input.recorder.recordPlannerAttempt(input.step, raw, plan as Record<string, unknown>);
      input.recorder.appendEvent(
        "planner.decision",
        "info",
        `Planner produced ${plan.type}.`,
        { raw, plan: plan as Record<string, unknown> },
        input.step
      );
      return { ok: true, raw, plan };
    } catch (error) {
      const message = (error as Error).message;
      input.recorder.recordPlannerAttempt(input.step, raw, undefined, message);
      input.recorder.appendEvent(
        "planner.invalid_json",
        "warning",
        "Planner returned invalid JSON.",
        { raw, error: message },
        input.step
      );
      return {
        ok: false,
        raw,
        error: message,
        observation: `Invalid JSON response. Error: ${message}. Return valid JSON only.`
      };
    }
  }
}

class FeedbackAssembler {
  buildToolResult(tool: string, payload: Record<string, unknown>): LlmMessage {
    return { role: "user", content: `Tool result (${tool}): ${asJsonBlock(payload)}` };
  }

  buildToolError(tool: string, errorText: string): LlmMessage {
    return {
      role: "user",
      content:
        tool === "tenantMemory.save"
          ? `Tool error (tenantMemory.save): ${errorText}. Do NOT claim that memory was saved. Either issue a corrected tenantMemory.save call or return final_answer explicitly saying the save did not happen.`
          : `Tool error (${tool}): ${errorText}. Choose a corrected tool call or final_answer.`
    };
  }

  buildObservation(message: string): LlmMessage {
    return { role: "user", content: message };
  }

  finalizeDebug(input: {
    recorder: TurnRecorder;
    snapshot: ContextSnapshot;
    state: RuntimeLoopState;
    plan?: PlannerDecision;
    finalizedFromLastSuccessfulQuery?: boolean;
  }): Record<string, unknown> {
    return input.recorder.buildDebug({
      plan: input.plan,
      sql: input.state.lastSuccessfulQuery?.sql ?? input.state.finalSql,
      mode: "managed_repl_harness",
      finalizedFromLastSuccessfulQuery: input.finalizedFromLastSuccessfulQuery,
      executionBudget: input.snapshot.executionBudget,
      contextDiagnostics: input.snapshot.contextDiagnostics
    });
  }
}

class ToolExecutor {
  constructor(
    private readonly deps: {
      store: ConversationStore;
      dbtRepo: DbtRepositoryService;
      chartTool: ChartTool;
      policyGateway: PolicyGateway;
      feedbackAssembler: FeedbackAssembler;
    }
  ) {}

  async execute(input: {
    context: AgentContext;
    snapshot: ContextSnapshot;
    plan: PlannerDecision;
    step: number;
    persistedUserText: string;
    state: RuntimeLoopState;
    recorder: TurnRecorder;
  }): Promise<LlmMessage> {
    const { context, snapshot, plan, step, persistedUserText, state, recorder } = input;
    if (plan.type !== "tool_call" || !plan.tool) {
      throw new Error("Unsupported planner result for ToolExecutor.");
    }
    const args = (plan.args ?? {}) as Record<string, unknown>;
    let approved: ReturnType<PolicyGateway["approveToolCall"]>;
    try {
      approved = this.deps.policyGateway.approveToolCall({ context, snapshot, plan, args });
    } catch (error) {
      recorder.appendEvent(
        "policy.denied",
        "error",
        `Policy denied ${plan.tool}.`,
        { tool: plan.tool, error: (error as Error).message },
        step
      );
      throw error;
    }
    recorder.appendEvent(
      "policy.approved",
      "success",
      `Policy approved ${plan.tool}.`,
      { tool: plan.tool, args: approved.redactedInput },
      step
    );

    const previous = this.deps.store.getToolExecutionByCacheKey(recorder.executionTurn.id, approved.cacheKey);
    if (previous && previous.output !== undefined) {
      recorder.recordToolCall({
        tool: plan.tool,
        input: approved.redactedInput,
        status: "reused",
        durationMs: 0,
        reused: true,
        attemptCount: previous.attemptCount,
        outputSummary: previous.outputSummary,
        output: previous.output
      });
      recorder.appendEvent("tool.reused", "info", `Reused cached ${plan.tool} result for this turn.`, { tool: plan.tool }, step);
      this.deps.store.recordToolExecution({
        turnId: recorder.executionTurn.id,
        tenantId: context.tenantId,
        conversationId: context.conversationId,
        step,
        cacheKey: approved.cacheKey,
        tool: plan.tool,
        input: approved.redactedInput,
        status: "reused",
        durationMs: 0,
        attemptCount: previous.attemptCount,
        outputSummary: previous.outputSummary,
        output: previous.output
      });
      return this.deps.feedbackAssembler.buildToolResult(plan.tool, previous.output as Record<string, unknown>);
    }

    let lastError: Error | null = null;
    const maxAttempts = Math.max(1, snapshot.profile.maxToolRetries + 1);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const started = Date.now();
      recorder.appendEvent(
        "tool.started",
        "info",
        `Executing ${plan.tool} (attempt ${attempt}/${maxAttempts}).`,
        { tool: plan.tool, args: approved.redactedInput },
        step
      );
      try {
        const result = await this.runTool(plan.tool, approved.approvedArgs, snapshot, context, persistedUserText, state, recorder, step);
        const durationMs = Date.now() - started;
        const redactedOutput = deepRedact(result.payload);
        recorder.recordToolCall({
          tool: plan.tool,
          input: approved.redactedInput,
          status: "ok",
          durationMs,
          attemptCount: attempt,
          outputSummary: result.summary,
          output: redactedOutput
        });
        this.deps.store.recordToolExecution({
          turnId: recorder.executionTurn.id,
          tenantId: context.tenantId,
          conversationId: context.conversationId,
          step,
          cacheKey: approved.cacheKey,
          tool: plan.tool,
          input: approved.redactedInput,
          status: "ok",
          durationMs,
          attemptCount: attempt,
          outputSummary: result.summary,
          output: redactedOutput
        });
        recorder.appendEvent(
          "tool.completed",
          "success",
          `${plan.tool} succeeded.`,
          { tool: plan.tool, durationMs, summary: result.summary },
          step
        );
        return this.deps.feedbackAssembler.buildToolResult(plan.tool, redactedOutput as Record<string, unknown>);
      } catch (error) {
        lastError = error as Error;
        const durationMs = Date.now() - started;
        recorder.recordToolCall({
          tool: plan.tool,
          input: approved.redactedInput,
          status: "error",
          durationMs,
          attemptCount: attempt,
          error: (error as Error).message
        });
        this.deps.store.recordToolExecution({
          turnId: recorder.executionTurn.id,
          tenantId: context.tenantId,
          conversationId: context.conversationId,
          step,
          cacheKey: approved.cacheKey,
          tool: plan.tool,
          input: approved.redactedInput,
          status: "error",
          durationMs,
          attemptCount: attempt,
          error: (error as Error).message
        });
        const isRetryable = this.isRetryable(plan.tool, error as Error);
        recorder.appendEvent(
          "tool.failed",
          isRetryable && attempt < maxAttempts ? "warning" : "error",
          `${plan.tool} failed.`,
          { tool: plan.tool, error: (error as Error).message, attempt, maxAttempts },
          step
        );
        if (!isRetryable || attempt >= maxAttempts) {
          break;
        }
        recorder.appendEvent(
          "tool.retry",
          "warning",
          `Retrying ${plan.tool} after a transient failure.`,
          { tool: plan.tool, attempt, nextAttempt: attempt + 1 },
          step
        );
        await sleep(150 * attempt);
      }
    }
    throw lastError ?? new Error(`Tool ${plan.tool} failed.`);
  }

  private isRetryable(tool: string, error: Error): boolean {
    const text = error.message.toLowerCase();
    if (tool === "warehouse.query" || tool === "warehouse.lookupMetadata") {
      return text.includes("timeout") || text.includes("tempor") || text.includes("network");
    }
    if (tool === "dbt.listModels" || tool === "dbt.getModelSql") {
      return text.includes("tempor") || text.includes("network") || text.includes("econn");
    }
    return false;
  }

  private async runTool(
    tool: string,
    args: Record<string, unknown>,
    snapshot: ContextSnapshot,
    context: AgentContext,
    persistedUserText: string,
    state: RuntimeLoopState,
    recorder: TurnRecorder,
    step: number
  ): Promise<{ summary: Record<string, unknown>; payload: Record<string, unknown> }> {
    if (tool === "dbt.listModels") {
      const models = await this.deps.dbtRepo.listModels(context.tenantId);
      return {
        summary: { modelCount: models.length },
        payload: {
          modelCount: models.length,
          models: models.slice(0, 100).map((m) => ({ name: m.name, relativePath: m.relativePath }))
        }
      };
    }
    if (tool === "dbt.getModelSql") {
      const modelName = typeof args.modelName === "string" ? args.modelName.trim() : "";
      const modelSql = await recorder.measure("getModelSqlMs", async () =>
        this.deps.dbtRepo.getModelSql(context.tenantId, modelName)
      );
      if (!modelSql) {
        throw new Error(`Model "${modelName}" was not found in configured dbt repo.`);
      }
      return {
        summary: { found: true, modelName },
        payload: { modelName, sql: modelSql }
      };
    }
    if (tool === "warehouse.lookupMetadata") {
      const parsedLookup = metadataLookupSchema.safeParse(args);
      if (!parsedLookup.success) {
        throw new Error("warehouse.lookupMetadata requires valid lookup args.");
      }
      const metadataSql = buildMetadataLookupSql(
        parsedLookup.data,
        snapshot.whDatabase,
        snapshot.whSchema,
        snapshot.profile.maxRowsPerQuery,
        snapshot.whProvider
      );
      if (!metadataSql) {
        throw new Error(`Metadata lookup requires ${snapshot.whProvider === "bigquery" ? "project" : "database"} context.`);
      }
      const metadataResult = await snapshot.warehouse.query(metadataSql, { timeoutMs: snapshot.profile.toolTimeoutMs });
      return {
        summary: { rowCount: metadataResult.rowCount, columns: metadataResult.columns },
        payload: {
          columns: metadataResult.columns,
          rowCount: metadataResult.rowCount,
          rows: metadataResult.rows.slice(0, snapshot.profile.maxRowsPerQuery)
        }
      };
    }
    if (tool === "tenantMemory.save") {
      state.memorySaveAttemptedThisTurn = true;
      if (!snapshot.userAskedToSaveMemory) {
        throw new Error("tenantMemory.save can only be used when the user explicitly asks to remember or save something.");
      }
      const parsedMemory = tenantMemorySaveSchema.safeParse(args);
      if (!parsedMemory.success) {
        throw new Error("tenantMemory.save requires args.content as a short string.");
      }
      const normalizedContent = normalizeMemoryContent(parsedMemory.data.content);
      const existingMemory = this.deps.store
        .listTenantMemories(context.tenantId, 500)
        .find((memory) => memoryDedupKey(memory.content) === memoryDedupKey(normalizedContent));
      const savedMemory =
        existingMemory ??
        this.deps.store.createTenantMemory({
          tenantId: context.tenantId,
          content: normalizedContent,
          source: "agent"
        });
      state.memorySaveSucceededThisTurn = true;
      snapshot.tenantMemories = this.deps.store.listTenantMemories(context.tenantId, 500);
      return {
        summary: { saved: !existingMemory, deduped: Boolean(existingMemory), memoryId: savedMemory.id },
        payload: {
          saved: !existingMemory,
          deduped: Boolean(existingMemory),
          memoryId: savedMemory.id,
          content: savedMemory.content
        }
      };
    }
    if (tool === "schedule.create") {
      if (!snapshot.userRequestedSchedule) {
        throw new Error("schedule.create can only be used when the user explicitly requests a recurring schedule or reminder.");
      }
      const parsedSchedule = scheduleCreateSchema.safeParse(args);
      if (!parsedSchedule.success) {
        throw new Error("schedule.create requires userRequest, cron, and valid channel fields.");
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
      const schedule = this.deps.store.createTenantSchedule({
        tenantId: context.tenantId,
        userRequest: parsedSchedule.data.userRequest || persistedUserText,
        cron,
        channelType,
        channelRef,
        active: parsedSchedule.data.active ?? true
      });
      state.scheduleCreateSucceededThisTurn = true;
      return {
        summary: { scheduleId: schedule.id, active: schedule.active, channelType: schedule.channelType },
        payload: {
          id: schedule.id,
          cron: schedule.cron,
          channelType: schedule.channelType,
          channelRef: schedule.channelRef,
          active: schedule.active
        }
      };
    }
    if (tool === "chartjs.build") {
      const parsedRequest = chartRequestSchema.safeParse(args);
      if (!parsedRequest.success) {
        throw new Error("chartjs.build requires valid chart args.");
      }
      if (state.successfulQueries.length === 0) {
        throw new Error("No successful query result available yet. Run warehouse.query first.");
      }
      const baseChartRequest = parsedRequest.data as ChartBuildRequest;
      let selectedQuery: { sql: string; result: QueryResult; step: number } | undefined;
      let selectedPreflight: ChartQueryPreflight | undefined;
      const preflightFailures: string[] = [];
      for (let idx = state.successfulQueries.length - 1; idx >= 0; idx -= 1) {
        const candidate = state.successfulQueries[idx];
        const preflight = preflightChartQuery(candidate.result, baseChartRequest, snapshot.profile.maxRowsPerQuery);
        if (preflight.ok) {
          selectedQuery = candidate;
          selectedPreflight = preflight;
          break;
        }
        preflightFailures.push(`step ${candidate.step}: ${preflight.reason ?? "not chart-compatible"}`);
      }
      if (!selectedQuery || !selectedPreflight?.resolvedXKey || !selectedPreflight.resolvedYKey) {
        const detail = preflightFailures[0] ?? "Run warehouse.query with chart-ready columns first.";
        throw new Error(`No compatible query result available for chartjs.build (${detail}).`);
      }
      const effectiveChartRequest: ChartBuildRequest = {
        ...baseChartRequest,
        xKey: selectedPreflight.resolvedXKey,
        yKey: selectedPreflight.resolvedYKey,
        ...(selectedPreflight.resolvedSeriesKey ? { seriesKey: selectedPreflight.resolvedSeriesKey } : {})
      };
      const chartBuild = this.deps.chartTool.buildFromQueryResult({
        request: effectiveChartRequest,
        result: selectedQuery.result,
        maxPoints: snapshot.profile.maxRowsPerQuery
      });
      state.latestChartArtifact = {
        type: "chartjs_config",
        format: "json",
        payload: chartBuild.config,
        summary: chartBuild.summary
      };
      return {
        summary: chartBuild.summary,
        payload: chartBuild.summary
      };
    }
    if (tool === "warehouse.query") {
      const sql = typeof args.sql === "string" ? args.sql : "";
      if (!sql) {
        throw new Error("warehouse.query requires args.sql.");
      }
      if (state.attemptedSql.has(sql)) {
        throw new Error("Duplicate SQL attempt in this turn. Generate a different query.");
      }
      state.attemptedSql.add(sql);
      state.finalSql = sql;
      const queryResult = await recorder.measure("warehouseMs", async () =>
        snapshot.warehouse.query(sql, { timeoutMs: snapshot.profile.toolTimeoutMs })
      );
      state.lastSuccessfulQuery = { sql, result: queryResult };
      state.successfulQueries.push({ sql, result: queryResult, step });
      if (state.successfulQueries.length > snapshot.profile.maxPlannerSteps) {
        state.successfulQueries.shift();
      }
      return {
        summary: { rowCount: queryResult.rowCount, columns: queryResult.columns },
        payload: {
          sql,
          columns: queryResult.columns,
          rowCount: queryResult.rowCount,
          rows: queryResult.rows.slice(0, snapshot.profile.maxRowsPerQuery)
        }
      };
    }
    throw new Error(`Unsupported tool: ${tool}`);
  }
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
    const traceId = `trace_${Date.now().toString(36)}`;

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
      traceId,
      source: context.origin?.source ?? "cli",
      rawUserText: persistedUserText,
      promptText: effectivePromptText,
      status: "running"
    });
    const recorder = new TurnRecorder(this.store, executionTurn, startedAt);
    const feedbackAssembler = new FeedbackAssembler();
    recorder.appendEvent("turn.started", "info", "Execution turn started.", {
      source: executionTurn.source,
      traceId: recorder.traceId
    });

    try {
      const warehouse = this.resolveWarehouse(context.tenantId);
      const contextManager = new ContextManager(this.store, this.dbtRepo);
      const snapshot = await recorder.measure("contextMs", async () =>
        contextManager.build({ context, persistedUserText, effectivePromptText, warehouse })
      );
      recorder.appendEvent("context.compiled", "info", "Compiled ranked context for the turn.", {
        diagnostics: snapshot.contextDiagnostics,
        executionBudget: snapshot.executionBudget
      });

      const runLlm = async (input: { messages: LlmMessage[]; temperature: number }): Promise<string> => {
        const result = await this.llm.generateText({
          model: snapshot.llmModel,
          messages: input.messages,
          temperature: input.temperature
        });
        recorder.recordLlmCall(snapshot.llmModel, result);
        return result.text;
      };

      const planner = new Planner(runLlm);
      const toolExecutor = new ToolExecutor({
        store: this.store,
        dbtRepo: this.dbtRepo,
        chartTool: this.chartTool,
        policyGateway: new PolicyGateway(this.sqlGuard),
        feedbackAssembler
      });

      const state: RuntimeLoopState = {
        loopMessages: [],
        attemptedSql: new Set<string>(),
        successfulQueries: [],
        memorySaveAttemptedThisTurn: false,
        memorySaveSucceededThisTurn: false,
        scheduleCreateSucceededThisTurn: false
      };

      const finalizeSuccess = (text: string, finalizedFromLastSuccessfulQuery = false): AgentResponse => {
        recorder.persistLlmUsage();
        const debug = feedbackAssembler.finalizeDebug({
          recorder,
          snapshot,
          state,
          plan: state.finalPlan,
          finalizedFromLastSuccessfulQuery
        });
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
          debug
        });
        recorder.appendEvent("turn.finalized", "success", "Execution turn completed.", {
          finalizedFromLastSuccessfulQuery
        });
        return {
          text,
          artifacts: state.latestChartArtifact ? [state.latestChartArtifact] : undefined,
          debug
        };
      };

      for (let step = 1; step <= snapshot.executionBudget.maxPlannerSteps; step += 1) {
        const promptMessages = [...snapshot.buildBaseMessages(effectivePromptText), ...state.loopMessages];
        const decision = await planner.decide({ step, promptMessages, recorder });
        if (!decision.ok) {
          state.loopMessages.push(feedbackAssembler.buildObservation(decision.observation));
          continue;
        }

        state.finalPlan = decision.plan;
        state.loopMessages.push({ role: "assistant", content: decision.raw });

        if (decision.plan.type === "final_answer") {
          const candidateText = decision.plan.answer?.trim() ? decision.plan.answer : "I need more details to answer that.";
          if (
            claimsTenantMemoryWasSaved(candidateText) &&
            !state.memorySaveSucceededThisTurn &&
            step < snapshot.executionBudget.maxPlannerSteps
          ) {
            state.loopMessages.push(
              feedbackAssembler.buildObservation(
                snapshot.userAskedToSaveMemory
                  ? "You claimed that tenant memory was saved, but there is no successful Tool result (tenantMemory.save) in this turn. Before claiming success, call tenantMemory.save and wait for its tool result. If you cannot save it, return final_answer explicitly saying the save did not happen."
                  : "You claimed that tenant memory was saved, but there is no successful Tool result (tenantMemory.save) in this turn. Do not claim success. Return a corrected final_answer, or only use tenantMemory.save if the user explicitly asked for memory persistence."
              )
            );
            continue;
          }
          if (
            claimsScheduleWasCreated(candidateText) &&
            !state.scheduleCreateSucceededThisTurn &&
            step < snapshot.executionBudget.maxPlannerSteps
          ) {
            state.loopMessages.push(
              feedbackAssembler.buildObservation(
                "You claimed that a schedule/reminder was created, but there is no successful Tool result (schedule.create) in this turn. Call schedule.create and wait for its tool result, or explicitly state that scheduling did not happen."
              )
            );
            continue;
          }
          return finalizeSuccess(ensureAccurateTenantMemorySaveText(candidateText, state.memorySaveSucceededThisTurn));
        }

        if (decision.plan.type !== "tool_call" || !decision.plan.tool) {
          state.loopMessages.push(feedbackAssembler.buildObservation("Return either a valid tool_call or final_answer JSON."));
          continue;
        }

        try {
          const observation = await toolExecutor.execute({
            context,
            snapshot,
            plan: decision.plan,
            step,
            persistedUserText,
            state,
            recorder
          });
          state.loopMessages.push(observation);
          recorder.appendEvent("feedback.observation", "info", `Injected tool observation for ${decision.plan.tool}.`, {
            tool: decision.plan.tool
          }, step);
        } catch (error) {
          state.loopMessages.push(feedbackAssembler.buildToolError(decision.plan.tool, (error as Error).message));
        }
      }

      if (state.lastSuccessfulQuery) {
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
                  snapshot.profile.soulPrompt,
                  "",
                  "Answer using business language and include caveats when sample size or nulls matter."
                ].join("\n")
              },
              ...buildTenantMemorySystemMessage(snapshot.tenantMemories),
              {
                role: "user",
                content: [
                  `User question: ${persistedUserText}`,
                  `Executed SQL:\n${state.lastSuccessfulQuery.sql}`,
                  "Result JSON:",
                  asJsonBlock({
                    columns: state.lastSuccessfulQuery.result.columns,
                    rowCount: state.lastSuccessfulQuery.result.rowCount,
                    rows: state.lastSuccessfulQuery.result.rows.slice(0, snapshot.profile.maxRowsPerQuery)
                  })
                ].join("\n\n")
              }
            ]
          });
        } catch {
          text = `I successfully executed the query but could not fully synthesize the final narrative. Raw result: ${asJsonBlock(
            {
              columns: state.lastSuccessfulQuery.result.columns,
              rowCount: state.lastSuccessfulQuery.result.rowCount,
              rows: state.lastSuccessfulQuery.result.rows.slice(0, snapshot.profile.maxRowsPerQuery)
            }
          )}`;
        }
        return finalizeSuccess(text, true);
      }

      return finalizeSuccess("I could not reach a reliable final answer after multiple tool attempts. Please try rephrasing.");
    } catch (error) {
      recorder.persistLlmUsage();
      const debug = recorder.buildDebug({});
      this.store.completeExecutionTurn({
        turnId: executionTurn.id,
        status: "failed",
        errorMessage: (error as Error).message,
        debug
      });
      recorder.appendEvent("turn.finalized", "error", "Execution turn failed.", {
        error: (error as Error).message
      });
      throw error;
    }
  }
}
