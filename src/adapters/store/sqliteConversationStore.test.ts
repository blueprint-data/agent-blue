import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteConversationStore } from "./sqliteConversationStore.js";

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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-blue-store-test-"));
  const dbPath = path.join(rootDir, "agent.db");
  tempPaths.push(dbPath);
  const store = new SqliteConversationStore(dbPath);
  store.init();
  return store;
}

describe("SqliteConversationStore admin telemetry", () => {
  it("stores tenant memories and keeps newest entries first", () => {
    const store = createStore();

    const first = store.createTenantMemory({
      tenantId: "acme",
      content: "Billing week starts on Monday.",
      source: "agent"
    });
    const second = store.createTenantMemory({
      tenantId: "acme",
      content: "Use gross revenue unless the user asks for net revenue.",
      source: "manual"
    });

    expect(store.listTenantMemories("acme")).toEqual([
      expect.objectContaining({
        id: second.id,
        tenantId: "acme",
        content: "Use gross revenue unless the user asks for net revenue.",
        source: "manual"
      }),
      expect.objectContaining({
        id: first.id,
        tenantId: "acme",
        content: "Billing week starts on Monday.",
        source: "agent"
      })
    ]);
  });

  it("prunes tenant memories to the newest 50 entries", () => {
    const store = createStore();

    for (let index = 1; index <= 55; index += 1) {
      store.createTenantMemory({
        tenantId: "acme",
        content: `memory-${index}`,
        source: "agent"
      });
    }

    const memories = store.listTenantMemories("acme", 100);
    expect(memories).toHaveLength(50);
    expect(memories.some((memory) => memory.content === "memory-1")).toBe(false);
    expect(memories.some((memory) => memory.content === "memory-2")).toBe(false);
    expect(memories.some((memory) => memory.content === "memory-3")).toBe(false);
    expect(memories.some((memory) => memory.content === "memory-4")).toBe(false);
    expect(memories.some((memory) => memory.content === "memory-5")).toBe(false);
    expect(memories[0]?.content).toBe("memory-55");
  });

  it("deletes tenant memories when deleting a tenant", () => {
    const store = createStore();

    store.createTenantMemory({
      tenantId: "acme",
      content: "This tenant prefers UTC dates.",
      source: "agent"
    });
    store.createTenantMemory({
      tenantId: "other",
      content: "Keep this other tenant memory.",
      source: "agent"
    });

    store.deleteTenant("acme");

    expect(store.listTenantMemories("acme")).toHaveLength(0);
    expect(store.listTenantMemories("other")).toEqual([
      expect.objectContaining({
        tenantId: "other",
        content: "Keep this other tenant memory."
      })
    ]);
  });

  it("looks up tenant memories by tenant and id", () => {
    const store = createStore();

    const memory = store.createTenantMemory({
      tenantId: "acme",
      content: "Use fiscal month naming in admin reports.",
      source: "manual"
    });

    expect(store.getTenantMemory("acme", memory.id)).toEqual(
      expect.objectContaining({
        id: memory.id,
        tenantId: "acme",
        content: "Use fiscal month naming in admin reports.",
        source: "manual"
      })
    );
    expect(store.getTenantMemory("other", memory.id)).toBeNull();
    expect(store.getTenantMemory("acme", "missing")).toBeNull();
  });

  it("stores conversation origin and execution telemetry", () => {
    const store = createStore();

    store.createConversation({
      tenantId: "acme",
      profileName: "default",
      conversationId: "conv_1"
    });
    store.upsertConversationOrigin("conv_1", "acme", {
      source: "slack",
      teamId: "T123",
      channelId: "C123",
      threadTs: "171.1",
      userId: "U123"
    });
    store.addMessage({
      tenantId: "acme",
      conversationId: "conv_1",
      role: "user",
      content: "raw slack message"
    });
    store.addMessage({
      tenantId: "acme",
      conversationId: "conv_1",
      role: "assistant",
      content: "assistant reply"
    });
    const turn = store.createExecutionTurn({
      tenantId: "acme",
      conversationId: "conv_1",
      source: "slack",
      rawUserText: "raw slack message",
      promptText: "Formatting rules for this response:\nCurrent message: raw slack message",
      status: "running"
    });
    store.completeExecutionTurn({
      turnId: turn.id,
      status: "completed",
      assistantText: "assistant reply",
      debug: {
        toolCalls: [],
        timings: {
          totalMs: 10
        }
      }
    });

    const conversations = store.listAdminConversations({ limit: 10 });
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      conversationId: "conv_1",
      tenantId: "acme",
      source: "slack",
      latestTurnStatus: "completed",
      latestUserText: "raw slack message",
      latestAssistantText: "assistant reply"
    });

    const detail = store.getAdminConversationDetail("conv_1");
    expect(detail).not.toBeNull();
    expect(detail?.messages).toHaveLength(2);
    expect(detail?.executionTurns).toHaveLength(1);
    expect(detail?.executionTurns[0]).toMatchObject({
      rawUserText: "raw slack message",
      promptText: "Formatting rules for this response:\nCurrent message: raw slack message",
      status: "completed"
    });
    expect(detail?.summary.channelId).toBe("C123");
  });

  it("stores bot state and events", () => {
    const store = createStore();

    const state = store.upsertAdminBotState({
      botName: "slack",
      desiredState: "running",
      actualState: "running",
      port: 3000,
      lastStartedAt: "2026-03-10T10:00:00.000Z",
      lastStoppedAt: undefined,
      lastErrorAt: undefined,
      lastErrorMessage: undefined
    });
    const event = store.appendAdminBotEvent({
      botName: "slack",
      level: "info",
      eventType: "bot.started",
      message: "Slack bot started",
      metadata: { port: 3000 }
    });

    expect(state.actualState).toBe("running");
    expect(store.getAdminBotState("slack")).toMatchObject({
      desiredState: "running",
      actualState: "running",
      port: 3000
    });
    expect(store.listAdminBotEvents("slack", 10)).toEqual([
      expect.objectContaining({
        id: event.id,
        eventType: "bot.started",
        message: "Slack bot started",
        metadata: { port: 3000 }
      })
    ]);
  });

  it("rebuilds tenant_memories when legacy NOT NULL summary column exists", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-blue-store-legacy-sum-"));
    const dbPath = path.join(rootDir, "agent.db");
    tempPaths.push(dbPath);
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE tenant_memories (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO tenant_memories (id, tenant_id, summary, source, created_at, updated_at)
      VALUES ('m1', 'acme', 'Revenue is net of refunds', 'manual', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
    `);
    raw.close();

    const store = new SqliteConversationStore(dbPath);
    store.init();

    expect(store.listTenantMemories("acme")).toEqual([
      expect.objectContaining({
        id: "m1",
        tenantId: "acme",
        content: "Revenue is net of refunds",
        source: "manual"
      })
    ]);

    const added = store.createTenantMemory({
      tenantId: "acme",
      content: "New fact from UI",
      source: "manual"
    });
    expect(added.content).toBe("New fact from UI");
    expect(store.listTenantMemories("acme", 10).some((m) => m.content === "New fact from UI")).toBe(true);
  });

  it("migrates tenant_memories when legacy column is named body", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-blue-store-legacy-mem-"));
    const dbPath = path.join(rootDir, "agent.db");
    tempPaths.push(dbPath);
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE tenant_memories (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        body TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO tenant_memories (id, tenant_id, body, source, created_at, updated_at)
      VALUES ('m1', 'acme', 'persisted fact', 'manual', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
    `);
    raw.close();

    const store = new SqliteConversationStore(dbPath);
    store.init();

    expect(store.listTenantMemories("acme")).toEqual([
      expect.objectContaining({
        id: "m1",
        tenantId: "acme",
        content: "persisted fact",
        source: "manual"
      })
    ]);
  });

  it("migrates messages when legacy column is named body", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-blue-store-legacy-msg-"));
    const dbPath = path.join(rootDir, "agent.db");
    tempPaths.push(dbPath);
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO messages (id, tenant_id, conversation_id, role, body, created_at)
      VALUES ('msg1', 'acme', 'conv1', 'user', 'user said hi', '2020-01-01T00:00:00Z');
    `);
    raw.close();

    const store = new SqliteConversationStore(dbPath);
    store.init();

    expect(store.getMessages("conv1")).toEqual([
      expect.objectContaining({
        id: "msg1",
        tenantId: "acme",
        conversationId: "conv1",
        role: "user",
        content: "user said hi"
      })
    ]);
  });
});

describe("SqliteConversationStore admin login domains", () => {
  function seedTenant(store: SqliteConversationStore, tenantId: string): void {
    store.upsertTenantRepo({
      tenantId,
      repoUrl: "https://github.com/example/repo",
      dbtSubpath: "models",
      deployKeyPath: "/keys/x",
      localPath: "/repos/x"
    });
  }

  it("stores domains per tenant and exposes a flat map", () => {
    const store = createStore();
    seedTenant(store, "acme");
    seedTenant(store, "other");
    store.setAdminLoginDomainsForTenant("acme", ["Takenos.COM", " acme.org "]);
    expect(store.listAdminLoginDomainsForTenant("acme")).toEqual(["acme.org", "takenos.com"]);
    expect(store.getAdminLoginDomainTenantMap()).toEqual({
      "acme.org": "acme",
      "takenos.com": "acme"
    });
  });

  it("replaces domains for a tenant and rejects cross-tenant conflicts", () => {
    const store = createStore();
    seedTenant(store, "a");
    seedTenant(store, "b");
    store.setAdminLoginDomainsForTenant("a", ["shared.com"]);
    expect(() => store.setAdminLoginDomainsForTenant("b", ["shared.com"])).toThrow(/already mapped/);
    store.setAdminLoginDomainsForTenant("a", ["other.net"]);
    expect(store.listAdminLoginDomainsForTenant("a")).toEqual(["other.net"]);
    expect(store.getAdminLoginDomainTenantMap()).toEqual({ "other.net": "a" });
  });

  it("removes login domains when tenant is deleted", () => {
    const store = createStore();
    seedTenant(store, "gone");
    store.setAdminLoginDomainsForTenant("gone", ["x.com"]);
    store.deleteTenant("gone");
    expect(store.getAdminLoginDomainTenantMap()).toEqual({});
  });
});
