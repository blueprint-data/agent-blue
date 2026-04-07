import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChartTool,
  DbtRepositoryService,
  LlmGenerateResult,
  LlmMessage,
  LlmProvider,
  LlmUsage,
  WarehouseAdapter
} from "./interfaces.js";
import { AnalyticsAgentRuntime, TENANT_MEMORY_MAX_PROMPT_ITEMS } from "./agentRuntime.js";
import { SqlGuard } from "./sqlGuard.js";
import { SqliteConversationStore } from "../adapters/store/sqliteConversationStore.js";

const tempPaths: string[] = [];

afterEach(() => {
  for (const targetPath of tempPaths.splice(0)) {
    try {
      fs.rmSync(path.dirname(targetPath), { recursive: true, force: true });
    } catch {
      // ignore cleanup failures in tests
    }
  }
});

function createStore(): SqliteConversationStore {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-blue-runtime-test-"));
  const dbPath = path.join(rootDir, "agent.db");
  tempPaths.push(dbPath);
  const store = new SqliteConversationStore(dbPath);
  store.init();
  return store;
}

class StubLlmProvider implements LlmProvider {
  readonly calls: Array<{ model: string; messages: LlmMessage[]; temperature?: number }> = [];

  constructor(
    private readonly responses: string[],
    private readonly usages?: Array<LlmUsage | undefined>
  ) {}

  async generateText(input: { model: string; messages: LlmMessage[]; temperature?: number }): Promise<LlmGenerateResult> {
    this.calls.push(input);
    const next = this.responses.shift();
    if (!next) {
      throw new Error("No stub LLM response remaining.");
    }
    const usage = this.usages?.shift();
    return { text: next, usage };
  }
}

const chartTool: ChartTool = {
  buildFromQueryResult() {
    throw new Error("Chart tool should not be called in these tests.");
  }
};

const dbtRepo: DbtRepositoryService = {
  async syncRepo() {
    // not used in tests
  },
  async listModels() {
    return [];
  },
  async getModelSql() {
    return null;
  }
};

const warehouse: WarehouseAdapter = {
  provider: "snowflake",
  async query() {
    throw new Error("Warehouse should not be called in these tests.");
  }
};

function createRuntime(llm: LlmProvider, store: SqliteConversationStore): AnalyticsAgentRuntime {
  return new AnalyticsAgentRuntime(
    llm,
    warehouse,
    chartTool,
    dbtRepo,
    store,
    new SqlGuard({
      enforceReadOnly: true,
      defaultLimit: 200,
      maxLimit: 2000
    })
  );
}

