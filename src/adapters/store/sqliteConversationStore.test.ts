import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteConversationStore, DEFAULT_SOUL_PROMPT } from "./sqliteConversationStore.js";

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

describe("SqliteConversationStore integration token auth lookups", () => {
  function seedTenant(store: SqliteConversationStore, tenantId: string): void {
    store.upsertTenantRepo({
      tenantId,
      repoUrl: "https://github.com/example/repo",
      dbtSubpath: "models",
      deployKeyPath: "/keys/x",
      localPath: "/repos/x"
    });
  }

  it("looks up auth record by token id without tenant input", () => {
    const store = createStore();
    seedTenant(store, "acme");

    store.createTenantIntegrationToken({
      tokenId: "itok_acme_1",
      tenantId: "acme",
      scope: "repo_refresh",
      tokenPrefix: "abt_rt_itok_acme",
      secretHash: "hash_acme_1"
    });

    expect(store.getTenantIntegrationTokenAuthRecordByTokenId({ tokenId: "itok_acme_1", scope: "repo_refresh" })).toEqual(
      expect.objectContaining({
        id: "itok_acme_1",
        tenantId: "acme",
        scope: "repo_refresh",
        secretHash: "hash_acme_1",
        revokedAt: null
      })
    );
  });

  it("returns null for unknown token id", () => {
    const store = createStore();
    expect(store.getTenantIntegrationTokenAuthRecordByTokenId({ tokenId: "missing", scope: "repo_refresh" })).toBeNull();
  });

  it("returns revoked records so API can reject them", () => {
    const store = createStore();
    seedTenant(store, "acme");

    store.createTenantIntegrationToken({
      tokenId: "itok_acme_2",
      tenantId: "acme",
      scope: "repo_refresh",
      tokenPrefix: "abt_rt_itok_acme",
      secretHash: "hash_acme_2"
    });
    store.revokeTenantIntegrationToken("acme", "itok_acme_2");

    const record = store.getTenantIntegrationTokenAuthRecordByTokenId({ tokenId: "itok_acme_2", scope: "repo_refresh" });
    expect(record).toEqual(
      expect.objectContaining({
        id: "itok_acme_2",
        tenantId: "acme",
        revokedAt: expect.any(String)
      })
    );
  });
});

describe("SqliteConversationStore agent profiles", () => {
  it("creates a profile with defaults on first access", () => {
    const store = createStore();
    const profile = store.getOrCreateProfile("acme", "default");

    expect(profile.tenantId).toBe("acme");
    expect(profile.name).toBe("default");
    expect(profile.soulPrompt).toBe(DEFAULT_SOUL_PROMPT);
    expect(profile.maxRowsPerQuery).toBe(200);
    expect(profile.allowedDbtPathPrefixes).toEqual(["models"]);
    expect(profile.id).toBeTruthy();
    expect(profile.createdAt).toBeTruthy();
  });

  it("returns the same profile on repeated access without creating duplicates", () => {
    const store = createStore();
    const first = store.getOrCreateProfile("acme", "default");
    const second = store.getOrCreateProfile("acme", "default");

    expect(second.id).toBe(first.id);
    expect(store.listProfiles("acme")).toHaveLength(1);
  });

  it("lists only profiles belonging to the requested tenant", () => {
    const store = createStore();
    store.getOrCreateProfile("acme", "default");
    store.getOrCreateProfile("other", "default");

    expect(store.listProfiles("acme")).toHaveLength(1);
    expect(store.listProfiles("acme")[0]?.tenantId).toBe("acme");
    expect(store.listProfiles("other")).toHaveLength(1);
  });

  it("upserts soul prompt, maxRowsPerQuery and allowedDbtPathPrefixes", () => {
    const store = createStore();
    store.getOrCreateProfile("acme", "default");

    const updated = store.upsertProfile({
      tenantId: "acme",
      name: "default",
      soulPrompt: "Custom prompt.",
      maxRowsPerQuery: 50,
      allowedDbtPathPrefixes: ["models/marts", "models/staging"]
    });

    expect(updated.soulPrompt).toBe("Custom prompt.");
    expect(updated.maxRowsPerQuery).toBe(50);
    expect(updated.allowedDbtPathPrefixes).toEqual(["models/marts", "models/staging"]);

    const reloaded = store.getOrCreateProfile("acme", "default");
    expect(reloaded.soulPrompt).toBe("Custom prompt.");
    expect(reloaded.maxRowsPerQuery).toBe(50);
  });

  it("does not affect other tenants when upserting a profile", () => {
    const store = createStore();
    store.getOrCreateProfile("acme", "default");
    store.getOrCreateProfile("other", "default");

    store.upsertProfile({
      tenantId: "acme",
      name: "default",
      soulPrompt: "Acme-only prompt.",
      maxRowsPerQuery: 10,
      allowedDbtPathPrefixes: ["models"]
    });

    const otherProfile = store.getOrCreateProfile("other", "default");
    expect(otherProfile.soulPrompt).toBe(DEFAULT_SOUL_PROMPT);
  });
});

describe("SqliteConversationStore LLM settings and usage", () => {
  function seedTenant(store: SqliteConversationStore, tenantId: string): void {
    store.upsertTenantRepo({
      tenantId,
      repoUrl: "https://github.com/example/repo",
      dbtSubpath: "models",
      deployKeyPath: "/keys/x",
      localPath: "/repos/x"
    });
  }

  it("upserts and reads tenant LLM settings", () => {
    const store = createStore();
    seedTenant(store, "acme");
    expect(store.getTenantLlmSettings("acme")).toBeNull();
    const row = store.upsertTenantLlmSettings("acme", "openai/gpt-4o-mini");
    expect(row.llmModel).toBe("openai/gpt-4o-mini");
    expect(store.getTenantLlmSettings("acme")?.llmModel).toBe("openai/gpt-4o-mini");
    store.upsertTenantLlmSettings("acme", null);
    expect(store.getTenantLlmSettings("acme")?.llmModel).toBeNull();
  });

  it("aggregates usage summary and filters by date range", () => {
    const store = createStore();
    seedTenant(store, "acme");
    store.insertLlmUsageEvent({
      tenantId: "acme",
      executionTurnId: "turn1",
      conversationId: "c1",
      model: "m1",
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      cost: 0.1,
      callIndex: 0
    });
    store.insertLlmUsageEvent({
      tenantId: "acme",
      executionTurnId: "turn2",
      conversationId: "c2",
      model: "m2",
      promptTokens: 4,
      completionTokens: 5,
      totalTokens: 9,
      cost: 0.2,
      callIndex: 0
    });
    const all = store.getTenantLlmUsageSummary("acme");
    expect(all.requestCount).toBe(2);
    expect(all.totalTokens).toBe(12);
    expect(all.totalCost).toBeCloseTo(0.3, 5);
    const from = new Date(Date.now() + 86_400_000).toISOString();
    const empty = store.getTenantLlmUsageSummary("acme", { fromIso: from });
    expect(empty.requestCount).toBe(0);
  });

  it("deletes LLM rows when tenant is deleted", () => {
    const store = createStore();
    seedTenant(store, "gone");
    store.upsertTenantLlmSettings("gone", "x/y");
    store.insertLlmUsageEvent({
      tenantId: "gone",
      executionTurnId: "t",
      conversationId: "c",
      model: "m",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      callIndex: 0
    });
    store.deleteTenant("gone");
    expect(store.listTenantLlmUsageEvents("gone")).toHaveLength(0);
    expect(store.getTenantLlmSettings("gone")).toBeNull();
  });
});
