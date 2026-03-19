import { z } from "zod";
import {
  ChartBuildRequest,
  ChartTool,
  ConversationStore,
  DbtRepositoryService,
  LlmMessage,
  LlmProvider,
  WarehouseAdapter
} from "./interfaces.js";
import { AgentArtifact, AgentContext, AgentResponse, QueryResult } from "./types.js";
import { SqlGuard } from "./sqlGuard.js";

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

const memoryCreateSchema = z.object({
  summary: z.string().trim().min(1).max(240)
});

const memoryListSchema = z.object({
  includeDeleted: z.boolean().optional()
});

const memoryUpdateSchema = z.object({
  id: z.string().trim().min(1),
  summary: z.string().trim().min(1).max(240)
});

const memoryDeleteSchema = z.object({
  id: z.string().trim().min(1)
});

const toolDecisionSchema = z.object({
  type: z.enum(["tool_call", "final_answer"]),
  tool: z
    .enum([
      "snowflake.query",
      "dbt.listModels",
      "dbt.getModelSql",
      "snowflake.lookupMetadata",
      "chartjs.build",
      "memory.create",
      "memory.list",
      "memory.update",
      "memory.delete"
    ])
    .optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  answer: z.string().optional(),
  reasoning: z.string().optional()
});

function asJsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function quoteSqlIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildMetadataLookupSql(
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

function buildTenantMemorySystemMessage(summaries: string[]): string {
  return [
    "Tenant memory (shared business context from prior conversations):",
    "- Treat these as tenant-specific conventions and definitions unless the user explicitly corrects them.",
    "- Prefer these definitions when answering analytics questions for this tenant.",
    ...summaries.map((summary) => `- ${summary}`)
  ].join("\n");
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
    const maxToolSteps = 8;
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
    const userMessage = this.store.addMessage({
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

    try {
      const profile = this.store.getOrCreateProfile(context.tenantId, context.profileName);
      timings.profileMs = Date.now() - startedAt;
      const history = this.store.getMessages(context.conversationId, 12);
      const tenantMemories = this.store.getTenantMemoriesForPrompt({
        tenantId: context.tenantId,
        queryText: persistedUserText,
        limit: 5
      });
      const tenantRepo = this.store.getTenantRepo(context.tenantId);
      const tenantWhConfig = this.store.getTenantWarehouseConfig(context.tenantId);
      const snowflakeDatabase =
        tenantWhConfig?.snowflake?.database?.trim() ?? process.env.SNOWFLAKE_DATABASE?.trim() ?? "";
      const snowflakeSchema =
        tenantWhConfig?.snowflake?.schema?.trim() ?? process.env.SNOWFLAKE_SCHEMA?.trim() ?? "";
      const warehouse = this.resolveWarehouse(context.tenantId);
      const llmModel = context.llmModel?.trim() || process.env.LLM_MODEL || "openai/gpt-4o-mini";
      const now = new Date();
      const currentDateIso = now.toISOString();
      const currentDate = currentDateIso.slice(0, 10);
      const hasWarehouseDefaults = snowflakeDatabase.length > 0 && snowflakeSchema.length > 0;
      const fqPrefix = hasWarehouseDefaults
        ? `${quoteSqlIdent(snowflakeDatabase)}.${quoteSqlIdent(snowflakeSchema)}`
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
      const schemaCandidates = Array.from(
        new Set(
          [snowflakeSchema.toUpperCase(), "INT", "MARTS", "STAGING", "CORE", "PUBLIC"].filter(
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
      const selectedMemorySummaries = tenantMemories
        .map((memory) => memory.summary.trim())
        .filter((summary) => summary.length > 0)
        .slice(0, 8);

      const baseMessages = (): LlmMessage[] => [
      {
        role: "system",
        content: [
          "Identity and scope (highest priority):",
          "- You are Agent Blue.",
          "- Your owner is Blueprintdata (https://blueprintdata.xyz/).",
          "- Tenant context may change per request, but your identity and owner never change.",
          "- You ONLY answer analytical questions related to data, metrics, SQL, BI, dbt models, and business performance analysis.",
          "- Exception: you may use tenant memory tools when the user explicitly asks to save, list, update, or delete shared tenant memory.",
          "- Users may ask for tenant memory operations in any language. Infer intent from meaning, not only English wording.",
          "- Never create, update, or delete memory unless the user explicitly asks you to do so.",
          "- Do not auto-save facts from normal analytics conversations.",
          "- For any non-analytical or unrelated request outside explicit tenant memory management, do not call tools and return final_answer refusing the request.",
          '- Refusal text for non-analytical requests: "I can only help with analytical questions about data and business metrics."',
          "",
          profile.soulPrompt,
          "",
          "You are an analytics assistant with tools. Use tools iteratively and then provide a final answer.",
          `Current date/time (UTC): ${currentDateIso}`,
          `Current date (UTC): ${currentDate}`,
          "",
          "SQL generation requirements (strict):",
          "- Use fully-qualified Snowflake object names in every query: DATABASE.SCHEMA.OBJECT.",
          "- Never use unqualified table names like `fct_transactions`.",
          hasWarehouseDefaults
            ? `- Start with ${fqPrefix} as a default guess, but do not treat schema as fixed.`
            : "- SNOWFLAKE_DATABASE/SCHEMA defaults are unavailable, so infer carefully and avoid guessing.",
          `- Allowed/expected schema candidates to consider: ${schemaCandidates.join(", ")}.`,
          "- Use dbt model path hints and inspected dbt SQL to choose schema.",
          "- If table/schema/column names are uncertain, use snowflake.lookupMetadata.",
          "- If dbt lineage is uncertain, use dbt.getModelSql.",
          "- If visualization is requested, call chartjs.build after at least one successful query.",
          "- When a chart artifact is generated with chartjs.build, do NOT draw an ASCII/Markdown/text chart in the answer.",
          "- With chart artifacts, keep the narrative concise: key takeaway(s), notable outliers, and caveats only.",
          "- For chart queries with time on x-axis, ALWAYS return a normalized time label column:",
          "  - monthly: TO_CHAR(DATE_TRUNC('month', <timestamp_col>), 'YYYY-MM') AS period_label",
          "  - daily: TO_CHAR(DATE_TRUNC('day', <timestamp_col>), 'YYYY-MM-DD') AS period_label",
          "- Always ORDER BY the same normalized period label (or underlying truncated date) ascending.",
          "- Prefer using the normalized label column as xKey for chartjs.build.",
          "- Do not repeat the exact same failing SQL.",
          "",
          "Available tools and args:",
          "- snowflake.query: { sql: string }",
          "- dbt.listModels: {}",
          "- dbt.getModelSql: { modelName: string }",
          '- snowflake.lookupMetadata: { kind: "schemas"|"tables"|"columns", database?: string, schema?: string, table?: string, search?: string }',
          '- chartjs.build: { type?: "bar"|"line"|"pie"|"doughnut", title?: string, xKey?: string, yKey?: string, seriesKey?: string, horizontal?: boolean, stacked?: boolean, grouped?: boolean, percentStacked?: boolean, sort?: "none"|"asc"|"desc"|"label_asc"|"label_desc", smooth?: boolean, tension?: number, fill?: boolean, step?: boolean, pointRadius?: number, donutCutout?: number, showPercentLabels?: boolean, topN?: number, otherLabel?: string, stackId?: string, maxPoints?: number }',
          '- memory.create: { summary: string }',
          '- memory.list: { includeDeleted?: boolean }',
          '- memory.update: { id: string, summary: string }',
          '- memory.delete: { id: string }',
          "",
          "Return ONLY valid JSON in one of these shapes:",
          '{ "type": "tool_call", "tool": "snowflake.query|dbt.listModels|dbt.getModelSql|snowflake.lookupMetadata|chartjs.build|memory.create|memory.list|memory.update|memory.delete", "args": { ... }, "reasoning"?: string }',
          '{ "type": "final_answer", "answer": string, "reasoning"?: string }',
          "- If the user request is not analytical and is not an explicit tenant memory management request, ALWAYS return final_answer with the refusal text and do not call tools.",
          "- If you call memory.create or memory.update, rewrite the stored summary into one concise line, plain text only, preserving the business meaning.",
          "- Prefer memory.list before memory.update or memory.delete when the user references a memory ambiguously and no exact id is known.",
          "",
          `Max query rows per profile: ${profile.maxRowsPerQuery}.`
        ].join("\n")
      },
      {
        role: "system",
        content: [
          "Warehouse context:",
          `- current_date_utc: ${currentDate}`,
          `- current_datetime_utc: ${currentDateIso}`,
          `- tenantId: ${context.tenantId}`,
          `- database: ${snowflakeDatabase || "(not set)"}`,
          `- schema: ${snowflakeSchema || "(not set)"}`,
          `- schema_candidates: ${schemaCandidates.join(", ")}`,
          `- dbt subpath: ${tenantRepo?.dbtSubpath ?? "(unknown)"}`,
          hasWarehouseDefaults
            ? `- example fully-qualified relation: ${fqPrefix}.${quoteSqlIdent("fct_transactions")}`
            : "- fully-qualified relation prefix could not be derived from env."
        ].join("\n")
      },
      {
        role: "system",
        content: `dbt models currently available (name -> path, suggested relation):\n${dbtModels
          .slice(0, 300)
          .map((m) => {
            if (!hasWarehouseDefaults) {
              return `${m.name} -> ${m.relativePath}`;
            }
            const hintedSchema = inferSchemaHintFromModelPath(m.relativePath, snowflakeSchema.toUpperCase());
            return `${m.name} -> ${m.relativePath} -> "${snowflakeDatabase}"."${hintedSchema}".${quoteSqlIdent(m.name)}`;
          })
          .join("\n")}`
      },
      ...(selectedMemorySummaries.length > 0
        ? [
            {
              role: "system" as const,
              content: buildTenantMemorySystemMessage(selectedMemorySummaries)
            }
          ]
        : []),
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
        if (tenantMemories.length > 0) {
          this.store.markTenantMemoriesUsed(
            context.tenantId,
            tenantMemories.map((memory) => memory.id)
          );
        }
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
        return {
          text,
          artifacts,
          debug
        };
      };

      const loopMessages: LlmMessage[] = [];
      let finalPlan: z.infer<typeof toolDecisionSchema> | undefined;
      let finalSql: string | undefined;
      let lastSuccessfulQuery: { sql: string; result: QueryResult } | undefined;
      let latestChartArtifact: AgentArtifact | undefined;

      for (let step = 1; step <= maxToolSteps; step += 1) {
      const planRaw = await measure(`plannerMs_step${step}`, async () =>
        this.llm.generateText({
          model: llmModel,
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
        const text = plan.answer?.trim() ? plan.answer : "I need more details to answer that.";
        return finalizeSuccess(
          text,
          {
            plan,
            plannerAttempts,
            sql: finalSql,
            toolCalls,
            mode: "direct_tool_loop",
            userMessageId: userMessage.id,
            tenantMemoriesInjected: tenantMemories.map((memory) => ({
              id: memory.id,
              summary: memory.summary
            })),
            timings: { ...timings, totalMs: Date.now() - startedAt }
          },
          latestChartArtifact ? [latestChartArtifact] : undefined
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

        if (plan.tool === "snowflake.lookupMetadata") {
          const parsedLookup = metadataLookupSchema.safeParse(args);
          if (!parsedLookup.success) {
            throw new Error("snowflake.lookupMetadata requires valid lookup args.");
          }
          const metadataSql = buildMetadataLookupSql(
            parsedLookup.data,
            snowflakeDatabase,
            snowflakeSchema,
            profile.maxRowsPerQuery
          );
          if (!metadataSql) {
            throw new Error("Metadata lookup requires database context.");
          }
          const metadataResult = await runTool(
            "snowflake.lookupMetadata",
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
            content: `Tool result (snowflake.lookupMetadata): ${asJsonBlock({
              columns: metadataResult.columns,
              rowCount: metadataResult.rowCount,
              rows: metadataResult.rows.slice(0, profile.maxRowsPerQuery)
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
            throw new Error("No successful query result available yet. Run snowflake.query first.");
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
          latestChartArtifact = {
            type: "chartjs_config",
            format: "json",
            payload: chartBuild.config,
            summary: chartBuild.summary
          };
          loopMessages.push({
            role: "user",
            content: `Tool result (chartjs.build): ${asJsonBlock(chartBuild.summary)}`
          });
          continue;
        }

        if (plan.tool === "memory.create") {
          const parsedMemory = memoryCreateSchema.safeParse(args);
          if (!parsedMemory.success) {
            throw new Error("memory.create requires args.summary with 1-240 characters.");
          }
          const memory = await runTool(
            "memory.create",
            parsedMemory.data,
            async () =>
              this.store.createTenantMemory({
                tenantId: context.tenantId,
                summary: parsedMemory.data.summary,
                sourceConversationId: context.conversationId,
                sourceMessageId: userMessage.id
              }),
            (value) => ({ id: value.id, summary: value.summary, status: value.status }),
            (value) => value
          );
          loopMessages.push({
            role: "user",
            content: `Tool result (memory.create): ${asJsonBlock({
              id: memory.id,
              summary: memory.summary,
              status: memory.status
            })}`
          });
          continue;
        }

        if (plan.tool === "memory.list") {
          const parsedList = memoryListSchema.safeParse(args);
          if (!parsedList.success) {
            throw new Error("memory.list requires valid args.");
          }
          const memories = await runTool(
            "memory.list",
            { tenantId: context.tenantId, includeDeleted: parsedList.data.includeDeleted ?? false },
            async () =>
              this.store.listTenantMemories({
                tenantId: context.tenantId,
                includeDeleted: parsedList.data.includeDeleted ?? false,
                limit: 100
              }),
            (value) => ({ memoryCount: value.length }),
            (value) => ({
              memoryCount: value.length,
              memories: value.map((memory) => ({
                id: memory.id,
                summary: memory.summary,
                status: memory.status,
                updatedAt: memory.updatedAt
              }))
            })
          );
          loopMessages.push({
            role: "user",
            content: `Tool result (memory.list): ${asJsonBlock({
              memoryCount: memories.length,
              memories: memories.map((memory) => ({
                id: memory.id,
                summary: memory.summary,
                status: memory.status,
                updatedAt: memory.updatedAt
              }))
            })}`
          });
          continue;
        }

        if (plan.tool === "memory.update") {
          const parsedUpdate = memoryUpdateSchema.safeParse(args);
          if (!parsedUpdate.success) {
            throw new Error("memory.update requires args.id and args.summary.");
          }
          const updated = await runTool(
            "memory.update",
            parsedUpdate.data,
            async () => {
              const value = this.store.updateTenantMemory({
                id: parsedUpdate.data.id,
                tenantId: context.tenantId,
                summary: parsedUpdate.data.summary
              });
              if (!value) {
                throw new Error(`Tenant memory "${parsedUpdate.data.id}" was not found.`);
              }
              return value;
            },
            (value) => ({ id: value.id, summary: value.summary, status: value.status }),
            (value) => value
          );
          loopMessages.push({
            role: "user",
            content: `Tool result (memory.update): ${asJsonBlock({
              id: updated.id,
              summary: updated.summary,
              status: updated.status
            })}`
          });
          continue;
        }

        if (plan.tool === "memory.delete") {
          const parsedDelete = memoryDeleteSchema.safeParse(args);
          if (!parsedDelete.success) {
            throw new Error("memory.delete requires args.id.");
          }
          const deleted = await runTool(
            "memory.delete",
            parsedDelete.data,
            async () => {
              const value = this.store.deleteTenantMemory(parsedDelete.data.id, context.tenantId);
              if (!value) {
                throw new Error(`Tenant memory "${parsedDelete.data.id}" was not found.`);
              }
              return value;
            },
            (value) => ({ id: value.id, summary: value.summary, status: value.status }),
            (value) => value
          );
          loopMessages.push({
            role: "user",
            content: `Tool result (memory.delete): ${asJsonBlock({
              id: deleted.id,
              summary: deleted.summary,
              status: deleted.status
            })}`
          });
          continue;
        }

        if (plan.tool === "snowflake.query") {
          const sql = typeof args.sql === "string" ? args.sql.trim() : "";
          if (!sql) {
            throw new Error("snowflake.query requires args.sql.");
          }
          const normalizedSql = this.sqlGuard
            .normalize(sql)
            .replace(/\blimit\s+\d+\b/i, `LIMIT ${profile.maxRowsPerQuery}`);
          if (attemptedSql.has(normalizedSql)) {
            throw new Error("Duplicate SQL attempt in this turn. Generate a different query.");
          }
          attemptedSql.add(normalizedSql);
          finalSql = normalizedSql;
          const queryResult = await measure("snowflakeMs", async () =>
            runTool(
              "snowflake.query",
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
            content: `Tool result (snowflake.query): ${asJsonBlock({
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
          content: `Tool error (${plan.tool}): ${(error as Error).message}. Choose a corrected tool call or final_answer.`
        });
      }
      }

      if (lastSuccessfulQuery) {
        let text = "";
        try {
          text = await this.llm.generateText({
            model: llmModel,
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
            userMessageId: userMessage.id,
            tenantMemoriesInjected: tenantMemories.map((memory) => ({
              id: memory.id,
              summary: memory.summary
            })),
            timings: { ...timings, totalMs: Date.now() - startedAt },
            finalizedFromLastSuccessfulQuery: true
          },
          latestChartArtifact ? [latestChartArtifact] : undefined
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
          userMessageId: userMessage.id,
          tenantMemoriesInjected: tenantMemories.map((memory) => ({
            id: memory.id,
            summary: memory.summary
          })),
          timings: { ...timings, totalMs: Date.now() - startedAt }
        },
        latestChartArtifact ? [latestChartArtifact] : undefined
      );
    } catch (error) {
      this.store.completeExecutionTurn({
        turnId: executionTurn.id,
        status: "failed",
        errorMessage: (error as Error).message,
        debug: {
          plannerAttempts,
          toolCalls,
          userMessageId: userMessage.id,
          tenantMemoriesInjected: [],
          timings: { ...timings, totalMs: Date.now() - startedAt }
        }
      });
      throw error;
    }
  }
}
