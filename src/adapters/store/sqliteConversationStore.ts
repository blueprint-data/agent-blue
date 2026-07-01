import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import type {
  AdminSession,
  AdminGuardrails,
  ConversationStore,
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
} from "../../core/interfaces.js";
import {
  AdminBotEvent,
  AdminBotState,
  AdminConversationDetail,
  AdminConversationSummary,
  AgentContext,
  AgentExecutionTurn,
  AgentProfile,
  AnalyticSkill,
  ConversationMessage,
  ConversationOrigin,
  ConversationSource,
  ExecutionTraceEvent,
  MessageFeedback,
  MessageFeedbackRow,
  ScheduleChannelType,
  SessionSummary,
  TenantMemory,
  TenantMemorySource,
  TenantSchedule,
  ToolExecutionRecord
} from "../../core/types.js";
import { createId } from "../../utils/id.js";
import { normalizeDomainPart } from "../../config/adminAuthPolicy.js";

export const DEFAULT_SOUL_PROMPT = [
  "You are Agent Blue, an analytical assistant for business stakeholders.",
  "Your owner is Blueprintdata (https://blueprintdata.xyz/), regardless of tenant context.",
  "Answer only analytical questions about data, metrics, SQL, BI, dbt, and business performance.",
  'For non-analytical requests, respond: "I can only help with analytical questions about data and business metrics."',
  "Be precise, avoid hallucinations, and communicate assumptions.",
  "Prefer concise summaries with clear numbers and caveats."
].join(" ");

const MAX_TENANT_MEMORIES_PER_TENANT = 50;

