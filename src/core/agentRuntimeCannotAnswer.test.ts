/**
 * Tests for the cannot_answer decision type.
 * Uses a minimal mock ConversationStore to avoid the better-sqlite3 dependency.
 */
import { describe, expect, it } from "vitest";
import type {
  ChartTool,
  ConversationStore,
  DbtRepositoryService,
  LlmGenerateResult,
  LlmMessage,
  LlmProvider,
  LlmUsage,
  WarehouseAdapter
} from "./interfaces.js";
import type {
  AdminBotEvent,
  AdminBotState,
  AdminConversationDetail,
  AdminConversationSummary,
  AgentContext,
  AgentExecutionTurn,
  AgentProfile,
  ConversationMessage,
  ConversationOrigin,
  ConversationSource,
  MessageFeedback,
  ScheduleChannelType,
  TenantMemory,
  TenantMemorySource,
  TenantSchedule
} from "./types.js";
import type {
  AdminGuardrails,
  AdminSession,
  InsertLlmUsageEventInput,
  LlmUsageEventRow,
  TenantChannelBotSecrets,
  TenantCredentialsRef,
  TenantIntegrationToken,
  TenantIntegrationTokenScope,
  TenantKeyMetadata,
  TenantLlmSettings,
  TenantLlmUsageSummary,
  TenantWarehouseConfig
} from "./interfaces.js";
import { AnalyticsAgentRuntime } from "./agentRuntime.js";
import { SqlGuard } from "./sqlGuard.js";

// ─── Minimal Mock Store ───────────────────────────────────────────────────────

