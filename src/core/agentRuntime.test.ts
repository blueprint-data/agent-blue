import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteConversationStore } from "../adapters/store/sqliteConversationStore.js";
import { AnalyticsAgentRuntime } from "./agentRuntime.js";
import { SqlGuard } from "./sqlGuard.js";
import type {
  ChartBuildResult,
  ChartBuildRequest,
  ChartTool,
  DbtRepositoryService,
  LlmMessage,
  LlmProvider,
  WarehouseAdapter
} from "./interfaces.js";

class CapturingLlm implements LlmProvider {
  public calls: Array<{ model: string; messages: LlmMessage[]; temperature?: number }> = [];
  private readonly responses: string[];

  constructor(
    responses: string[] = [
      JSON.stringify({
        type: "final_answer",
        answer: "Tenant memory acknowledged."
      })
    ]
  ) {
    this.responses = responses;
  }

  async generateText(input: { model: string; messages: LlmMessage[]; temperature?: number }): Promise<string> {
    this.calls.push(input);
    return this.responses.shift() ?? this.responses[this.responses.length - 1] ?? '{"type":"final_answer","answer":"OK"}';
  }
}

class NoopWarehouse implements WarehouseAdapter {
  async query(
    _sql: string,
    _opts?: { timeoutMs?: number }
  ): Promise<{ columns: string[]; rows: Record<string, unknown>[]; rowCount: number }> {
    return { columns: [], rows: [], rowCount: 0 };
  }
}

class NoopChartTool implements ChartTool {
  buildFromQueryResult(_input: {
    request: ChartBuildRequest;
    result: { columns: string[]; rows: Record<string, unknown>[]; rowCount: number };
    maxPoints: number;
  }): ChartBuildResult {
    return {
      config: {},
      summary: {
        type: "bar",
        xKey: null,
        yKey: null,
        seriesKey: null,
        labelsCount: 0,
        datasetsCount: 0,
        pointsCount: 0
      }
    };
  }
}

class NoopDbtRepo implements DbtRepositoryService {
  async syncRepo(_tenantId: string): Promise<void> {}
  async listModels(_tenantId: string, _dbtSubpath?: string): Promise<Array<{ name: string; relativePath: string }>> {
    return [];
  }
  async getModelSql(_tenantId: string, _modelName: string, _dbtSubpath?: string): Promise<string | null> {
    return null;
  }
}

function createStore(): SqliteConversationStore {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-blue-runtime-test-"));
  const dbPath = path.join(rootDir, "agent.db");
  const store = new SqliteConversationStore(dbPath);
  store.init();
  return store;
}

describe("AnalyticsAgentRuntime tenant memory injection", () => {
  it("injects tenant memories into prompt assembly and records them in debug", async () => {
    const store = createStore();
    store.createTenantMemory({
      tenantId: "acme",
      summary: "TDV means total demand value net of refunds"
    });

    const llm = new CapturingLlm();
    const runtime = new AnalyticsAgentRuntime(
      llm,
      new NoopWarehouse(),
      new NoopChartTool(),
      new NoopDbtRepo(),
      store,
      new SqlGuard({
        enforceReadOnly: true,
        defaultLimit: 200,
        maxLimit: 2000
      })
    );

    const response = await runtime.respond(
      {
        tenantId: "acme",
        profileName: "default",
        conversationId: "conv_1",
        origin: { source: "cli" }
      },
      "How do we define TDV?"
    );

    expect(response.text).toBe("Tenant memory acknowledged.");
    expect(response.debug?.tenantMemoriesInjected).toEqual([
      expect.objectContaining({
        summary: "TDV means total demand value net of refunds"
      })
    ]);
    expect(llm.calls[0]?.messages.some((message) => message.content.includes("Tenant memory"))).toBe(true);
    expect(
      llm.calls[0]?.messages.some((message) => message.content.includes("TDV means total demand value net of refunds"))
    ).toBe(true);
  });

  it("supports tenant memory tool calls through the planner loop", async () => {
    const store = createStore();
    const llm = new CapturingLlm([
      JSON.stringify({
        type: "tool_call",
        tool: "memory.create",
        args: {
          summary: "TDV excludes refunds"
        }
      }),
      JSON.stringify({
        type: "final_answer",
        answer: "Listo. Guarde esa memoria compartida para este tenant."
      })
    ]);
    const runtime = new AnalyticsAgentRuntime(
      llm,
      new NoopWarehouse(),
      new NoopChartTool(),
      new NoopDbtRepo(),
      store,
      new SqlGuard({
        enforceReadOnly: true,
        defaultLimit: 200,
        maxLimit: 2000
      })
    );

    const response = await runtime.respond(
      {
        tenantId: "acme",
        profileName: "default",
        conversationId: "conv_memory_create",
        origin: { source: "slack" }
      },
      "Recuerda que el TDV excluye reembolsos"
    );

    expect(response.text).toContain("Guarde esa memoria");
    expect(store.listTenantMemories({ tenantId: "acme" })).toEqual([
      expect.objectContaining({
        summary: "TDV excludes refunds"
      })
    ]);
    expect(response.debug?.toolCalls).toEqual(
      expect.arrayContaining([
      expect.objectContaining({
        tool: "memory.create",
        status: "ok"
      })
      ])
    );
    expect(
      llm.calls[0]?.messages.some((message) =>
        message.content.includes("Users may ask for tenant memory operations in any language")
      )
    ).toBe(true);
  });
});