describe("AnalyticsAgentRuntime tenant memory", () => {
  it("saves tenant memory when the user explicitly asks to remember it", async () => {
    const store = createStore();
    const llm = new StubLlmProvider([
      JSON.stringify({
        type: "tool_call",
        tool: "tenantMemory.save",
        args: { content: "Fiscal week starts on Monday." }
      }),
      JSON.stringify({
        type: "final_answer",
        answer: "I'll remember that for future turns."
      })
    ]);
    const runtime = createRuntime(llm, store);

    const response = await runtime.respond(
      {
        tenantId: "acme",
        profileName: "default",
        conversationId: "conv_memory_save",
        llmModel: "test-model",
        origin: { source: "cli" }
      },
      "Remember that our fiscal week starts on Monday."
    );

    expect(response.text).toBe("I'll remember that for future turns.");
    expect(store.listTenantMemories("acme")).toEqual([
      expect.objectContaining({
        tenantId: "acme",
        content: "Fiscal week starts on Monday.",
        source: "agent"
      })
    ]);
    expect(response.debug?.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "tenantMemory.save",
          status: "ok"
        })
      ])
    );
  });

  it("rejects tenant memory saves when the user did not explicitly ask", async () => {
    const store = createStore();
    const llm = new StubLlmProvider([
      JSON.stringify({
        type: "tool_call",
        tool: "tenantMemory.save",
        args: { content: "Revenue should mean net revenue." }
      }),
      JSON.stringify({
        type: "final_answer",
        answer: "I did not save that as memory."
      })
    ]);
    const runtime = createRuntime(llm, store);

    const response = await runtime.respond(
      {
        tenantId: "acme",
        profileName: "default",
        conversationId: "conv_memory_reject",
        llmModel: "test-model",
        origin: { source: "cli" }
      },
      "What was revenue last month?"
    );

    expect(response.text).toBe("I did not save that as memory.");
    expect(store.listTenantMemories("acme")).toHaveLength(0);
    expect(llm.calls).toHaveLength(2);
    expect(
      llm.calls[1]?.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.includes("tenantMemory.save can only be used when the user explicitly asks")
      )
    ).toBe(true);
  });

  it("treats explicit Spanish save requests as valid tenant memory saves", async () => {
    const store = createStore();
    const llm = new StubLlmProvider([
      JSON.stringify({
        type: "tool_call",
        tool: "tenantMemory.save",
        args: { content: "TDV uses inflow transactions and excludes internal transaction types." }
      }),
      JSON.stringify({
        type: "final_answer",
        answer: "He guardado esa memoria para futuros turnos."
      })
    ]);
    const runtime = createRuntime(llm, store);

    const response = await runtime.respond(
      {
        tenantId: "acme",
        profileName: "default",
        conversationId: "conv_memory_save_es",
        llmModel: "test-model",
        origin: { source: "cli" }
      },
      "Guarda en memoria que el TDV usa inflow y excluye transaction_type internal."
    );

    expect(response.text).toBe("He guardado esa memoria para futuros turnos.");
    expect(store.listTenantMemories("acme")).toEqual([
      expect.objectContaining({
        tenantId: "acme",
        content: "TDV uses inflow transactions and excludes internal transaction types.",
        source: "agent"
      })
    ]);
  });

  it("does not accept final answers that claim memory was saved without a successful save tool result", async () => {
    const store = createStore();
    const llm = new StubLlmProvider([
      JSON.stringify({
        type: "final_answer",
        answer: "I'll remember that for future turns."
      }),
      JSON.stringify({
        type: "final_answer",
        answer: "I could not confirm that the tenant memory was saved, so treat it as not persisted."
      })
    ]);
    const runtime = createRuntime(llm, store);

    const response = await runtime.respond(
      {
        tenantId: "acme",
        profileName: "default",
        conversationId: "conv_memory_claim_guard",
        llmModel: "test-model",
        origin: { source: "cli" }
      },
      "Remember that our fiscal week starts on Monday."
    );

    expect(response.text).toBe("I could not confirm that the tenant memory was saved, so treat it as not persisted.");
    expect(store.listTenantMemories("acme")).toHaveLength(0);
    expect(llm.calls).toHaveLength(2);
    expect(
      llm.calls[1]?.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.includes("You claimed that tenant memory was saved")
      )
    ).toBe(true);
  });

  it("injects a bounded, deduplicated tenant memory block into the planner prompt", async () => {
    const store = createStore();
    const repeated = "Revenue means gross revenue unless the user explicitly asks for net revenue.";
    for (let index = 1; index <= 15; index += 1) {
      store.createTenantMemory({
        tenantId: "acme",
        content: `Memory ${index}: ${"x".repeat(180)}`,
        source: "agent"
      });
    }
    store.createTenantMemory({ tenantId: "acme", content: repeated, source: "manual" });
    store.createTenantMemory({ tenantId: "acme", content: repeated, source: "agent" });

    const llm = new StubLlmProvider([
      JSON.stringify({
        type: "final_answer",
        answer: "Using the saved tenant context."
      })
    ]);
    const runtime = createRuntime(llm, store);

    await runtime.respond(
      {
        tenantId: "acme",
        profileName: "default",
        conversationId: "conv_memory_injection",
        llmModel: "test-model",
        origin: { source: "cli" }
      },
      "What should revenue mean here?"
    );

    const memoryMessage = llm.calls[0]?.messages.find((message) =>
      message.content.startsWith("Tenant memory (user-saved facts, newest first):")
    );
    expect(memoryMessage).toBeDefined();
    const memoryLines = memoryMessage?.content.split("\n").filter((line) => line.startsWith("- ")) ?? [];
    expect(memoryLines.length).toBeLessThanOrEqual(TENANT_MEMORY_MAX_PROMPT_ITEMS);
    expect(memoryMessage?.content.length ?? 0).toBeLessThanOrEqual(2100);
    expect(
      memoryMessage?.content.match(/Revenue means gross revenue unless the user explicitly asks for net revenue\./g) ?? []
    ).toHaveLength(1);
  });
});

function seedTenantRepo(store: SqliteConversationStore, tenantId: string): void {
  store.upsertTenantRepo({
    tenantId,
    repoUrl: "git@github.com:example/repo.git",
    dbtSubpath: "models",
    deployKeyPath: "/tmp/key",
    localPath: `/tmp/repo/${tenantId}`
  });
}

describe("AnalyticsAgentRuntime LLM model and usage", () => {
  it("uses per-tenant LLM model when context omits llmModel", async () => {
    const store = createStore();
    seedTenantRepo(store, "acme");
    store.upsertTenantLlmSettings("acme", "openrouter/tenant-preferred");
    const llm = new StubLlmProvider([JSON.stringify({ type: "final_answer", answer: "ok" })]);
    const runtime = createRuntime(llm, store);

    await runtime.respond(
      {
        tenantId: "acme",
        profileName: "default",
        conversationId: "conv_tenant_model",
        origin: { source: "cli" }
      },
      "Hello"
    );

    expect(llm.calls[0]?.model).toBe("openrouter/tenant-preferred");
  });

  it("persists LLM usage events and exposes llmUsage in debug", async () => {
    const store = createStore();
    seedTenantRepo(store, "acme");
    const usage: LlmUsage = {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cost: 0.0042
    };
    const llm = new StubLlmProvider([JSON.stringify({ type: "final_answer", answer: "Done." })], [usage]);
    const runtime = createRuntime(llm, store);

    const response = await runtime.respond(
      {
        tenantId: "acme",
        profileName: "default",
        conversationId: "conv_usage",
        llmModel: "stub-model",
        origin: { source: "cli" }
      },
      "Run"
    );

    expect(response.text).toBe("Done.");
    const dbg = response.debug?.llmUsage as { totals: Record<string, number> } | undefined;
    expect(dbg?.totals?.totalTokens).toBe(120);
    expect(dbg?.totals?.totalCost).toBe(0.0042);

    const events = store.listTenantLlmUsageEvents("acme", { limit: 5 });
    expect(events).toHaveLength(1);
    expect(events[0]?.totalTokens).toBe(120);
    expect(events[0]?.cost).toBe(0.0042);
    expect(events[0]?.model).toBe("stub-model");
  });
});
