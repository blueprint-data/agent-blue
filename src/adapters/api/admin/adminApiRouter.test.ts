import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express, { type Request } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdminRequestAuth } from "./adminAccess.js";
import { createAdminApiRouter } from "./adminApiRouter.js";
import { SqliteConversationStore } from "../../store/sqliteConversationStore.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const tempPaths: string[] = [];

afterEach(() => {
  for (const target of tempPaths.splice(0)) {
    try {
      fs.rmSync(path.dirname(target), { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }
  }
});

function createStore(): SqliteConversationStore {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-blue-router-test-"));
  const dbPath = path.join(rootDir, "agent.db");
  tempPaths.push(dbPath);
  const store = new SqliteConversationStore(dbPath);
  store.init();
  return store;
}

/** Create an express app mounting the admin API router with a fixed auth object. */
function createTestApp(store: SqliteConversationStore, auth: AdminRequestAuth) {
  const app = express();
  app.use(express.json());
  // Inject auth directly on every request — bypasses the real session middleware
  app.use((req, _res, next) => {
    (req as Request & { adminAuth: AdminRequestAuth }).adminAuth = auth;
    next();
  });
  const router = createAdminApiRouter({ store, appDataDir: os.tmpdir() });
  app.use("/api", router);
  return app;
}

/** Spawn a real HTTP server for the duration of a test. */
function startServer(app: ReturnType<typeof express>): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected server address"));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}/api`;
      resolve({
        url,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          })
      });
    });
    server.on("error", reject);
  });
}

const superadminAuth: AdminRequestAuth = {
  method: "session",
  username: "admin",
  role: "superadmin",
  scopedTenantId: null,
  authProvider: "password"
};

function tenantAdminAuth(tenantId: string): AdminRequestAuth {
  return {
    method: "session",
    username: `user@${tenantId}.com`,
    role: "tenant_admin",
    scopedTenantId: tenantId,
    authProvider: "google"
  };
}

/** Seed a feedback row with an optional linked execution turn. */
let seedSeq = 0;
function seedFeedback(
  store: SqliteConversationStore,
  opts: {
    tenantId: string;
    reaction?: "thumbsup" | "thumbsdown";
    withTurn?: boolean;
  }
) {
  seedSeq += 1;
  const ts = `${1717600000 + seedSeq}.${String(seedSeq).padStart(6, "0")}`;
  let executionTurnId: string | null = null;

  if (opts.withTurn !== false) {
    const turn = store.createExecutionTurn({
      tenantId: opts.tenantId,
      conversationId: `conv_${seedSeq}`,
      source: "slack",
      rawUserText: `Question ${seedSeq}`,
      promptText: `Prompt ${seedSeq}`,
      assistantText: `Answer ${seedSeq}`,
      status: "completed"
    });
    executionTurnId = turn.id;
  }

  return store.saveMessageFeedback({
    tenantId: opts.tenantId,
    conversationId: `conv_${seedSeq}`,
    executionTurnId,
    channel: "slack",
    messageTs: ts,
    userId: "U1",
    reaction: opts.reaction ?? "thumbsup"
  });
}

// ---------------------------------------------------------------------------
// Tests: GET /api/tenants/:tenantId/feedback (list endpoint)
// ---------------------------------------------------------------------------