function createMockStore(): ConversationStore {
  const messages: ConversationMessage[] = [];
  const memories: TenantMemory[] = [];
  const turns: AgentExecutionTurn[] = [];
  let turnIdSeq = 0;

  return {
    init() {},
    createConversation() {},
    addMessage(msg) {
      const m: ConversationMessage = { ...msg, id: `msg_${Date.now()}`, createdAt: new Date().toISOString() };
      messages.push(m);
      return m;
    },
    getMessages() { return messages; },
    listTenantMemories() { return memories; },
    getTenantMemory() { return null; },
    createTenantMemory(input) {
      const m: TenantMemory = {
        id: `mem_${Date.now()}`,
        tenantId: input.tenantId,
        content: input.content,
        source: input.source,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      memories.push(m);
      return m;
    },
    deleteTenantMemory() {},
    getOrCreateProfile(tenantId, profileName) {
      return {
        id: `profile_${profileName}`,
        tenantId,
        name: profileName,
        soulPrompt: "You are a test agent.",
        maxRowsPerQuery: 100,
        allowedDbtPathPrefixes: [],
        createdAt: new Date().toISOString()
      };
    },
    listProfiles() { return []; },
    upsertProfile(input) {
      return {
        id: `profile_${input.name}`,
        tenantId: input.tenantId,
        name: input.name,
        soulPrompt: input.soulPrompt,
        maxRowsPerQuery: input.maxRowsPerQuery,
        allowedDbtPathPrefixes: input.allowedDbtPathPrefixes,
        createdAt: new Date().toISOString()
      };
    },
    upsertTenantRepo() {},
    getTenantRepo() { return null; },
    getSlackChannelTenant() { return null; },
    upsertSlackChannelTenant() {},
    getSlackUserTenant() { return null; },
    upsertSlackUserTenant() {},
    getSlackSharedTeamTenant() { return null; },
    upsertSlackSharedTeamTenant() {},
    listSlackChannelMappings() { return []; },
    listSlackUserMappings() { return []; },
    listSlackSharedTeamMappings() { return []; },
    tryMarkSlackEventProcessed() { return true; },
    getTelegramChatTenant() { return null; },
    upsertTelegramChatTenant() {},
    listTelegramChatMappings() { return []; },
    deleteTelegramChatMapping() {},
    listTenants() { return []; },
    deleteTenant() {},
    deleteSlackChannelMapping() {},
    deleteSlackUserMapping() {},
    deleteSlackSharedTeamMapping() {},
    getGuardrails() { return null; },
    upsertGuardrails() {},
    getTenantCredentialsRef() { return null; },
    upsertTenantCredentialsRef() {},
    getTenantWarehouseConfig() { return null; },
    upsertTenantWarehouseConfig() {},
    getTenantKeyMetadata() { return null; },
    upsertTenantKeyMetadata() {},
    deleteTenantKeyMetadata() {},
    upsertConversationOrigin() {},
    getConversationOrigin() { return null; },
    createExecutionTurn(input) {
      turnIdSeq += 1;
      const turn: AgentExecutionTurn = {
        ...input,
        id: `turn_${turnIdSeq}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      turns.push(turn);
      return turn;
    },
    completeExecutionTurn(input) {
      const turn = turns.find((t) => t.id === input.turnId);
      if (turn) {
        turn.status = input.status;
        turn.assistantText = input.assistantText;
        turn.errorMessage = input.errorMessage;
        turn.debug = input.debug;
        turn.updatedAt = new Date().toISOString();
      }
    },
    getExecutionTurn(turnId) { return turns.find((t) => t.id === turnId) ?? null; },
    listExecutionTurns() { return turns; },
    listAdminConversations() { return []; },
    getAdminConversationDetail() { return null; },
    getAdminBotState() { return null; },
    upsertAdminBotState(input) {
      return { ...input, updatedAt: new Date().toISOString() };
    },
    appendAdminBotEvent(input) {
      return { ...input, id: `evt_${Date.now()}`, createdAt: new Date().toISOString() };
    },
    listAdminBotEvents() { return []; },
    createAdminSession() {},
    getAdminSession() { return null; },
    touchAdminSession() {},
    deleteAdminSession() {},
    deleteExpiredAdminSessions() { return 0; },
    getAdminLoginDomainTenantMap() { return {}; },
    listAdminLoginDomainsForTenant() { return []; },
    setAdminLoginDomainsForTenant() {},
    listTenantSchedules() { return []; },
    getTenantSchedule() { return null; },
    createTenantSchedule(input) {
      return {
        id: `sched_${Date.now()}`,
        tenantId: input.tenantId,
        userRequest: input.userRequest,
        cron: input.cron ?? "0 9 * * *",
        channelType: (input.channelType ?? "console") as ScheduleChannelType,
        channelRef: input.channelRef ?? null,
        active: input.active ?? true,
        lastRunAt: null,
        lastError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    },
    updateTenantSchedule() { return null; },
    deleteTenantSchedule() {},
    getTenantChannelBotSecrets() { return null; },
    upsertTenantChannelBotSecrets() {},
    listTenantTelegramBotOverrides() { return []; },
    listTenantIntegrationTokens() { return []; },
    createTenantIntegrationToken(input) {
      return {
        id: input.tokenId,
        tenantId: input.tenantId,
        name: input.name ?? undefined,
        scope: input.scope,
        tokenPrefix: input.tokenPrefix,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date().toISOString()
      };
    },
    revokeTenantIntegrationToken() { return null; },
    getTenantIntegrationTokenAuthRecord() { return null; },
    getTenantIntegrationTokenAuthRecordByTokenId() { return null; },
    touchTenantIntegrationTokenLastUsed() {},
    getTenantLlmSettings() { return null; },
    upsertTenantLlmSettings(tenantId, llmModel) {
      return { tenantId, llmModel, updatedAt: new Date().toISOString() };
    },
    insertLlmUsageEvent() {},
    getTenantLlmUsageSummary() {
      return { requestCount: 0, totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0, totalCost: 0 };
    },
    listTenantLlmUsageEvents() { return []; },
    saveMessageFeedback(input) {
      return {
        id: `feedback_${Date.now()}`,
        ...input,
        createdAt: new Date().toISOString()
      };
    }
  };
}

// ─── Stub LLM ─────────────────────────────────────────────────────────────────

class StubLlmProvider implements LlmProvider {
  readonly calls: Array<{ model: string; messages: LlmMessage[]; temperature?: number }> = [];

  constructor(private readonly responses: string[]) {}

  async generateText(input: { model: string; messages: LlmMessage[]; temperature?: number }): Promise<LlmGenerateResult> {
    this.calls.push(input);
    const next = this.responses.shift();
    if (!next) throw new Error("No stub LLM response remaining.");
    return { text: next };
  }
}

const chartTool: ChartTool = {
  buildFromQueryResult() {
    throw new Error("Chart tool should not be called in these tests.");
  }
};

const dbtRepo: DbtRepositoryService = {
  async syncRepo() {},
  async listModels() { return []; },
  async getModelSql() { return null; }
};

const warehouse: WarehouseAdapter = {
  provider: "snowflake",
  async query() {
    return { columns: ["result"], rows: [{ result: 42 }], rowCount: 1 };
  }
};

function createRuntime(llm: LlmProvider): AnalyticsAgentRuntime {
  return new AnalyticsAgentRuntime(
    llm,
    warehouse,
    chartTool,
    dbtRepo,
    createMockStore(),
    new SqlGuard({ enforceReadOnly: true, defaultLimit: 200, maxLimit: 2000 })
  );
}

const ctx: AgentContext = {
  tenantId: "test-tenant",
  profileName: "default",
  conversationId: "conv_cannot_answer_test",
  llmModel: "test-model",
  origin: { source: "cli" }
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AnalyticsAgentRuntime cannot_answer", () => {
  it("returns reason text when LLM declares cannot_answer with a reason", async () => {
    const llm = new StubLlmProvider([
      JSON.stringify({ type: "cannot_answer", reason: "No sales data exists for the requested period" })
    ]);
    const runtime = createRuntime(llm);

    const response = await runtime.respond(ctx, "What were sales last quarter?");

    expect(response.text).toContain("No sales data exists for the requested period");
    expect(response.debug?.outcome).toBe("cannot_answer");
  });

  it("returns fallback text when LLM declares cannot_answer without a reason", async () => {
    const llm = new StubLlmProvider([
      JSON.stringify({ type: "cannot_answer" })
    ]);
    const runtime = createRuntime(llm);

    const response = await runtime.respond(
      { ...ctx, conversationId: "conv_cannot_answer_no_reason" },
      "What were sales last quarter?"
    );

    expect(response.text).toBe("I could not answer this reliably with the available data and tools.");
    expect(response.debug?.outcome).toBe("cannot_answer");
  });

  it("returns fallback text when LLM declares cannot_answer with whitespace-only reason", async () => {
    const llm = new StubLlmProvider([
      JSON.stringify({ type: "cannot_answer", reason: "   " })
    ]);
    const runtime = createRuntime(llm);

    const response = await runtime.respond(
      { ...ctx, conversationId: "conv_cannot_answer_ws_reason" },
      "What were sales last quarter?"
    );

    expect(response.text).toBe("I could not answer this reliably with the available data and tools.");
    expect(response.debug?.outcome).toBe("cannot_answer");
  });

  it("does not throw when LLM returns cannot_answer — turn is completed, not failed", async () => {
    const llm = new StubLlmProvider([
      JSON.stringify({ type: "cannot_answer", reason: "No relevant tables found" })
    ]);
    const runtime = createRuntime(llm);

    // If this throws, the test fails — cannot_answer must NOT route through catch/failed path
    await expect(
      runtime.respond(
        { ...ctx, conversationId: "conv_cannot_answer_no_throw" },
        "What were sales last quarter?"
      )
    ).resolves.toBeDefined();
  });

  it("records plannerAttempts when LLM returns cannot_answer after 2 tool steps", async () => {
    // Step 1: tool_call (warehouse.query)
    // Step 2: tool_call (warehouse.query) — second attempt
    // Step 3: cannot_answer
    const llm = new StubLlmProvider([
      JSON.stringify({ type: "tool_call", tool: "warehouse.query", args: { sql: "SELECT * FROM sales" } }),
      JSON.stringify({ type: "tool_call", tool: "warehouse.query", args: { sql: "SELECT COUNT(*) FROM revenue" } }),
      JSON.stringify({ type: "cannot_answer", reason: "No relevant tables found after multiple attempts" })
    ]);
    const runtime = createRuntime(llm);

    const response = await runtime.respond(
      { ...ctx, conversationId: "conv_cannot_answer_after_tools" },
      "What were sales last quarter?"
    );

    expect(response.text).toContain("No relevant tables found after multiple attempts");
    expect(response.debug?.outcome).toBe("cannot_answer");
    const attempts = response.debug?.plannerAttempts as unknown[];
    expect(attempts).toHaveLength(3);
  });

  it("existing final_answer still works correctly after cannot_answer addition", async () => {
    const llm = new StubLlmProvider([
      JSON.stringify({ type: "final_answer", answer: "Sales were $1M last quarter." })
    ]);
    const runtime = createRuntime(llm);

    const response = await runtime.respond(
      { ...ctx, conversationId: "conv_final_answer_regression" },
      "What were sales last quarter?"
    );

    expect(response.text).toBe("Sales were $1M last quarter.");
    expect(response.debug?.outcome).toBeUndefined();
  });

  it("existing tool_call schema still parses correctly", async () => {
    const llm = new StubLlmProvider([
      JSON.stringify({ type: "tool_call", tool: "warehouse.query", args: { sql: "SELECT 1 AS test" } }),
      JSON.stringify({ type: "final_answer", answer: "Query succeeded." })
    ]);
    const runtime = createRuntime(llm);

    const response = await runtime.respond(
      { ...ctx, conversationId: "conv_tool_call_regression" },
      "Run a test query."
    );

    expect(response.text).toBe("Query succeeded.");
  });
});
