import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
});

describe("SqliteConversationStore tenant memories", () => {
  it("creates, updates, deletes, and retrieves tenant memories for prompts", () => {
    const store = createStore();

    const older = store.createTenantMemory({
      tenantId: "acme",
      summary: "TDV means total dollar volume net of refunds"
    });
    const newer = store.createTenantMemory({
      tenantId: "acme",
      summary: "Fiscal week starts on Monday"
    });
    const otherTenant = store.createTenantMemory({
      tenantId: "globex",
      summary: "Ignore me"
    });

    expect(store.listTenantMemories({ tenantId: "acme", includeDeleted: true })).toHaveLength(2);
    expect(store.getTenantMemory(older.id, "acme")?.summary).toContain("TDV");

    const updated = store.updateTenantMemory({
      id: older.id,
      tenantId: "acme",
      summary: "TDV means total demand value net of refunds"
    });
    expect(updated?.summary).toContain("total demand value");

    store.markTenantMemoriesUsed("acme", [older.id]);
    const promptMemories = store.getTenantMemoriesForPrompt({
      tenantId: "acme",
      queryText: "How should I calculate TDV?"
    });
    expect(promptMemories.map((memory) => memory.id)).toContain(older.id);
    expect(promptMemories.map((memory) => memory.id)).not.toContain(otherTenant.id);

    const deleted = store.deleteTenantMemory(newer.id, "acme");
    expect(deleted?.status).toBe("deleted");
    expect(store.listTenantMemories({ tenantId: "acme" })).toHaveLength(1);
    expect(store.listTenantMemories({ tenantId: "acme", includeDeleted: true })).toHaveLength(2);
  });
});