describe("GET /api/tenants/:tenantId/feedback", () => {
  let store: SqliteConversationStore;
  let serverInfo: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    store = createStore();
    const app = createTestApp(store, superadminAuth);
    serverInfo = await startServer(app);
  });

  afterEach(async () => {
    await serverInfo.close();
  });

  it("returns 200 with MessageFeedbackRow[] for an authenticated tenant", async () => {
    seedFeedback(store, { tenantId: "acme", reaction: "thumbsup" });

    const res = await fetch(`${serverInfo.url}/tenants/acme/feedback`);
    const body = (await res.json()) as Array<{ id: string; tenantId: string; reaction: string; rawUserText: string | null }>;

    expect(res.status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].tenantId).toBe("acme");
    expect(body[0].reaction).toBe("thumbsup");
    expect(body[0].rawUserText).toBe(`Question ${seedSeq}`);
  });

  it("returns 403 for cross-tenant access", async () => {
    // Create app with tenant-a scoped auth
    const tenantAApp = createTestApp(store, tenantAdminAuth("tenant-a"));
    const tenantAServer = await startServer(tenantAApp);

    try {
      seedFeedback(store, { tenantId: "tenant-b" });
      const res = await fetch(`${tenantAServer.url}/tenants/tenant-b/feedback`);
      expect(res.status).toBe(403);
    } finally {
      await tenantAServer.close();
    }
  });

  it("forwards limit query param to the store", async () => {
    seedFeedback(store, { tenantId: "acme" });
    seedFeedback(store, { tenantId: "acme" });
    seedFeedback(store, { tenantId: "acme" });

    const res = await fetch(`${serverInfo.url}/tenants/acme/feedback?limit=2`);
    const body = (await res.json()) as unknown[];

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
  });

  it("forwards reaction filter to the store", async () => {
    seedFeedback(store, { tenantId: "acme", reaction: "thumbsup" });
    seedFeedback(store, { tenantId: "acme", reaction: "thumbsdown" });

    const res = await fetch(`${serverInfo.url}/tenants/acme/feedback?reaction=thumbsdown`);
    const body = (await res.json()) as Array<{ reaction: string }>;

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].reaction).toBe("thumbsdown");
  });

  it("forwards fromIso and toIso query params to the store", async () => {
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare(
      `INSERT INTO message_feedback (id, tenant_id, conversation_id, execution_turn_id, channel, message_ts, user_id, reaction, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("fb_old_router", "acme", "conv_old", null, "slack", "111.000", "U1", "thumbsup", "2024-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO message_feedback (id, tenant_id, conversation_id, execution_turn_id, channel, message_ts, user_id, reaction, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("fb_new_router", "acme", "conv_new", null, "slack", "222.000", "U1", "thumbsup", "2024-06-01T00:00:00.000Z");

    const res = await fetch(
      `${serverInfo.url}/tenants/acme/feedback?fromIso=2024-03-01T00:00:00.000Z&toIso=2024-12-31T00:00:00.000Z`
    );
    const body = (await res.json()) as Array<{ id: string }>;

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("fb_new_router");
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/tenants/:tenantId/feedback/export (export endpoint)
// ---------------------------------------------------------------------------

describe("GET /api/tenants/:tenantId/feedback/export", () => {
  let store: SqliteConversationStore;
  let serverInfo: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    store = createStore();
    const app = createTestApp(store, superadminAuth);
    serverInfo = await startServer(app);
  });

  afterEach(async () => {
    await serverInfo.close();
  });

  it("returns 200 with application/x-ndjson Content-Type", async () => {
    seedFeedback(store, { tenantId: "acme", reaction: "thumbsup" });

    const res = await fetch(`${serverInfo.url}/tenants/acme/feedback/export`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
  });

  it("returns correct Content-Disposition attachment filename", async () => {
    const res = await fetch(`${serverInfo.url}/tenants/acme/feedback/export`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="feedback-acme.jsonl"');
  });

  it("maps thumbsup reaction to label: chosen", async () => {
    seedFeedback(store, { tenantId: "acme", reaction: "thumbsup", withTurn: true });

    const res = await fetch(`${serverInfo.url}/tenants/acme/feedback/export`);
    const text = await res.text();
    const line = JSON.parse(text.trim().split("\n")[0]) as { label: string };

    expect(line.label).toBe("chosen");
  });

  it("maps thumbsdown reaction to label: rejected", async () => {
    seedFeedback(store, { tenantId: "acme", reaction: "thumbsdown", withTurn: true });

    const res = await fetch(`${serverInfo.url}/tenants/acme/feedback/export`);
    const text = await res.text();
    const line = JSON.parse(text.trim().split("\n")[0]) as { label: string };

    expect(line.label).toBe("rejected");
  });

  it("each JSONL line has the correct shape", async () => {
    const turn = store.createExecutionTurn({
      tenantId: "acme",
      conversationId: "conv_export_1",
      source: "slack",
      rawUserText: "What is the revenue?",
      promptText: "Prompt...",
      assistantText: "Revenue is $1M",
      status: "completed"
    });
    store.saveMessageFeedback({
      tenantId: "acme",
      conversationId: "conv_export_1",
      executionTurnId: turn.id,
      channel: "slack",
      messageTs: "9999999.000001",
      userId: "U1",
      reaction: "thumbsup"
    });

    const res = await fetch(`${serverInfo.url}/tenants/acme/feedback/export`);
    const text = await res.text();
    const line = JSON.parse(text.trim().split("\n")[0]) as {
      prompt: string | null;
      completion: string | null;
      label: string;
      feedback_id: string;
      turn_id: string | null;
      channel: string;
      created_at: string;
    };

    expect(line.prompt).toBe("What is the revenue?");
    expect(line.completion).toBe("Revenue is $1M");
    expect(line.label).toBe("chosen");
    expect(typeof line.feedback_id).toBe("string");
    expect(line.turn_id).toBe(turn.id);
    expect(line.channel).toBe("slack");
    expect(typeof line.created_at).toBe("string");
  });

  it("null-turn rows export with prompt: null, completion: null, turn_id: null", async () => {
    store.saveMessageFeedback({
      tenantId: "acme",
      conversationId: "conv_null_turn_export",
      executionTurnId: null,
      channel: "slack",
      messageTs: "8888888.000001",
      userId: "U1",
      reaction: "thumbsdown"
    });

    const res = await fetch(`${serverInfo.url}/tenants/acme/feedback/export`);
    const text = await res.text();
    const line = JSON.parse(text.trim().split("\n")[0]) as {
      prompt: null;
      completion: null;
      label: string;
      turn_id: null;
    };

    expect(line.prompt).toBeNull();
    expect(line.completion).toBeNull();
    expect(line.turn_id).toBeNull();
    expect(line.label).toBe("rejected");
  });

  it("returns 403 for cross-tenant access", async () => {
    const tenantAApp = createTestApp(store, tenantAdminAuth("tenant-a"));
    const tenantAServer = await startServer(tenantAApp);

    try {
      const res = await fetch(`${tenantAServer.url}/tenants/tenant-b/feedback/export`);
      expect(res.status).toBe(403);
    } finally {
      await tenantAServer.close();
    }
  });
});
