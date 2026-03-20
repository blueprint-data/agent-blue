import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChartTool,
  DbtRepositoryService,
  LlmMessage,
  LlmProvider,
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

  constructor(private readonly responses: string[]) {}

  async generateText(input: { model: string; messages: LlmMessage[]; temperature?: number }): Promise<string> {
    this.calls.push(input);
    const next = this.responses.shift();
    if (!next) {
      throw new Error("No stub LLM response remaining.");
    }
    return next;
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