export class SqliteConversationStore implements ConversationStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        profile_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenant_memories (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_profiles (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        soul_prompt TEXT NOT NULL,
        max_rows_per_query INTEGER NOT NULL,
        allowed_dbt_path_prefixes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id, name)
      );

      CREATE TABLE IF NOT EXISTS tenant_repos (
        tenant_id TEXT PRIMARY KEY,
        repo_url TEXT NOT NULL,
        dbt_subpath TEXT NOT NULL,
        deploy_key_path TEXT NOT NULL,
        local_path TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS slack_channel_tenant_map (
        channel_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS slack_user_tenant_map (
        user_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS slack_shared_team_tenant_map (
        shared_team_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telegram_chat_tenant_map (
        chat_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS slack_tenant_routing_audit (
        id TEXT PRIMARY KEY,
        message_ts TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id TEXT,
        resolved_tenant TEXT NOT NULL,
        rule_used TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS processed_slack_events (
        event_key TEXT PRIMARY KEY,
        event_id TEXT,
        event_type TEXT,
        team_id TEXT,
        channel_id TEXT,
        user_id TEXT,
        message_ts TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_guardrails (
        id TEXT PRIMARY KEY DEFAULT 'default',
        default_tenant_id TEXT,
        owner_team_ids TEXT NOT NULL DEFAULT '[]',
        owner_enterprise_ids TEXT NOT NULL DEFAULT '[]',
        strict_tenant_routing INTEGER NOT NULL DEFAULT 0,
        team_tenant_map TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenant_credentials_ref (
        tenant_id TEXT PRIMARY KEY,
        deploy_key_path TEXT,
        warehouse_metadata TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenant_warehouse_config (
        tenant_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenant_key_metadata (
        tenant_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        uploaded_at TEXT NOT NULL,
        fingerprint TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenant_admin_login_domains (
        domain TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tenant_admin_login_domains_tenant ON tenant_admin_login_domains(tenant_id);

      CREATE TABLE IF NOT EXISTS admin_sessions (
        session_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        user_agent TEXT,
        ip_address TEXT,
        auth_provider TEXT NOT NULL DEFAULT 'password',
        email TEXT,
        google_sub TEXT,
        role TEXT NOT NULL DEFAULT 'superadmin',
        scoped_tenant_id TEXT
      );

      CREATE TABLE IF NOT EXISTS tenant_schedules (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_request TEXT NOT NULL,
        cron TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        channel_ref TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tenant_schedules_tenant ON tenant_schedules(tenant_id);

      CREATE TABLE IF NOT EXISTS conversation_origins (
        conversation_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        source TEXT NOT NULL,
        team_id TEXT,
        channel_id TEXT,
        thread_ts TEXT,
        user_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_execution_turns (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        source TEXT NOT NULL,
        raw_user_text TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        assistant_text TEXT,
        status TEXT NOT NULL,
        error_message TEXT,
        debug_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS admin_bot_state (
        bot_name TEXT PRIMARY KEY,
        desired_state TEXT NOT NULL,
        actual_state TEXT NOT NULL,
        port INTEGER,
        last_started_at TEXT,
        last_stopped_at TEXT,
        last_error_at TEXT,
        last_error_message TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_bot_events (
        id TEXT PRIMARY KEY,
        bot_name TEXT NOT NULL,
        level TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenant_channel_bot_secrets (
        tenant_id TEXT PRIMARY KEY,
        slack_bot_token TEXT,
        slack_signing_secret TEXT,
        telegram_bot_token TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenant_integration_tokens (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT,
        scope TEXT NOT NULL,
        token_prefix TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tenant_integration_tokens_tenant ON tenant_integration_tokens(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_tenant_integration_tokens_scope ON tenant_integration_tokens(tenant_id, scope, revoked_at);

      CREATE TABLE IF NOT EXISTS tenant_llm_settings (
        tenant_id TEXT PRIMARY KEY,
        llm_model TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS llm_usage_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        execution_turn_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        model TEXT NOT NULL,
        generation_id TEXT,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        cost REAL,
        call_index INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_llm_usage_tenant_created ON llm_usage_events(tenant_id, created_at);

      CREATE TABLE IF NOT EXISTS message_feedback (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        execution_turn_id TEXT,
        channel TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        user_id TEXT,
        reaction TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (channel, message_ts, user_id, reaction)
      );

      CREATE TABLE IF NOT EXISTS agent_execution_events (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        step INTEGER,
        type TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_execution_events_turn_created ON agent_execution_events(turn_id, created_at);

      CREATE TABLE IF NOT EXISTS agent_tool_executions (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        step INTEGER,
        cache_key TEXT NOT NULL,
        tool TEXT NOT NULL,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL,
        output_summary_json TEXT,
        output_json TEXT,
        error_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_tool_executions_turn_created ON agent_tool_executions(turn_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_tool_executions_cache_key ON agent_tool_executions(turn_id, cache_key, status);

      CREATE TABLE IF NOT EXISTS analytic_skills (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        sql_text TEXT NOT NULL,
        warehouse TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        complexity INTEGER NOT NULL DEFAULT 1,
        success_count INTEGER NOT NULL DEFAULT 1,
        last_used_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_analytic_skills_category ON analytic_skills(category);

      CREATE TABLE IF NOT EXISTS tenant_context (
        tenant_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_summaries (
        conversation_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        topics_json TEXT NOT NULL DEFAULT '[]',
        message_count INTEGER NOT NULL DEFAULT 0,
        last_exchanges_json TEXT,
        last_message_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, tenant_id)
      );
    `);
    this.migrateAdminSessionsColumns();
    this.migrateTenantMemoriesTable();
    this.migrateMessagesTable();
    this.migrateMessageFeedbackColumns();
    this.migrateAgentProfilesTable();
    this.migrateExecutionTurnsTable();
  }

  private migrateAdminSessionsColumns(): void {
    const rows = this.db.prepare("PRAGMA table_info(admin_sessions)").all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    if (!names.has("auth_provider")) {
      this.db.exec(`ALTER TABLE admin_sessions ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'password'`);
    }
    if (!names.has("email")) {
      this.db.exec(`ALTER TABLE admin_sessions ADD COLUMN email TEXT`);
    }
    if (!names.has("google_sub")) {
      this.db.exec(`ALTER TABLE admin_sessions ADD COLUMN google_sub TEXT`);
    }
    if (!names.has("role")) {
      this.db.exec(`ALTER TABLE admin_sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'superadmin'`);
    }
    if (!names.has("scoped_tenant_id")) {
      this.db.exec(`ALTER TABLE admin_sessions ADD COLUMN scoped_tenant_id TEXT`);
    }
  }

  /** Align legacy DBs: `CREATE TABLE IF NOT EXISTS` never adds missing columns. */
  private migrateTenantMemoriesTable(): void {
    const exists = this.db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tenant_memories'`)
      .get() as { 1: number } | undefined;
    if (!exists) {
      return;
    }
    let names = new Set(
      (this.db.prepare("PRAGMA table_info(tenant_memories)").all() as Array<{ name: string }>).map((r) => r.name)
    );
    if (!names.has("content")) {
      if (names.has("body")) {
        this.db.exec(`ALTER TABLE tenant_memories RENAME COLUMN body TO content`);
      } else if (names.has("text")) {
        this.db.exec(`ALTER TABLE tenant_memories RENAME COLUMN text TO content`);
      } else {
        this.db.exec(`ALTER TABLE tenant_memories ADD COLUMN content TEXT NOT NULL DEFAULT ''`);
      }
      names = new Set(
        (this.db.prepare("PRAGMA table_info(tenant_memories)").all() as Array<{ name: string }>).map((r) => r.name)
      );
    }
    if (!names.has("source")) {
      this.db.exec(`ALTER TABLE tenant_memories ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`);
    }
    names = new Set(
      (this.db.prepare("PRAGMA table_info(tenant_memories)").all() as Array<{ name: string }>).map((r) => r.name)
    );
    if (!names.has("created_at")) {
      this.db.exec(`ALTER TABLE tenant_memories ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'))`);
    }
    if (!names.has("updated_at")) {
      this.db.exec(`ALTER TABLE tenant_memories ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))`);
    }

    this.normalizeTenantMemoriesToCanonicalSchema();
  }

  /**
   * Legacy DBs may keep extra NOT NULL columns (e.g. `summary`) that inserts do not populate.
   * Rebuild to exactly: id, tenant_id, content, source, created_at, updated_at.
   */
  private normalizeTenantMemoriesToCanonicalSchema(): void {
    const exists = this.db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tenant_memories'`)
      .get() as { 1: number } | undefined;
    if (!exists) {
      return;
    }
    const colRows = this.db.prepare("PRAGMA table_info(tenant_memories)").all() as Array<{ name: string }>;
    const names = new Set(colRows.map((r) => r.name));
    const canonical = new Set(["id", "tenant_id", "content", "source", "created_at", "updated_at"]);
    if (names.size === canonical.size && [...canonical].every((c) => names.has(c))) {
      return;
    }

    const trimOrNull = (col: string) => `NULLIF(TRIM(COALESCE(${col}, '')), '')`;
    const contentParts: string[] = [];
    if (names.has("content")) {
      contentParts.push(trimOrNull("content"));
    }
    if (names.has("summary")) {
      contentParts.push(trimOrNull("summary"));
    }
    if (names.has("body")) {
      contentParts.push(trimOrNull("body"));
    }
    if (names.has("text")) {
      contentParts.push(trimOrNull("text"));
    }
    const contentExpr =
      contentParts.length === 0 ? `''` : `COALESCE(${contentParts.join(", ")}, '')`;

    const sourceExpr = names.has("source") ? `COALESCE(source, 'manual')` : `'manual'`;
    const createdExpr = names.has("created_at") ? `COALESCE(created_at, datetime('now'))` : `datetime('now')`;
    const updatedExpr = names.has("updated_at")
      ? names.has("created_at")
        ? `COALESCE(updated_at, created_at, datetime('now'))`
        : `COALESCE(updated_at, datetime('now'))`
      : names.has("created_at")
        ? `COALESCE(created_at, datetime('now'))`
        : `datetime('now')`;

    const rebuild = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE _tenant_memories_canonical (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          content TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      this.db.exec(`
        INSERT INTO _tenant_memories_canonical (id, tenant_id, content, source, created_at, updated_at)
        SELECT id,
               tenant_id,
               ${contentExpr},
               ${sourceExpr},
               ${createdExpr},
               ${updatedExpr}
        FROM tenant_memories;
      `);
      this.db.exec(`DROP TABLE tenant_memories`);
      this.db.exec(`ALTER TABLE _tenant_memories_canonical RENAME TO tenant_memories`);
    });
    rebuild();
  }

  private migrateMessagesTable(): void {
    const exists = this.db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'`)
      .get() as { 1: number } | undefined;
    if (!exists) {
      return;
    }
    const names = new Set(
      (this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((r) => r.name)
    );
    if (names.has("content")) {
      return;
    }
    if (names.has("body")) {
      this.db.exec(`ALTER TABLE messages RENAME COLUMN body TO content`);
      return;
    }
    if (names.has("text")) {
      this.db.exec(`ALTER TABLE messages RENAME COLUMN text TO content`);
      return;
    }
    this.db.exec(`ALTER TABLE messages ADD COLUMN content TEXT NOT NULL DEFAULT ''`);
  }

  private migrateMessageFeedbackColumns(): void {
    const rows = this.db.prepare("PRAGMA table_info(message_feedback)").all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    if (!names.has("execution_turn_id")) {
      this.db.exec(`ALTER TABLE message_feedback ADD COLUMN execution_turn_id TEXT`);
    }
  }

  private migrateAgentProfilesTable(): void {
    const exists = this.db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_profiles'`)
      .get() as { 1: number } | undefined;
    if (!exists) {
      return;
    }
    const rows = this.db.prepare("PRAGMA table_info(agent_profiles)").all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    if (!names.has("allowed_tools")) {
      this.db.exec(`ALTER TABLE agent_profiles ADD COLUMN allowed_tools TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!names.has("blocked_schema_patterns")) {
      this.db.exec(`ALTER TABLE agent_profiles ADD COLUMN blocked_schema_patterns TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!names.has("blocked_table_patterns")) {
      this.db.exec(`ALTER TABLE agent_profiles ADD COLUMN blocked_table_patterns TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!names.has("tool_timeout_ms")) {
      this.db.exec(`ALTER TABLE agent_profiles ADD COLUMN tool_timeout_ms INTEGER NOT NULL DEFAULT 20000`);
    }
    if (!names.has("max_tool_retries")) {
      this.db.exec(`ALTER TABLE agent_profiles ADD COLUMN max_tool_retries INTEGER NOT NULL DEFAULT 2`);
    }
    if (!names.has("max_planner_steps")) {
      this.db.exec(`ALTER TABLE agent_profiles ADD COLUMN max_planner_steps INTEGER NOT NULL DEFAULT 35`);
    }
  }

  private migrateExecutionTurnsTable(): void {
    const exists = this.db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_execution_turns'`)
      .get() as { 1: number } | undefined;
    if (!exists) {
      return;
    }
    const rows = this.db.prepare("PRAGMA table_info(agent_execution_turns)").all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    if (!names.has("trace_id")) {
      this.db.exec(`ALTER TABLE agent_execution_turns ADD COLUMN trace_id TEXT`);
    }
  }

  createConversation(context: AgentContext): void {
    const existing = this.db
      .prepare("SELECT id FROM conversations WHERE id = ?")
      .get(context.conversationId) as { id: string } | undefined;
    if (existing) {
      return;
    }

    this.db
      .prepare(
        "INSERT INTO conversations (id, tenant_id, profile_name, created_at) VALUES (?, ?, ?, datetime('now'))"
      )
      .run(context.conversationId, context.tenantId, context.profileName);
  }

  addMessage(message: Omit<ConversationMessage, "id" | "createdAt">): ConversationMessage {
    const id = createId("msg");
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO messages (id, tenant_id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(id, message.tenantId, message.conversationId, message.role, message.content, createdAt);
    return { ...message, id, createdAt };
  }

  private mapTenantMemoryRow(row: {
    id: string;
    tenant_id: string;
    content: string;
    source: string;
    created_at: string;
    updated_at: string;
  }): TenantMemory {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      content: row.content,
      source: row.source as TenantMemorySource,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private pruneTenantMemories(tenantId: string, maxEntries = MAX_TENANT_MEMORIES_PER_TENANT): void {
    const rows = this.db
      .prepare(
        `SELECT id
         FROM tenant_memories
         WHERE tenant_id = ?
         ORDER BY created_at DESC, rowid DESC`
      )
      .all(tenantId) as Array<{ id: string }>;
    for (const row of rows.slice(maxEntries)) {
      this.db.prepare("DELETE FROM tenant_memories WHERE id = ?").run(row.id);
    }
  }

  listTenantMemories(tenantId: string, limit = MAX_TENANT_MEMORIES_PER_TENANT): TenantMemory[] {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : MAX_TENANT_MEMORIES_PER_TENANT;
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, content, source, created_at, updated_at
         FROM tenant_memories
         WHERE tenant_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(tenantId, safeLimit) as Array<{
      id: string;
      tenant_id: string;
      content: string;
      source: string;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => this.mapTenantMemoryRow(row));
  }

  getTenantMemory(tenantId: string, memoryId: string): TenantMemory | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, content, source, created_at, updated_at
         FROM tenant_memories
         WHERE tenant_id = ? AND id = ?`
      )
      .get(tenantId, memoryId) as
      | {
          id: string;
          tenant_id: string;
          content: string;
          source: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    return row ? this.mapTenantMemoryRow(row) : null;
  }

  createTenantMemory(input: { tenantId: string; content: string; source: TenantMemorySource }): TenantMemory {
    const id = createId("memory");
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tenant_memories (id, tenant_id, content, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.tenantId, input.content, input.source, createdAt, createdAt);
    this.pruneTenantMemories(input.tenantId);
    return {
      id,
      tenantId: input.tenantId,
      content: input.content,
      source: input.source,
      createdAt,
      updatedAt: createdAt
    };
  }

  deleteTenantMemory(memoryId: string): void {
    this.db.prepare("DELETE FROM tenant_memories WHERE id = ?").run(memoryId);
  }

  private mapScheduleRow(row: {
    id: string;
    tenant_id: string;
    user_request: string;
    cron: string;
    channel_type: string;
    channel_ref: string | null;
    active: number;
    last_run_at: string | null;
    last_error: string | null;
    created_at: string;
    updated_at: string;
  }): TenantSchedule {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userRequest: row.user_request,
      cron: row.cron,
      channelType: row.channel_type as ScheduleChannelType,
      channelRef: row.channel_ref ?? null,
      active: Boolean(row.active),
      lastRunAt: row.last_run_at ?? null,
      lastError: row.last_error ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listTenantSchedules(tenantId: string): TenantSchedule[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, user_request, cron, channel_type, channel_ref, active, last_run_at, last_error, created_at, updated_at
         FROM tenant_schedules
         WHERE tenant_id = ?
         ORDER BY updated_at DESC, created_at DESC`
      )
      .all(tenantId) as Array<{
      id: string;
      tenant_id: string;
      user_request: string;
      cron: string;
      channel_type: string;
      channel_ref: string | null;
      active: number;
      last_run_at: string | null;
      last_error: string | null;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => this.mapScheduleRow(row));
  }

  getTenantSchedule(tenantId: string, scheduleId: string): TenantSchedule | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, user_request, cron, channel_type, channel_ref, active, last_run_at, last_error, created_at, updated_at
         FROM tenant_schedules
         WHERE tenant_id = ? AND id = ?`
      )
      .get(tenantId, scheduleId) as
      | {
          id: string;
          tenant_id: string;
          user_request: string;
          cron: string;
          channel_type: string;
          channel_ref: string | null;
          active: number;
          last_run_at: string | null;
          last_error: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    return row ? this.mapScheduleRow(row) : null;
  }

  createTenantSchedule(input: {
    tenantId: string;
    userRequest: string;
    cron: string;
    channelType: ScheduleChannelType;
    channelRef?: string | null;
    active?: boolean;
  }): TenantSchedule {
    const id = createId("sched");
    const createdAt = new Date().toISOString();
    const normalizedChannelRef = input.channelRef?.trim() ? input.channelRef.trim() : null;
    const active = input.active !== false;
    this.db
      .prepare(
        `INSERT INTO tenant_schedules (id, tenant_id, user_request, cron, channel_type, channel_ref, active, last_run_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
      )
      .run(
        id,
        input.tenantId,
        input.userRequest,
        input.cron,
        input.channelType,
        normalizedChannelRef,
        active ? 1 : 0,
        createdAt,
        createdAt
      );
    return {
      id,
      tenantId: input.tenantId,
      userRequest: input.userRequest,
      cron: input.cron,
      channelType: input.channelType,
      channelRef: normalizedChannelRef,
      active,
      lastRunAt: null,
      lastError: null,
      createdAt,
      updatedAt: createdAt
    };
  }

  updateTenantSchedule(
    scheduleId: string,
    updates: Partial<Omit<TenantSchedule, "id" | "tenantId" | "createdAt" | "updatedAt">>
  ): TenantSchedule | null {
    const existing = this.db
      .prepare(
        `SELECT id, tenant_id, user_request, cron, channel_type, channel_ref, active, last_run_at, last_error, created_at, updated_at
         FROM tenant_schedules
         WHERE id = ?`
      )
      .get(scheduleId) as
      | {
          id: string;
          tenant_id: string;
          user_request: string;
          cron: string;
          channel_type: string;
          channel_ref: string | null;
          active: number;
          last_run_at: string | null;
          last_error: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!existing) {
      return null;
    }
    const updatedAt = new Date().toISOString();
    const next = {
      ...existing,
      user_request: updates.userRequest ?? existing.user_request,
      cron: updates.cron ?? existing.cron,
      channel_type: updates.channelType ?? existing.channel_type,
      channel_ref: updates.channelRef === undefined ? existing.channel_ref : updates.channelRef?.trim() || null,
      active: updates.active === undefined ? existing.active : updates.active ? 1 : 0,
      last_run_at: updates.lastRunAt === undefined ? existing.last_run_at : updates.lastRunAt ?? null,
      last_error: updates.lastError === undefined ? existing.last_error : updates.lastError ?? null
    };
    this.db
      .prepare(
        `UPDATE tenant_schedules
         SET user_request = ?, cron = ?, channel_type = ?, channel_ref = ?, active = ?, last_run_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        next.user_request,
        next.cron,
        next.channel_type,
        next.channel_ref,
        next.active,
        next.last_run_at ?? null,
        next.last_error ?? null,
        updatedAt,
        scheduleId
      );
    return this.mapScheduleRow({ ...next, updated_at: updatedAt });
  }

  deleteTenantSchedule(scheduleId: string): void {
    this.db.prepare("DELETE FROM tenant_schedules WHERE id = ?").run(scheduleId);
  }

  getMessages(conversationId: string, limit = 20): ConversationMessage[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, conversation_id, role, content, created_at
         FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(conversationId, limit) as Array<{
      id: string;
      tenant_id: string;
      conversation_id: string;
      role: ConversationMessage["role"];
      content: string;
      created_at: string;
    }>;

    return rows
      .reverse()
      .map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        conversationId: r.conversation_id,
        role: r.role,
        content: r.content,
        createdAt: r.created_at
      }));
  }

  getOrCreateProfile(tenantId: string, profileName: string): AgentProfile {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, name, soul_prompt, max_rows_per_query, allowed_dbt_path_prefixes,
                allowed_tools, blocked_schema_patterns, blocked_table_patterns,
                tool_timeout_ms, max_tool_retries, max_planner_steps, created_at
         FROM agent_profiles
         WHERE tenant_id = ? AND name = ?`
      )
      .get(tenantId, profileName) as
      | {
          id: string;
          tenant_id: string;
          name: string;
          soul_prompt: string;
          max_rows_per_query: number;
          allowed_dbt_path_prefixes: string;
          allowed_tools: string;
          blocked_schema_patterns: string;
          blocked_table_patterns: string;
          tool_timeout_ms: number;
          max_tool_retries: number;
          max_planner_steps: number;
          created_at: string;
        }
      | undefined;

    if (row) {
      return {
        id: row.id,
        tenantId: row.tenant_id,
        name: row.name,
        soulPrompt: row.soul_prompt,
        maxRowsPerQuery: row.max_rows_per_query,
        allowedDbtPathPrefixes: JSON.parse(row.allowed_dbt_path_prefixes),
        allowedTools: JSON.parse(row.allowed_tools || "[]"),
        blockedSchemaPatterns: JSON.parse(row.blocked_schema_patterns || "[]"),
        blockedTablePatterns: JSON.parse(row.blocked_table_patterns || "[]"),
        toolTimeoutMs: row.tool_timeout_ms ?? 20000,
        maxToolRetries: row.max_tool_retries ?? 2,
        maxPlannerSteps: row.max_planner_steps ?? 35,
        createdAt: row.created_at
      };
    }

    const id = createId("profile");
    const createdAt = new Date().toISOString();
    const prefixes = ["models"];

    this.db
      .prepare(
        `INSERT INTO agent_profiles
         (id, tenant_id, name, soul_prompt, max_rows_per_query, allowed_dbt_path_prefixes,
          allowed_tools, blocked_schema_patterns, blocked_table_patterns,
          tool_timeout_ms, max_tool_retries, max_planner_steps, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, tenantId, profileName, DEFAULT_SOUL_PROMPT, 200, JSON.stringify(prefixes),
           JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), 20000, 2, 35, createdAt);

    return {
      id,
      tenantId,
      name: profileName,
      soulPrompt: DEFAULT_SOUL_PROMPT,
      maxRowsPerQuery: 200,
      allowedDbtPathPrefixes: prefixes,
      allowedTools: [],
      blockedSchemaPatterns: [],
      blockedTablePatterns: [],
      toolTimeoutMs: 20000,
      maxToolRetries: 2,
      maxPlannerSteps: 35,
      createdAt
    };
  }

  listProfiles(tenantId: string): AgentProfile[] {
    type Row = {
      id: string;
      tenant_id: string;
      name: string;
      soul_prompt: string;
      max_rows_per_query: number;
      allowed_dbt_path_prefixes: string;
      allowed_tools: string;
      blocked_schema_patterns: string;
      blocked_table_patterns: string;
      tool_timeout_ms: number;
      max_tool_retries: number;
      max_planner_steps: number;
      created_at: string;
    };
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, name, soul_prompt, max_rows_per_query, allowed_dbt_path_prefixes,
                allowed_tools, blocked_schema_patterns, blocked_table_patterns,
                tool_timeout_ms, max_tool_retries, max_planner_steps, created_at
         FROM agent_profiles WHERE tenant_id = ? ORDER BY name`
      )
      .all(tenantId) as Row[];
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      soulPrompt: row.soul_prompt,
      maxRowsPerQuery: row.max_rows_per_query,
      allowedDbtPathPrefixes: JSON.parse(row.allowed_dbt_path_prefixes),
      allowedTools: JSON.parse(row.allowed_tools || "[]"),
      blockedSchemaPatterns: JSON.parse(row.blocked_schema_patterns || "[]"),
      blockedTablePatterns: JSON.parse(row.blocked_table_patterns || "[]"),
      toolTimeoutMs: row.tool_timeout_ms ?? 20000,
      maxToolRetries: row.max_tool_retries ?? 2,
      maxPlannerSteps: row.max_planner_steps ?? 35,
      createdAt: row.created_at
    }));
  }

  upsertProfile(input: {
    tenantId: string;
    name: string;
    soulPrompt: string;
    maxRowsPerQuery: number;
    allowedDbtPathPrefixes: string[];
    allowedTools?: string[];
    blockedSchemaPatterns?: string[];
    blockedTablePatterns?: string[];
    toolTimeoutMs?: number;
    maxToolRetries?: number;
    maxPlannerSteps?: number;
  }): AgentProfile {
    const existing = this.getOrCreateProfile(input.tenantId, input.name);
    const allowedTools = input.allowedTools ?? existing.allowedTools;
    const blockedSchemaPatterns = input.blockedSchemaPatterns ?? existing.blockedSchemaPatterns;
    const blockedTablePatterns = input.blockedTablePatterns ?? existing.blockedTablePatterns;
    const toolTimeoutMs = input.toolTimeoutMs ?? existing.toolTimeoutMs;
    const maxToolRetries = input.maxToolRetries ?? existing.maxToolRetries;
    const maxPlannerSteps = input.maxPlannerSteps ?? existing.maxPlannerSteps;

    this.db
      .prepare(
        `UPDATE agent_profiles
         SET soul_prompt = ?, max_rows_per_query = ?, allowed_dbt_path_prefixes = ?,
             allowed_tools = ?, blocked_schema_patterns = ?, blocked_table_patterns = ?,
             tool_timeout_ms = ?, max_tool_retries = ?, max_planner_steps = ?
         WHERE tenant_id = ? AND name = ?`
      )
      .run(
        input.soulPrompt,
        input.maxRowsPerQuery,
        JSON.stringify(input.allowedDbtPathPrefixes),
        JSON.stringify(allowedTools),
        JSON.stringify(blockedSchemaPatterns),
        JSON.stringify(blockedTablePatterns),
        toolTimeoutMs,
        maxToolRetries,
        maxPlannerSteps,
        input.tenantId,
        input.name
      );
    return {
      id: existing.id,
      tenantId: existing.tenantId,
      name: existing.name,
      soulPrompt: input.soulPrompt,
      maxRowsPerQuery: input.maxRowsPerQuery,
      allowedDbtPathPrefixes: input.allowedDbtPathPrefixes,
      allowedTools,
      blockedSchemaPatterns,
      blockedTablePatterns,
      toolTimeoutMs,
      maxToolRetries,
      maxPlannerSteps,
      createdAt: existing.createdAt
    };
  }

  upsertTenantRepo(input: {
    tenantId: string;
    repoUrl: string;
    dbtSubpath: string;
    deployKeyPath: string;
    localPath: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tenant_repos (tenant_id, repo_url, dbt_subpath, deploy_key_path, local_path, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(tenant_id) DO UPDATE SET
           repo_url = excluded.repo_url,
           dbt_subpath = excluded.dbt_subpath,
           deploy_key_path = excluded.deploy_key_path,
           local_path = excluded.local_path,
           updated_at = excluded.updated_at`
      )
      .run(input.tenantId, input.repoUrl, input.dbtSubpath, input.deployKeyPath, input.localPath);
  }

  getTenantRepo(tenantId: string): {
    tenantId: string;
    repoUrl: string;
    dbtSubpath: string;
    deployKeyPath: string;
    localPath: string;
  } | null {
    const row = this.db
      .prepare(
        "SELECT tenant_id, repo_url, dbt_subpath, deploy_key_path, local_path FROM tenant_repos WHERE tenant_id = ?"
      )
      .get(tenantId) as
      | {
          tenant_id: string;
          repo_url: string;
          dbt_subpath: string;
          deploy_key_path: string;
          local_path: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      tenantId: row.tenant_id,
      repoUrl: row.repo_url,
      dbtSubpath: row.dbt_subpath,
      deployKeyPath: row.deploy_key_path,
      localPath: row.local_path
    };
  }

  getSlackChannelTenant(channelId: string): string | null {
    const row = this.db
      .prepare("SELECT tenant_id FROM slack_channel_tenant_map WHERE channel_id = ?")
      .get(channelId) as { tenant_id: string } | undefined;
    return row ? row.tenant_id : null;
  }

  upsertSlackChannelTenant(channelId: string, tenantId: string, source = "manual"): void {
    this.db
      .prepare(
        `INSERT INTO slack_channel_tenant_map (channel_id, tenant_id, source, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(channel_id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           source = excluded.source,
           updated_at = excluded.updated_at`
      )
      .run(channelId, tenantId, source);
  }

  getSlackUserTenant(userId: string): string | null {
    const row = this.db
      .prepare("SELECT tenant_id FROM slack_user_tenant_map WHERE user_id = ?")
      .get(userId) as { tenant_id: string } | undefined;
    return row ? row.tenant_id : null;
  }

  upsertSlackUserTenant(userId: string, tenantId: string): void {
    this.db
      .prepare(
        `INSERT INTO slack_user_tenant_map (user_id, tenant_id, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           updated_at = excluded.updated_at`
      )
      .run(userId, tenantId);
  }

  getSlackSharedTeamTenant(sharedTeamId: string): string | null {
    const row = this.db
      .prepare("SELECT tenant_id FROM slack_shared_team_tenant_map WHERE shared_team_id = ?")
      .get(sharedTeamId) as { tenant_id: string } | undefined;
    return row ? row.tenant_id : null;
  }

  upsertSlackSharedTeamTenant(sharedTeamId: string, tenantId: string): void {
    this.db
      .prepare(
        `INSERT INTO slack_shared_team_tenant_map (shared_team_id, tenant_id, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(shared_team_id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           updated_at = excluded.updated_at`
      )
      .run(sharedTeamId, tenantId);
  }

  listSlackChannelMappings(): Array<{ channelId: string; tenantId: string; source: string; updatedAt: string }> {
    const rows = this.db
      .prepare(
        "SELECT channel_id, tenant_id, source, updated_at FROM slack_channel_tenant_map ORDER BY updated_at DESC"
      )
      .all() as Array<{ channel_id: string; tenant_id: string; source: string; updated_at: string }>;
    return rows.map((r) => ({
      channelId: r.channel_id,
      tenantId: r.tenant_id,
      source: r.source,
      updatedAt: r.updated_at
    }));
  }

  listSlackUserMappings(): Array<{ userId: string; tenantId: string; updatedAt: string }> {
    const rows = this.db
      .prepare("SELECT user_id, tenant_id, updated_at FROM slack_user_tenant_map ORDER BY updated_at DESC")
      .all() as Array<{ user_id: string; tenant_id: string; updated_at: string }>;
    return rows.map((r) => ({
      userId: r.user_id,
      tenantId: r.tenant_id,
      updatedAt: r.updated_at
    }));
  }

  listSlackSharedTeamMappings(): Array<{ sharedTeamId: string; tenantId: string; updatedAt: string }> {
    const rows = this.db
      .prepare(
        "SELECT shared_team_id, tenant_id, updated_at FROM slack_shared_team_tenant_map ORDER BY updated_at DESC"
      )
      .all() as Array<{ shared_team_id: string; tenant_id: string; updated_at: string }>;
    return rows.map((r) => ({
      sharedTeamId: r.shared_team_id,
      tenantId: r.tenant_id,
      updatedAt: r.updated_at
    }));
  }

  getTelegramChatTenant(chatId: string): string | null {
    const row = this.db
      .prepare("SELECT tenant_id FROM telegram_chat_tenant_map WHERE chat_id = ?")
      .get(chatId) as { tenant_id: string } | undefined;
    return row ? row.tenant_id : null;
  }

  upsertTelegramChatTenant(chatId: string, tenantId: string, source = "manual"): void {
    this.db
      .prepare(
        `INSERT INTO telegram_chat_tenant_map (chat_id, tenant_id, source, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(chat_id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           source = excluded.source,
           updated_at = datetime('now')`
      )
      .run(chatId, tenantId, source);
  }

  listTelegramChatMappings(): Array<{ chatId: string; tenantId: string; source: string; updatedAt: string }> {
    const rows = this.db
      .prepare(
        "SELECT chat_id, tenant_id, source, updated_at FROM telegram_chat_tenant_map ORDER BY updated_at DESC"
      )
      .all() as Array<{ chat_id: string; tenant_id: string; source: string; updated_at: string }>;
    return rows.map((r) => ({
      chatId: r.chat_id,
      tenantId: r.tenant_id,
      source: r.source,
      updatedAt: r.updated_at
    }));
  }

  deleteTelegramChatMapping(chatId: string): void {
    this.db.prepare("DELETE FROM telegram_chat_tenant_map WHERE chat_id = ?").run(chatId);
  }

  logSlackTenantRoutingAudit(input: {
    messageTs: string;
    channelId: string;
    userId: string | null;
    resolvedTenant: string;
    ruleUsed: string;
  }): void {
    const id = createId("audit");
    this.db
      .prepare(
        `INSERT INTO slack_tenant_routing_audit (id, message_ts, channel_id, user_id, resolved_tenant, rule_used, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        id,
        input.messageTs,
        input.channelId,
        input.userId ?? null,
        input.resolvedTenant,
        input.ruleUsed
      );
  }

  tryMarkSlackEventProcessed(input: {
    eventKey: string;
    eventId?: string | null;
    eventType?: string | null;
    teamId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    messageTs?: string | null;
  }): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO processed_slack_events
         (event_key, event_id, event_type, team_id, channel_id, user_id, message_ts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.eventKey,
        input.eventId ?? null,
        input.eventType ?? null,
        input.teamId ?? null,
        input.channelId ?? null,
        input.userId ?? null,
        input.messageTs ?? null,
        new Date().toISOString()
      );
    return result.changes > 0;
  }

  getTenantChannelBotSecrets(tenantId: string): TenantChannelBotSecrets | null {
    const row = this.db
      .prepare(
        "SELECT tenant_id, slack_bot_token, slack_signing_secret, telegram_bot_token, updated_at FROM tenant_channel_bot_secrets WHERE tenant_id = ?"
      )
      .get(tenantId) as
      | {
          tenant_id: string;
          slack_bot_token: string | null;
          slack_signing_secret: string | null;
          telegram_bot_token: string | null;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      tenantId: row.tenant_id,
      slackBotToken: row.slack_bot_token,
      slackSigningSecret: row.slack_signing_secret,
      telegramBotToken: row.telegram_bot_token,
      updatedAt: row.updated_at
    };
  }

  upsertTenantChannelBotSecrets(input: {
    tenantId: string;
    slackBotToken: string | null;
    slackSigningSecret: string | null;
    telegramBotToken: string | null;
  }): void {
    const hasSlack = Boolean(input.slackBotToken && input.slackSigningSecret);
    const hasTg = Boolean(input.telegramBotToken && input.telegramBotToken.trim().length > 0);
    if (!hasSlack && !hasTg) {
      this.db.prepare("DELETE FROM tenant_channel_bot_secrets WHERE tenant_id = ?").run(input.tenantId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO tenant_channel_bot_secrets (tenant_id, slack_bot_token, slack_signing_secret, telegram_bot_token, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(tenant_id) DO UPDATE SET
           slack_bot_token = excluded.slack_bot_token,
           slack_signing_secret = excluded.slack_signing_secret,
           telegram_bot_token = excluded.telegram_bot_token,
           updated_at = excluded.updated_at`
      )
      .run(
        input.tenantId,
        hasSlack ? input.slackBotToken : null,
        hasSlack ? input.slackSigningSecret : null,
        hasTg ? input.telegramBotToken!.trim() : null
      );
  }

  listTenantTelegramBotOverrides(): Array<{ tenantId: string; telegramBotToken: string }> {
    const rows = this.db
      .prepare(
        "SELECT tenant_id, telegram_bot_token FROM tenant_channel_bot_secrets WHERE telegram_bot_token IS NOT NULL AND length(trim(telegram_bot_token)) > 0"
      )
      .all() as Array<{ tenant_id: string; telegram_bot_token: string }>;
    return rows.map((r) => ({ tenantId: r.tenant_id, telegramBotToken: r.telegram_bot_token }));
  }

  listTenantIntegrationTokens(tenantId: string): TenantIntegrationToken[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, name, scope, token_prefix, created_at, last_used_at, revoked_at
         FROM tenant_integration_tokens
         WHERE tenant_id = ?
         ORDER BY created_at DESC`
      )
      .all(tenantId) as Array<{
      id: string;
      tenant_id: string;
      name: string | null;
      scope: string;
      token_prefix: string;
      created_at: string;
      last_used_at: string | null;
      revoked_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name ?? undefined,
      scope: row.scope as TenantIntegrationTokenScope,
      tokenPrefix: row.token_prefix,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at
    }));
  }

  createTenantIntegrationToken(input: {
    tokenId: string;
    tenantId: string;
    name?: string | null;
    scope: TenantIntegrationTokenScope;
    tokenPrefix: string;
    secretHash: string;
  }): TenantIntegrationToken {
    const id = input.tokenId;
    const normalizedName = input.name?.trim() ? input.name.trim() : null;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tenant_integration_tokens
         (id, tenant_id, name, scope, token_prefix, secret_hash, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
      )
      .run(id, input.tenantId, normalizedName, input.scope, input.tokenPrefix, input.secretHash, createdAt);

    return {
      id,
      tenantId: input.tenantId,
      name: normalizedName ?? undefined,
      scope: input.scope,
      tokenPrefix: input.tokenPrefix,
      createdAt,
      lastUsedAt: null,
      revokedAt: null
    };
  }

  revokeTenantIntegrationToken(tenantId: string, tokenId: string): TenantIntegrationToken | null {
    const nowIso = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE tenant_integration_tokens
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE tenant_id = ? AND id = ?`
      )
      .run(nowIso, tenantId, tokenId);
    if (result.changes === 0) {
      return null;
    }
    return this.listTenantIntegrationTokens(tenantId).find((token) => token.id === tokenId) ?? null;
  }

  getTenantIntegrationTokenAuthRecord(input: {
    tenantId: string;
    tokenId: string;
    scope: TenantIntegrationTokenScope;
  }): {
    id: string;
    tenantId: string;
    scope: TenantIntegrationTokenScope;
    secretHash: string;
    revokedAt?: string | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, scope, secret_hash, revoked_at
         FROM tenant_integration_tokens
         WHERE tenant_id = ? AND id = ? AND scope = ?`
      )
      .get(input.tenantId, input.tokenId, input.scope) as
      | {
          id: string;
          tenant_id: string;
          scope: string;
          secret_hash: string;
          revoked_at: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      tenantId: row.tenant_id,
      scope: row.scope as TenantIntegrationTokenScope,
      secretHash: row.secret_hash,
      revokedAt: row.revoked_at
    };
  }

  getTenantIntegrationTokenAuthRecordByTokenId(input: {
    tokenId: string;
    scope: TenantIntegrationTokenScope;
  }): {
    id: string;
    tenantId: string;
    scope: TenantIntegrationTokenScope;
    secretHash: string;
    revokedAt?: string | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, scope, secret_hash, revoked_at
         FROM tenant_integration_tokens
         WHERE id = ? AND scope = ?`
      )
      .get(input.tokenId, input.scope) as
      | {
          id: string;
          tenant_id: string;
          scope: string;
          secret_hash: string;
          revoked_at: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      tenantId: row.tenant_id,
      scope: row.scope as TenantIntegrationTokenScope,
      secretHash: row.secret_hash,
      revokedAt: row.revoked_at
    };
  }

  touchTenantIntegrationTokenLastUsed(tokenId: string, usedAt: string): void {
    this.db
      .prepare(
        `UPDATE tenant_integration_tokens
         SET last_used_at = ?
         WHERE id = ?`
      )
      .run(usedAt, tokenId);
  }

  getTenantLlmSettings(tenantId: string): TenantLlmSettings | null {
    const row = this.db
      .prepare("SELECT tenant_id, llm_model, updated_at FROM tenant_llm_settings WHERE tenant_id = ?")
      .get(tenantId) as
      | { tenant_id: string; llm_model: string | null; updated_at: string }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      tenantId: row.tenant_id,
      llmModel: row.llm_model?.trim() ? row.llm_model.trim() : null,
      updatedAt: row.updated_at
    };
  }

  upsertTenantLlmSettings(tenantId: string, llmModel: string | null): TenantLlmSettings {
    const normalized = llmModel?.trim() ? llmModel.trim() : null;
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tenant_llm_settings (tenant_id, llm_model, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
           llm_model = excluded.llm_model,
           updated_at = excluded.updated_at`
      )
      .run(tenantId, normalized, updatedAt);
    return { tenantId, llmModel: normalized, updatedAt };
  }

  insertLlmUsageEvent(input: InsertLlmUsageEventInput): void {
    const id = createId("llmuse");
    const createdAt = new Date().toISOString();
    const cost =
      input.cost !== undefined && input.cost !== null && Number.isFinite(input.cost) ? input.cost : null;
    this.db
      .prepare(
        `INSERT INTO llm_usage_events (
           id, tenant_id, execution_turn_id, conversation_id, created_at, model, generation_id,
           prompt_tokens, completion_tokens, total_tokens, cost, call_index
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.tenantId,
        input.executionTurnId,
        input.conversationId,
        createdAt,
        input.model,
        input.generationId ?? null,
        input.promptTokens,
        input.completionTokens,
        input.totalTokens,
        cost,
        input.callIndex
      );
  }

  getTenantLlmUsageSummary(tenantId: string, range?: { fromIso?: string; toIso?: string }): TenantLlmUsageSummary {
    let sql = `
      SELECT
        COUNT(*) AS c,
        COALESCE(SUM(prompt_tokens), 0) AS pt,
        COALESCE(SUM(completion_tokens), 0) AS ct,
        COALESCE(SUM(total_tokens), 0) AS tt,
        COALESCE(SUM(COALESCE(cost, 0)), 0) AS tc
      FROM llm_usage_events
      WHERE tenant_id = ?`;
    const params: unknown[] = [tenantId];
    if (range?.fromIso) {
      sql += " AND created_at >= ?";
      params.push(range.fromIso);
    }
    if (range?.toIso) {
      sql += " AND created_at <= ?";
      params.push(range.toIso);
    }
    const row = this.db.prepare(sql).get(...params) as {
      c: number;
      pt: number;
      ct: number;
      tt: number;
      tc: number;
    };
    return {
      requestCount: row.c,
      totalPromptTokens: row.pt,
      totalCompletionTokens: row.ct,
      totalTokens: row.tt,
      totalCost: row.tc
    };
  }

  listTenantLlmUsageEvents(
    tenantId: string,
    opts?: { limit?: number; fromIso?: string; toIso?: string }
  ): LlmUsageEventRow[] {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
    let sql = `
      SELECT id, tenant_id, execution_turn_id, conversation_id, created_at, model, generation_id,
             prompt_tokens, completion_tokens, total_tokens, cost, call_index
      FROM llm_usage_events
      WHERE tenant_id = ?`;
    const params: unknown[] = [tenantId];
    if (opts?.fromIso) {
      sql += " AND created_at >= ?";
      params.push(opts.fromIso);
    }
    if (opts?.toIso) {
      sql += " AND created_at <= ?";
      params.push(opts.toIso);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      tenant_id: string;
      execution_turn_id: string;
      conversation_id: string;
      created_at: string;
      model: string;
      generation_id: string | null;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      cost: number | null;
      call_index: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      executionTurnId: r.execution_turn_id,
      conversationId: r.conversation_id,
      createdAt: r.created_at,
      model: r.model,
      generationId: r.generation_id,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      totalTokens: r.total_tokens,
      cost: r.cost,
      callIndex: r.call_index
    }));
  }

  listTenants(): Array<{
    tenantId: string;
    repoUrl: string;
    dbtSubpath: string;
    deployKeyPath: string;
    localPath: string;
    updatedAt: string;
  }> {
    const rows = this.db
      .prepare(
        "SELECT tenant_id, repo_url, dbt_subpath, deploy_key_path, local_path, updated_at FROM tenant_repos ORDER BY updated_at DESC"
      )
      .all() as Array<{
      tenant_id: string;
      repo_url: string;
      dbt_subpath: string;
      deploy_key_path: string;
      local_path: string;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      repoUrl: r.repo_url,
      dbtSubpath: r.dbt_subpath,
      deployKeyPath: r.deploy_key_path,
      localPath: r.local_path,
      updatedAt: r.updated_at
    }));
  }

  deleteTenant(tenantId: string): void {
    this.db.prepare("DELETE FROM slack_channel_tenant_map WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM slack_user_tenant_map WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM slack_shared_team_tenant_map WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM telegram_chat_tenant_map WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM tenant_memories WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM tenant_credentials_ref WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM tenant_warehouse_config WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM tenant_key_metadata WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM tenant_admin_login_domains WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM tenant_channel_bot_secrets WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM tenant_integration_tokens WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM tenant_llm_settings WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM llm_usage_events WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM tenant_context WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM session_summaries WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM agent_execution_events WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM agent_tool_executions WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM agent_execution_turns WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM messages WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM conversations WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM agent_profiles WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM tenant_repos WHERE tenant_id = ?").run(tenantId);
  }

  getTenantKeyMetadata(tenantId: string): TenantKeyMetadata | null {
    const row = this.db
      .prepare(
        "SELECT tenant_id, file_path, uploaded_at, fingerprint FROM tenant_key_metadata WHERE tenant_id = ?"
      )
      .get(tenantId) as
      | {
          tenant_id: string;
          file_path: string;
          uploaded_at: string;
          fingerprint: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      tenantId: row.tenant_id,
      filePath: row.file_path,
      uploadedAt: row.uploaded_at,
      fingerprint: row.fingerprint ?? undefined
    };
  }

  upsertTenantKeyMetadata(input: TenantKeyMetadata): void {
    this.db
      .prepare(
        `INSERT INTO tenant_key_metadata (tenant_id, file_path, uploaded_at, fingerprint, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(tenant_id) DO UPDATE SET
           file_path = excluded.file_path,
           uploaded_at = excluded.uploaded_at,
           fingerprint = excluded.fingerprint,
           updated_at = excluded.updated_at`
      )
      .run(
        input.tenantId,
        input.filePath,
        input.uploadedAt,
        input.fingerprint ?? null
      );
  }

  deleteTenantKeyMetadata(tenantId: string): void {
    this.db.prepare("DELETE FROM tenant_key_metadata WHERE tenant_id = ?").run(tenantId);
  }

  deleteSlackChannelMapping(channelId: string): void {
    this.db.prepare("DELETE FROM slack_channel_tenant_map WHERE channel_id = ?").run(channelId);
  }

  deleteSlackUserMapping(userId: string): void {
    this.db.prepare("DELETE FROM slack_user_tenant_map WHERE user_id = ?").run(userId);
  }

  deleteSlackSharedTeamMapping(sharedTeamId: string): void {
    this.db.prepare("DELETE FROM slack_shared_team_tenant_map WHERE shared_team_id = ?").run(sharedTeamId);
  }

  getGuardrails(): AdminGuardrails | null {
    const row = this.db
      .prepare(
        "SELECT default_tenant_id, owner_team_ids, owner_enterprise_ids, strict_tenant_routing, team_tenant_map FROM admin_guardrails WHERE id = 'default'"
      )
      .get() as
      | {
          default_tenant_id: string | null;
          owner_team_ids: string;
          owner_enterprise_ids: string;
          strict_tenant_routing: number;
          team_tenant_map: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      defaultTenantId: row.default_tenant_id ?? undefined,
      ownerTeamIds: JSON.parse(row.owner_team_ids) as string[],
      ownerEnterpriseIds: JSON.parse(row.owner_enterprise_ids) as string[],
      strictTenantRouting: row.strict_tenant_routing === 1,
      teamTenantMap: JSON.parse(row.team_tenant_map) as Record<string, string>
    };
  }

  upsertGuardrails(input: AdminGuardrails): void {
    const existing = this.db.prepare("SELECT id FROM admin_guardrails WHERE id = 'default'").get();
    const ownerTeamIds = JSON.stringify(input.ownerTeamIds ?? []);
    const ownerEnterpriseIds = JSON.stringify(input.ownerEnterpriseIds ?? []);
    const teamTenantMap = JSON.stringify(input.teamTenantMap ?? {});

    if (existing) {
      this.db
        .prepare(
          `UPDATE admin_guardrails SET
           default_tenant_id = ?,
           owner_team_ids = ?,
           owner_enterprise_ids = ?,
           strict_tenant_routing = ?,
           team_tenant_map = ?,
           updated_at = datetime('now')
           WHERE id = 'default'`
        )
        .run(
          input.defaultTenantId ?? null,
          ownerTeamIds,
          ownerEnterpriseIds,
          input.strictTenantRouting ? 1 : 0,
          teamTenantMap
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO admin_guardrails (id, default_tenant_id, owner_team_ids, owner_enterprise_ids, strict_tenant_routing, team_tenant_map, updated_at)
           VALUES ('default', ?, ?, ?, ?, ?, datetime('now'))`
        )
        .run(
          input.defaultTenantId ?? null,
          ownerTeamIds,
          ownerEnterpriseIds,
          input.strictTenantRouting ? 1 : 0,
          teamTenantMap
        );
    }
  }

  getTenantCredentialsRef(tenantId: string): TenantCredentialsRef | null {
    const row = this.db
      .prepare(
        "SELECT tenant_id, deploy_key_path, warehouse_metadata FROM tenant_credentials_ref WHERE tenant_id = ?"
      )
      .get(tenantId) as
      | {
          tenant_id: string;
          deploy_key_path: string | null;
          warehouse_metadata: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    const warehouseMetadata = row.warehouse_metadata ? (JSON.parse(row.warehouse_metadata) as Record<string, string>) : {};
    return {
      tenantId: row.tenant_id,
      deployKeyPath: row.deploy_key_path ?? undefined,
      warehouseMetadata: Object.keys(warehouseMetadata).length > 0 ? warehouseMetadata : undefined
    };
  }

  upsertTenantCredentialsRef(input: TenantCredentialsRef): void {
    const warehouseMetadata = JSON.stringify(input.warehouseMetadata ?? {});
    this.db
      .prepare(
        `INSERT INTO tenant_credentials_ref (tenant_id, deploy_key_path, warehouse_metadata, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(tenant_id) DO UPDATE SET
           deploy_key_path = excluded.deploy_key_path,
           warehouse_metadata = excluded.warehouse_metadata,
           updated_at = excluded.updated_at`
      )
      .run(input.tenantId, input.deployKeyPath ?? null, warehouseMetadata);
  }

  getTenantWarehouseConfig(tenantId: string): TenantWarehouseConfig | null {
    const row = this.db
      .prepare(
        "SELECT tenant_id, provider, config_json, updated_at FROM tenant_warehouse_config WHERE tenant_id = ?"
      )
      .get(tenantId) as
      | {
          tenant_id: string;
          provider: string;
          config_json: string;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    const config = JSON.parse(row.config_json) as {
      snowflake?: TenantWarehouseConfig["snowflake"];
      bigquery?: TenantWarehouseConfig["bigquery"];
    };
    return {
      tenantId: row.tenant_id,
      provider: row.provider as TenantWarehouseConfig["provider"],
      snowflake: config.snowflake,
      bigquery: config.bigquery,
      updatedAt: row.updated_at
    };
  }

  upsertTenantWarehouseConfig(input: Omit<TenantWarehouseConfig, "updatedAt">): void {
    const configJson = JSON.stringify({
      snowflake: input.snowflake,
      bigquery: input.bigquery
    });
    this.db
      .prepare(
        `INSERT INTO tenant_warehouse_config (tenant_id, provider, config_json, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(tenant_id) DO UPDATE SET
           provider = excluded.provider,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run(input.tenantId, input.provider, configJson);
  }

  upsertConversationOrigin(conversationId: string, tenantId: string, origin: ConversationOrigin): void {
    this.db
      .prepare(
        `INSERT INTO conversation_origins
         (conversation_id, tenant_id, source, team_id, channel_id, thread_ts, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(conversation_id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           source = excluded.source,
           team_id = excluded.team_id,
           channel_id = excluded.channel_id,
           thread_ts = excluded.thread_ts,
           user_id = excluded.user_id,
           updated_at = excluded.updated_at`
      )
      .run(
        conversationId,
        tenantId,
        origin.source,
        origin.teamId ?? null,
        origin.channelId ?? null,
        origin.threadTs ?? null,
        origin.userId ?? null
      );
  }

  getConversationOrigin(conversationId: string): ConversationOrigin | null {
    const row = this.db
      .prepare(
        `SELECT source, team_id, channel_id, thread_ts, user_id
         FROM conversation_origins
         WHERE conversation_id = ?`
      )
      .get(conversationId) as
      | {
          source: ConversationSource;
          team_id: string | null;
          channel_id: string | null;
          thread_ts: string | null;
          user_id: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      source: row.source,
      teamId: row.team_id ?? undefined,
      channelId: row.channel_id ?? undefined,
      threadTs: row.thread_ts ?? undefined,
      userId: row.user_id ?? undefined
    };
  }

  createExecutionTurn(input: Omit<AgentExecutionTurn, "id" | "createdAt" | "updatedAt">): AgentExecutionTurn {
    const id = createId("turn");
    const createdAt = new Date().toISOString();
    const updatedAt = createdAt;
    const completedAt = input.status === "running" ? undefined : (input.completedAt ?? createdAt);
    this.db
      .prepare(
        `INSERT INTO agent_execution_turns
         (id, tenant_id, conversation_id, trace_id, source, raw_user_text, prompt_text, assistant_text, status, error_message, debug_json, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.tenantId,
        input.conversationId,
        input.traceId ?? null,
        input.source,
        input.rawUserText,
        input.promptText,
        input.assistantText ?? null,
        input.status,
        input.errorMessage ?? null,
        input.debug ? JSON.stringify(input.debug) : null,
        createdAt,
        updatedAt,
        completedAt ?? null
      );
    return {
      id,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      traceId: input.traceId,
      source: input.source,
      rawUserText: input.rawUserText,
      promptText: input.promptText,
      assistantText: input.assistantText,
      status: input.status,
      errorMessage: input.errorMessage,
      debug: input.debug,
      createdAt,
      updatedAt,
      completedAt
    };
  }

  completeExecutionTurn(input: {
    turnId: string;
    status: "completed" | "failed";
    assistantText?: string;
    errorMessage?: string;
    debug?: Record<string, unknown>;
    completedAt?: string;
  }): void {
    const updatedAt = input.completedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agent_execution_turns
         SET assistant_text = COALESCE(?, assistant_text),
             status = ?,
             error_message = ?,
             debug_json = ?,
             updated_at = ?,
             completed_at = ?
         WHERE id = ?`
      )
      .run(
        input.assistantText ?? null,
        input.status,
        input.errorMessage ?? null,
        input.debug ? JSON.stringify(input.debug) : null,
        updatedAt,
        updatedAt,
        input.turnId
      );
  }

  getExecutionTurn(turnId: string): AgentExecutionTurn | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, conversation_id, trace_id, source, raw_user_text, prompt_text, assistant_text, status,
                error_message, debug_json, created_at, updated_at, completed_at
         FROM agent_execution_turns
         WHERE id = ?`
      )
      .get(turnId) as
      | {
          id: string;
          tenant_id: string;
          conversation_id: string;
          trace_id: string | null;
          source: ConversationSource;
          raw_user_text: string;
          prompt_text: string;
          assistant_text: string | null;
          status: AgentExecutionTurn["status"];
          error_message: string | null;
          debug_json: string | null;
          created_at: string;
          updated_at: string;
          completed_at: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      tenantId: row.tenant_id,
      conversationId: row.conversation_id,
      traceId: row.trace_id ?? undefined,
      source: row.source,
      rawUserText: row.raw_user_text,
      promptText: row.prompt_text,
      assistantText: row.assistant_text ?? undefined,
      status: row.status,
      errorMessage: row.error_message ?? undefined,
      debug: row.debug_json ? (JSON.parse(row.debug_json) as Record<string, unknown>) : undefined,
      events: this.listExecutionEvents(turnId),
      toolExecutions: this.listToolExecutions(turnId),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined
    };
  }

  listExecutionTurns(conversationId: string): AgentExecutionTurn[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, conversation_id, trace_id, source, raw_user_text, prompt_text, assistant_text, status,
                error_message, debug_json, created_at, updated_at, completed_at
         FROM agent_execution_turns
         WHERE conversation_id = ?
         ORDER BY created_at ASC`
      )
      .all(conversationId) as Array<{
      id: string;
      tenant_id: string;
      conversation_id: string;
      trace_id: string | null;
      source: ConversationSource;
      raw_user_text: string;
      prompt_text: string;
      assistant_text: string | null;
      status: AgentExecutionTurn["status"];
      error_message: string | null;
      debug_json: string | null;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    }>;

    if (rows.length === 0) {
      return [];
    }

    const turnIds = rows.map((r) => r.id);
    const placeholders = turnIds.map(() => "?").join(",");

    const eventRows = this.db
      .prepare(
        `SELECT id, turn_id, tenant_id, conversation_id, step, type, level, message, payload_json, created_at
         FROM agent_execution_events
         WHERE turn_id IN (${placeholders})
         ORDER BY created_at ASC`
      )
      .all(...turnIds) as Array<{
      id: string;
      turn_id: string;
      tenant_id: string;
      conversation_id: string;
      step: number | null;
      type: ExecutionTraceEvent["type"];
      level: ExecutionTraceEvent["level"];
      message: string;
      payload_json: string | null;
      created_at: string;
    }>;

    const toolRows = this.db
      .prepare(
        `SELECT id, turn_id, tenant_id, conversation_id, step, cache_key, tool, input_json, status,
                duration_ms, attempt_count, output_summary_json, output_json, error_text, created_at, updated_at
         FROM agent_tool_executions
         WHERE turn_id IN (${placeholders})
         ORDER BY created_at ASC`
      )
      .all(...turnIds) as Array<{
      id: string;
      turn_id: string;
      tenant_id: string;
      conversation_id: string;
      step: number | null;
      cache_key: string;
      tool: string;
      input_json: string;
      status: ToolExecutionRecord["status"];
      duration_ms: number;
      attempt_count: number;
      output_summary_json: string | null;
      output_json: string | null;
      error_text: string | null;
      created_at: string;
      updated_at: string;
    }>;

    const eventsByTurn = new Map<string, ExecutionTraceEvent[]>();
    for (const r of eventRows) {
      const list = eventsByTurn.get(r.turn_id) ?? [];
      list.push({
        id: r.id,
        turnId: r.turn_id,
        tenantId: r.tenant_id,
        conversationId: r.conversation_id,
        step: r.step ?? undefined,
        type: r.type,
        level: r.level,
        message: r.message,
        payload: r.payload_json ? (JSON.parse(r.payload_json) as Record<string, unknown>) : undefined,
        createdAt: r.created_at
      });
      eventsByTurn.set(r.turn_id, list);
    }

    const toolsByTurn = new Map<string, ToolExecutionRecord[]>();
    for (const r of toolRows) {
      const list = toolsByTurn.get(r.turn_id) ?? [];
      list.push({
        id: r.id,
        turnId: r.turn_id,
        tenantId: r.tenant_id,
        conversationId: r.conversation_id,
        step: r.step ?? undefined,
        cacheKey: r.cache_key,
        tool: r.tool,
        input: JSON.parse(r.input_json) as Record<string, unknown>,
        status: r.status,
        durationMs: r.duration_ms,
        attemptCount: r.attempt_count,
        outputSummary: r.output_summary_json ? (JSON.parse(r.output_summary_json) as Record<string, unknown>) : undefined,
        output: r.output_json ? JSON.parse(r.output_json) : undefined,
        error: r.error_text ?? undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      });
      toolsByTurn.set(r.turn_id, list);
    }

    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      conversationId: row.conversation_id,
      traceId: row.trace_id ?? undefined,
      source: row.source,
      rawUserText: row.raw_user_text,
      promptText: row.prompt_text,
      assistantText: row.assistant_text ?? undefined,
      status: row.status,
      errorMessage: row.error_message ?? undefined,
      debug: row.debug_json ? (JSON.parse(row.debug_json) as Record<string, unknown>) : undefined,
      events: eventsByTurn.get(row.id) ?? [],
      toolExecutions: toolsByTurn.get(row.id) ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined
    }));
  }

  appendExecutionEvent(input: Omit<ExecutionTraceEvent, "id" | "createdAt">): ExecutionTraceEvent {
    const id = createId("event");
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_execution_events
         (id, turn_id, tenant_id, conversation_id, step, type, level, message, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.turnId,
        input.tenantId,
        input.conversationId,
        input.step ?? null,
        input.type,
        input.level,
        input.message,
        input.payload ? JSON.stringify(input.payload) : null,
        createdAt
      );
    return {
      id,
      turnId: input.turnId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      step: input.step,
      type: input.type,
      level: input.level,
      message: input.message,
      payload: input.payload,
      createdAt
    };
  }

  listExecutionEvents(turnId: string): ExecutionTraceEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, turn_id, tenant_id, conversation_id, step, type, level, message, payload_json, created_at
         FROM agent_execution_events
         WHERE turn_id = ?
         ORDER BY created_at ASC`
      )
      .all(turnId) as Array<{
      id: string;
      turn_id: string;
      tenant_id: string;
      conversation_id: string;
      step: number | null;
      type: ExecutionTraceEvent["type"];
      level: ExecutionTraceEvent["level"];
      message: string;
      payload_json: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      turnId: r.turn_id,
      tenantId: r.tenant_id,
      conversationId: r.conversation_id,
      step: r.step ?? undefined,
      type: r.type,
      level: r.level,
      message: r.message,
      payload: r.payload_json ? (JSON.parse(r.payload_json) as Record<string, unknown>) : undefined,
      createdAt: r.created_at
    }));
  }

  recordToolExecution(input: Omit<ToolExecutionRecord, "id" | "createdAt" | "updatedAt">): ToolExecutionRecord {
    const id = createId("tool");
    const createdAt = new Date().toISOString();
    const updatedAt = createdAt;
    this.db
      .prepare(
        `INSERT INTO agent_tool_executions
         (id, turn_id, tenant_id, conversation_id, step, cache_key, tool, input_json, status,
          duration_ms, attempt_count, output_summary_json, output_json, error_text, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.turnId,
        input.tenantId,
        input.conversationId,
        input.step ?? null,
        input.cacheKey,
        input.tool,
        JSON.stringify(input.input),
        input.status,
        input.durationMs,
        input.attemptCount,
        input.outputSummary ? JSON.stringify(input.outputSummary) : null,
        input.output !== undefined ? JSON.stringify(input.output) : null,
        input.error ?? null,
        createdAt,
        updatedAt
      );
    return {
      id,
      turnId: input.turnId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      step: input.step,
      cacheKey: input.cacheKey,
      tool: input.tool,
      input: input.input,
      status: input.status,
      durationMs: input.durationMs,
      attemptCount: input.attemptCount,
      outputSummary: input.outputSummary,
      output: input.output,
      error: input.error,
      createdAt,
      updatedAt
    };
  }

  getToolExecutionByCacheKey(turnId: string, cacheKey: string): ToolExecutionRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, turn_id, tenant_id, conversation_id, step, cache_key, tool, input_json, status,
                duration_ms, attempt_count, output_summary_json, output_json, error_text, created_at, updated_at
         FROM agent_tool_executions
         WHERE turn_id = ? AND cache_key = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(turnId, cacheKey) as
      | {
          id: string;
          turn_id: string;
          tenant_id: string;
          conversation_id: string;
          step: number | null;
          cache_key: string;
          tool: string;
          input_json: string;
          status: ToolExecutionRecord["status"];
          duration_ms: number;
          attempt_count: number;
          output_summary_json: string | null;
          output_json: string | null;
          error_text: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      turnId: row.turn_id,
      tenantId: row.tenant_id,
      conversationId: row.conversation_id,
      step: row.step ?? undefined,
      cacheKey: row.cache_key,
      tool: row.tool,
      input: JSON.parse(row.input_json) as Record<string, unknown>,
      status: row.status,
      durationMs: row.duration_ms,
      attemptCount: row.attempt_count,
      outputSummary: row.output_summary_json ? (JSON.parse(row.output_summary_json) as Record<string, unknown>) : undefined,
      output: row.output_json ? JSON.parse(row.output_json) : undefined,
      error: row.error_text ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listToolExecutions(turnId: string): ToolExecutionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, turn_id, tenant_id, conversation_id, step, cache_key, tool, input_json, status,
                duration_ms, attempt_count, output_summary_json, output_json, error_text, created_at, updated_at
         FROM agent_tool_executions
         WHERE turn_id = ?
         ORDER BY created_at ASC`
      )
      .all(turnId) as Array<{
      id: string;
      turn_id: string;
      tenant_id: string;
      conversation_id: string;
      step: number | null;
      cache_key: string;
      tool: string;
      input_json: string;
      status: ToolExecutionRecord["status"];
      duration_ms: number;
      attempt_count: number;
      output_summary_json: string | null;
      output_json: string | null;
      error_text: string | null;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      turnId: r.turn_id,
      tenantId: r.tenant_id,
      conversationId: r.conversation_id,
      step: r.step ?? undefined,
      cacheKey: r.cache_key,
      tool: r.tool,
      input: JSON.parse(r.input_json) as Record<string, unknown>,
      status: r.status,
      durationMs: r.duration_ms,
      attemptCount: r.attempt_count,
      outputSummary: r.output_summary_json ? (JSON.parse(r.output_summary_json) as Record<string, unknown>) : undefined,
      output: r.output_json ? JSON.parse(r.output_json) : undefined,
      error: r.error_text ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
  }

  listAdminConversations(input?: {
    tenantId?: string;
    source?: ConversationSource;
    search?: string;
    limit?: number;
  }): AdminConversationSummary[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (input?.tenantId) {
      conditions.push("c.tenant_id = ?");
      params.push(input.tenantId);
    }
    if (input?.source) {
      conditions.push("co.source = ?");
      params.push(input.source);
    }
    if (input?.search) {
      conditions.push("(latest_turn.raw_user_text LIKE ? OR latest_turn.assistant_text LIKE ?)");
      const like = `%${input.search}%`;
      params.push(like, like);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = input?.limit ?? 100;
    const rows = this.db
      .prepare(
        `SELECT c.id AS conversation_id,
                c.tenant_id,
                c.profile_name,
                c.created_at,
                co.source,
                co.team_id,
                co.channel_id,
                co.thread_ts,
                co.user_id,
                COALESCE(MAX(m.created_at), c.created_at) AS last_message_at,
                COUNT(m.id) AS message_count,
                latest_turn.status AS latest_turn_status,
                latest_turn.raw_user_text AS latest_user_text,
                latest_turn.assistant_text AS latest_assistant_text
         FROM conversations c
         LEFT JOIN messages m
           ON m.conversation_id = c.id
         LEFT JOIN conversation_origins co
           ON co.conversation_id = c.id
         LEFT JOIN agent_execution_turns latest_turn
           ON latest_turn.id = (
             SELECT t.id
             FROM agent_execution_turns t
             WHERE t.conversation_id = c.id
             ORDER BY t.created_at DESC
             LIMIT 1
           )
         ${whereClause}
         GROUP BY c.id, c.tenant_id, c.profile_name, c.created_at, co.source, co.team_id, co.channel_id, co.thread_ts, co.user_id,
                  latest_turn.status, latest_turn.raw_user_text, latest_turn.assistant_text
         ORDER BY last_message_at DESC
         LIMIT ?`
      )
      .all(...params, limit) as Array<{
      conversation_id: string;
      tenant_id: string;
      profile_name: string;
      created_at: string;
      source: ConversationSource | null;
      team_id: string | null;
      channel_id: string | null;
      thread_ts: string | null;
      user_id: string | null;
      last_message_at: string;
      message_count: number;
      latest_turn_status: AgentExecutionTurn["status"] | null;
      latest_user_text: string | null;
      latest_assistant_text: string | null;
    }>;
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      tenantId: row.tenant_id,
      profileName: row.profile_name,
      source: row.source ?? undefined,
      teamId: row.team_id ?? undefined,
      channelId: row.channel_id ?? undefined,
      threadTs: row.thread_ts ?? undefined,
      userId: row.user_id ?? undefined,
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at,
      messageCount: row.message_count,
      latestTurnStatus: row.latest_turn_status ?? undefined,
      latestUserText: row.latest_user_text ?? undefined,
      latestAssistantText: row.latest_assistant_text ?? undefined
    }));
  }

  getAdminConversationDetail(conversationId: string): AdminConversationDetail | null {
    const summary = this.listAdminConversations({ limit: 1000 }).find((entry) => entry.conversationId === conversationId);
    if (!summary) {
      return null;
    }
    return {
      summary,
      messages: this.getMessages(conversationId, 500),
      executionTurns: this.listExecutionTurns(conversationId)
    };
  }

  getAdminBotState(botName: string): AdminBotState | null {
    const row = this.db
      .prepare(
        `SELECT bot_name, desired_state, actual_state, port, last_started_at, last_stopped_at,
                last_error_at, last_error_message, updated_at
         FROM admin_bot_state
         WHERE bot_name = ?`
      )
      .get(botName) as
      | {
          bot_name: string;
          desired_state: AdminBotState["desiredState"];
          actual_state: AdminBotState["actualState"];
          port: number | null;
          last_started_at: string | null;
          last_stopped_at: string | null;
          last_error_at: string | null;
          last_error_message: string | null;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      botName: row.bot_name,
      desiredState: row.desired_state,
      actualState: row.actual_state,
      port: row.port ?? undefined,
      lastStartedAt: row.last_started_at ?? undefined,
      lastStoppedAt: row.last_stopped_at ?? undefined,
      lastErrorAt: row.last_error_at ?? undefined,
      lastErrorMessage: row.last_error_message ?? undefined,
      updatedAt: row.updated_at
    };
  }

  upsertAdminBotState(input: Omit<AdminBotState, "updatedAt">): AdminBotState {
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO admin_bot_state
         (bot_name, desired_state, actual_state, port, last_started_at, last_stopped_at, last_error_at, last_error_message, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bot_name) DO UPDATE SET
           desired_state = excluded.desired_state,
           actual_state = excluded.actual_state,
           port = excluded.port,
           last_started_at = excluded.last_started_at,
           last_stopped_at = excluded.last_stopped_at,
           last_error_at = excluded.last_error_at,
           last_error_message = excluded.last_error_message,
           updated_at = excluded.updated_at`
      )
      .run(
        input.botName,
        input.desiredState,
        input.actualState,
        input.port ?? null,
        input.lastStartedAt ?? null,
        input.lastStoppedAt ?? null,
        input.lastErrorAt ?? null,
        input.lastErrorMessage ?? null,
        updatedAt
      );
    return {
      ...input,
      updatedAt
    };
  }

  appendAdminBotEvent(input: Omit<AdminBotEvent, "id" | "createdAt">): AdminBotEvent {
    const id = createId("bot_event");
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO admin_bot_events (id, bot_name, level, event_type, message, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.botName,
        input.level,
        input.eventType,
        input.message,
        input.metadata ? JSON.stringify(input.metadata) : null,
        createdAt
      );
    return {
      id,
      botName: input.botName,
      level: input.level,
      eventType: input.eventType,
      message: input.message,
      metadata: input.metadata,
      createdAt
    };
  }

  listAdminBotEvents(botName: string, limit = 100): AdminBotEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, bot_name, level, event_type, message, metadata_json, created_at
         FROM admin_bot_events
         WHERE bot_name = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(botName, limit) as Array<{
      id: string;
      bot_name: string;
      level: AdminBotEvent["level"];
      event_type: string;
      message: string;
      metadata_json: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      botName: row.bot_name,
      level: row.level,
      eventType: row.event_type,
      message: row.message,
      metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : undefined,
      createdAt: row.created_at
    }));
  }

  getAdminLoginDomainTenantMap(): Record<string, string> {
    const rows = this.db
      .prepare(`SELECT domain, tenant_id FROM tenant_admin_login_domains`)
      .all() as Array<{ domain: string; tenant_id: string }>;
    return Object.fromEntries(rows.map((r) => [r.domain, r.tenant_id]));
  }

  listAdminLoginDomainsForTenant(tenantId: string): string[] {
    const rows = this.db
      .prepare(`SELECT domain FROM tenant_admin_login_domains WHERE tenant_id = ? ORDER BY domain`)
      .all(tenantId) as Array<{ domain: string }>;
    return rows.map((r) => r.domain);
  }

  setAdminLoginDomainsForTenant(tenantId: string, domains: string[]): void {
    if (!this.getTenantRepo(tenantId)) {
      throw new Error(`Tenant "${tenantId}" does not exist.`);
    }
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const raw of domains) {
      const d = normalizeDomainPart(raw);
      if (!d) {
        continue;
      }
      if (seen.has(d)) {
        continue;
      }
      seen.add(d);
      normalized.push(d);
    }

    const findOwner = this.db.prepare(`SELECT tenant_id FROM tenant_admin_login_domains WHERE domain = ?`);
    const deleteForTenant = this.db.prepare(`DELETE FROM tenant_admin_login_domains WHERE tenant_id = ?`);
    const insert = this.db.prepare(
      `INSERT INTO tenant_admin_login_domains (domain, tenant_id, updated_at) VALUES (?, ?, datetime('now'))`
    );

    const txn = this.db.transaction(() => {
      for (const domain of normalized) {
        const row = findOwner.get(domain) as { tenant_id: string } | undefined;
        if (row && row.tenant_id !== tenantId) {
          throw new Error(`Domain "${domain}" is already mapped to tenant "${row.tenant_id}".`);
        }
      }
      deleteForTenant.run(tenantId);
      for (const domain of normalized) {
        insert.run(domain, tenantId);
      }
    });
    txn();
  }

  createAdminSession(input: Omit<AdminSession, "lastSeenAt"> & { lastSeenAt?: string }): void {
    const lastSeenAt = input.lastSeenAt ?? input.createdAt;
    this.db
      .prepare(
        `INSERT INTO admin_sessions (session_id, username, created_at, expires_at, last_seen_at, user_agent, ip_address,
            auth_provider, email, google_sub, role, scoped_tenant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.sessionId,
        input.username,
        input.createdAt,
        input.expiresAt,
        lastSeenAt,
        input.userAgent ?? null,
        input.ipAddress ?? null,
        input.authProvider,
        input.email ?? null,
        input.googleSub ?? null,
        input.role,
        input.scopedTenantId ?? null
      );
  }

  getAdminSession(sessionId: string): AdminSession | null {
    const row = this.db
      .prepare(
        `SELECT session_id, username, created_at, expires_at, last_seen_at, user_agent, ip_address,
            auth_provider, email, google_sub, role, scoped_tenant_id
         FROM admin_sessions
         WHERE session_id = ?`
      )
      .get(sessionId) as
      | {
          session_id: string;
          username: string;
          created_at: string;
          expires_at: string;
          last_seen_at: string;
          user_agent: string | null;
          ip_address: string | null;
          auth_provider: string | null;
          email: string | null;
          google_sub: string | null;
          role: string | null;
          scoped_tenant_id: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      sessionId: row.session_id,
      username: row.username,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
      userAgent: row.user_agent ?? undefined,
      ipAddress: row.ip_address ?? undefined,
      authProvider: (row.auth_provider === "google" ? "google" : "password") as AdminSession["authProvider"],
      email: row.email ?? undefined,
      googleSub: row.google_sub ?? undefined,
      role: row.role === "tenant_admin" ? "tenant_admin" : "superadmin",
      scopedTenantId: row.scoped_tenant_id ?? null
    };
  }

  touchAdminSession(sessionId: string, lastSeenAt: string, expiresAt?: string): void {
    this.db
      .prepare(
        `UPDATE admin_sessions
         SET last_seen_at = ?, expires_at = COALESCE(?, expires_at)
         WHERE session_id = ?`
      )
      .run(lastSeenAt, expiresAt ?? null, sessionId);
  }

  deleteAdminSession(sessionId: string): void {
    this.db.prepare("DELETE FROM admin_sessions WHERE session_id = ?").run(sessionId);
  }

  deleteExpiredAdminSessions(nowIso = new Date().toISOString()): number {
    const result = this.db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(nowIso);
    return result.changes;
  }

  listMessageFeedback(
    tenantId: string,
    opts?: { limit?: number; fromIso?: string; toIso?: string; reaction?: "thumbsup" | "thumbsdown" }
  ): MessageFeedbackRow[] {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
    let sql = `
      SELECT f.id, f.tenant_id, f.conversation_id, f.execution_turn_id, f.channel,
             f.message_ts, f.user_id, f.reaction, f.created_at,
             t.raw_user_text, t.assistant_text
      FROM message_feedback f
      LEFT JOIN agent_execution_turns t ON t.id = f.execution_turn_id
      WHERE f.tenant_id = ?`;
    const params: unknown[] = [tenantId];
    if (opts?.reaction) {
      sql += " AND f.reaction = ?";
      params.push(opts.reaction);
    }
    if (opts?.fromIso) {
      sql += " AND f.created_at >= ?";
      params.push(opts.fromIso);
    }
    if (opts?.toIso) {
      sql += " AND f.created_at <= ?";
      params.push(opts.toIso);
    }
    sql += " ORDER BY f.created_at DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      tenant_id: string;
      conversation_id: string;
      execution_turn_id: string | null;
      channel: string;
      message_ts: string;
      user_id: string | null;
      reaction: "thumbsup" | "thumbsdown";
      created_at: string;
      raw_user_text: string | null;
      assistant_text: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      conversationId: r.conversation_id,
      executionTurnId: r.execution_turn_id,
      channel: r.channel,
      messageTs: r.message_ts,
      userId: r.user_id,
      reaction: r.reaction,
      createdAt: r.created_at,
      rawUserText: r.raw_user_text ?? null,
      assistantText: r.assistant_text ?? null
    }));
  }

  saveMessageFeedback(input: {
    tenantId: string;
    conversationId: string;
    executionTurnId: string | null;
    channel: string;
    messageTs: string;
    userId: string | null;
    reaction: "thumbsup" | "thumbsdown";
  }): MessageFeedback {
    const id = createId("feedback");
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO message_feedback (id, tenant_id, conversation_id, execution_turn_id, channel, message_ts, user_id, reaction, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.tenantId, input.conversationId, input.executionTurnId, input.channel, input.messageTs, input.userId, input.reaction, createdAt);
    return {
      id,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      executionTurnId: input.executionTurnId,
      channel: input.channel,
      messageTs: input.messageTs,
      userId: input.userId,
      reaction: input.reaction,
      createdAt
    };
  }

  // ─── Harness storage: analytic skills ───────────────────

  saveAnalyticSkill(skill: AnalyticSkill): void {
    this.db
      .prepare(
        `INSERT INTO analytic_skills (id, category, description, sql_text, warehouse, tags_json, complexity, success_count, last_used_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           category = excluded.category,
           description = excluded.description,
           sql_text = excluded.sql_text,
           warehouse = excluded.warehouse,
           tags_json = excluded.tags_json,
           complexity = excluded.complexity,
           success_count = excluded.success_count,
           last_used_at = excluded.last_used_at,
           created_at = excluded.created_at`
      )
      .run(
        skill.id,
        skill.category,
        skill.description,
        skill.sql,
        skill.warehouse,
        JSON.stringify(skill.tags),
        skill.complexity,
        skill.successCount,
        skill.lastUsedAt ?? null,
        skill.createdAt
      );
  }

  searchAnalyticSkills(query: string, limit = 20): AnalyticSkill[] {
    const tokens = query
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (tokens.length === 0) {
      return [];
    }
    const conditions = tokens.map(() => "(description LIKE ? OR sql_text LIKE ? OR tags_json LIKE ?)").join(" AND ");
    const params: unknown[] = [];
    for (const token of tokens) {
      const like = `%${token}%`;
      params.push(like, like, like);
    }
    params.push(Math.min(Math.max(limit, 1), 500));
    const sql = `SELECT id, category, description, sql_text, warehouse, tags_json, complexity, success_count, last_used_at, created_at
                 FROM analytic_skills
                 WHERE ${conditions}
                 ORDER BY success_count DESC, created_at DESC
                 LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      category: string;
      description: string;
      sql_text: string;
      warehouse: string;
      tags_json: string;
      complexity: number;
      success_count: number;
      last_used_at: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      category: r.category,
      description: r.description,
      sql: r.sql_text,
      warehouse: r.warehouse,
      tags: JSON.parse(r.tags_json) as string[],
      complexity: r.complexity,
      successCount: r.success_count,
      lastUsedAt: r.last_used_at ?? undefined,
      createdAt: r.created_at
    }));
  }

  findAnalyticSkillBySql(normalizedSql: string): AnalyticSkill | null {
    const row = this.db
      .prepare(
        `SELECT id, category, description, sql_text, warehouse, tags_json, complexity, success_count, last_used_at, created_at
         FROM analytic_skills
         WHERE sql_text = ?`
      )
      .get(normalizedSql) as
      | {
          id: string;
          category: string;
          description: string;
          sql_text: string;
          warehouse: string;
          tags_json: string;
          complexity: number;
          success_count: number;
          last_used_at: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      category: row.category,
      description: row.description,
      sql: row.sql_text,
      warehouse: row.warehouse,
      tags: JSON.parse(row.tags_json) as string[],
      complexity: row.complexity,
      successCount: row.success_count,
      lastUsedAt: row.last_used_at ?? undefined,
      createdAt: row.created_at
    };
  }

  updateAnalyticSkill(id: string, updates: Partial<AnalyticSkill>): void {
    const row = this.db
      .prepare(
        `SELECT id, category, description, sql_text, warehouse, tags_json, complexity, success_count, last_used_at, created_at
         FROM analytic_skills
         WHERE id = ?`
      )
      .get(id) as
      | {
          id: string;
          category: string;
          description: string;
          sql_text: string;
          warehouse: string;
          tags_json: string;
          complexity: number;
          success_count: number;
          last_used_at: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) {
      return;
    }
    const next = {
      category: updates.category ?? row.category,
      description: updates.description ?? row.description,
      sql_text: updates.sql ?? row.sql_text,
      warehouse: updates.warehouse ?? row.warehouse,
      tags_json: updates.tags ? JSON.stringify(updates.tags) : row.tags_json,
      complexity: updates.complexity ?? row.complexity,
      success_count: updates.successCount ?? row.success_count,
      last_used_at: updates.lastUsedAt === undefined ? row.last_used_at : (updates.lastUsedAt ?? null)
    };
    this.db
      .prepare(
        `UPDATE analytic_skills
         SET category = ?, description = ?, sql_text = ?, warehouse = ?, tags_json = ?, complexity = ?, success_count = ?, last_used_at = ?
         WHERE id = ?`
      )
      .run(
        next.category,
        next.description,
        next.sql_text,
        next.warehouse,
        next.tags_json,
        next.complexity,
        next.success_count,
        next.last_used_at,
        id
      );
  }

  // ─── Harness storage: tenant context ────────────────────

  getTenantContext(tenantId: string): string | null {
    const row = this.db
      .prepare("SELECT content FROM tenant_context WHERE tenant_id = ?")
      .get(tenantId) as { content: string } | undefined;
    return row ? row.content : null;
  }

  saveTenantContext(tenantId: string, content: string): void {
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tenant_context (tenant_id, content, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
           content = excluded.content,
           updated_at = excluded.updated_at`
      )
      .run(tenantId, content, updatedAt);
  }

  // ─── Harness storage: session summaries ──────────────────

  saveSessionSummary(params: {
    conversationId: string;
    tenantId: string;
    summaryText: string;
    topics: string[];
    messageCount: number;
    lastExchanges: Array<{ role: string; content: string }>;
  }): void {
    const lastMessageAt = new Date().toISOString();
    const createdAt = lastMessageAt;
    this.db
      .prepare(
        `INSERT INTO session_summaries
         (conversation_id, tenant_id, summary_text, topics_json, message_count, last_exchanges_json, last_message_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, tenant_id) DO UPDATE SET
           summary_text = excluded.summary_text,
           topics_json = excluded.topics_json,
           message_count = excluded.message_count,
           last_exchanges_json = excluded.last_exchanges_json,
           last_message_at = excluded.last_message_at`
      )
      .run(
        params.conversationId,
        params.tenantId,
        params.summaryText,
        JSON.stringify(params.topics),
        params.messageCount,
        params.lastExchanges.length > 0 ? JSON.stringify(params.lastExchanges) : null,
        lastMessageAt,
        createdAt
      );
  }

  getSessionResumeData(
    conversationId: string,
    tenantId: string
  ): {
    summaryText: string;
    topics: string[];
    messageCount: number;
    lastExchanges: Array<{ role: string; content: string }>;
  } | null {
    const row = this.db
      .prepare(
        `SELECT summary_text, topics_json, message_count, last_exchanges_json
         FROM session_summaries
         WHERE conversation_id = ? AND tenant_id = ?`
      )
      .get(conversationId, tenantId) as
      | {
          summary_text: string;
          topics_json: string;
          message_count: number;
          last_exchanges_json: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      summaryText: row.summary_text,
      topics: JSON.parse(row.topics_json) as string[],
      messageCount: row.message_count,
      lastExchanges: row.last_exchanges_json
        ? (JSON.parse(row.last_exchanges_json) as Array<{ role: string; content: string }>)
        : []
    };
  }
}
