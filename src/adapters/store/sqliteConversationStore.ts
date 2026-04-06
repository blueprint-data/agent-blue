import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import type {
  AdminSession,
  AdminGuardrails,
  ConversationStore,
  TenantCredentialsRef,
  TenantKeyMetadata,
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
  ConversationMessage,
  ConversationOrigin,
  ConversationSource,
  ScheduleChannelType,
  TenantMemory,
  TenantMemorySource,
  TenantSchedule
} from "../../core/types.js";
import { createId } from "../../utils/id.js";

const DEFAULT_SOUL_PROMPT = [
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

      CREATE TABLE IF NOT EXISTS tenant_schedules (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_request TEXT NOT NULL,
        cron TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        channel_ref TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenant_key_metadata (
        tenant_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        uploaded_at TEXT NOT NULL,
        fingerprint TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        session_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        user_agent TEXT,
        ip_address TEXT
      );

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
    `);
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

  private mapTenantScheduleRow(row: {
    id: string;
    tenant_id: string;
    user_request: string;
    cron: string;
    channel_type: string;
    channel_ref: string;
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
      channelRef: row.channel_ref,
      active: Boolean(row.active),
      lastRunAt: row.last_run_at ?? undefined,
      lastError: row.last_error ?? undefined,
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

  listTenantSchedules(tenantId: string): TenantSchedule[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, user_request, cron, channel_type, channel_ref, active, last_run_at, last_error, created_at, updated_at
         FROM tenant_schedules
         WHERE tenant_id = ?
         ORDER BY created_at DESC, rowid DESC`
      )
      .all(tenantId) as Array<{
      id: string;
      tenant_id: string;
      user_request: string;
      cron: string;
      channel_type: string;
      channel_ref: string;
      active: number;
      last_run_at: string | null;
      last_error: string | null;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => this.mapTenantScheduleRow(row));
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
          channel_ref: string;
          active: number;
          last_run_at: string | null;
          last_error: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    return row ? this.mapTenantScheduleRow(row) : null;
  }

  createTenantSchedule(input: {
    tenantId: string;
    userRequest: string;
    cron: string;
    channelType: ScheduleChannelType;
    channelRef: string;
    active?: boolean;
  }): TenantSchedule {
    const id = createId("sched");
    const createdAt = new Date().toISOString();
    const active = input.active ?? true;
    this.db
      .prepare(
        `INSERT INTO tenant_schedules (id, tenant_id, user_request, cron, channel_type, channel_ref, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.tenantId, input.userRequest, input.cron, input.channelType, input.channelRef, active ? 1 : 0, createdAt, createdAt);
    return {
      id,
      tenantId: input.tenantId,
      userRequest: input.userRequest,
      cron: input.cron,
      channelType: input.channelType,
      channelRef: input.channelRef,
      active,
      createdAt,
      updatedAt: createdAt
    };
  }

  updateTenantSchedule(
    scheduleId: string,
    updates: Partial<Omit<TenantSchedule, "id" | "tenantId" | "createdAt">>
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
          channel_ref: string;
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
    const nextUserRequest = updates.userRequest ?? existing.user_request;
    const nextCron = updates.cron ?? existing.cron;
    const nextChannelType = updates.channelType ?? (existing.channel_type as ScheduleChannelType);
    const nextChannelRef = updates.channelRef ?? existing.channel_ref;
    const nextActive = updates.active ?? Boolean(existing.active);
    const nextLastRunAt = updates.lastRunAt ?? existing.last_run_at ?? undefined;
    const nextLastError = updates.lastError ?? existing.last_error ?? undefined;

    this.db
      .prepare(
        `UPDATE tenant_schedules
         SET user_request = ?, cron = ?, channel_type = ?, channel_ref = ?, active = ?, last_run_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        nextUserRequest,
        nextCron,
        nextChannelType,
        nextChannelRef,
        nextActive ? 1 : 0,
        nextLastRunAt ?? null,
        nextLastError ?? null,
        updatedAt,
        scheduleId
      );

    return {
      id: existing.id,
      tenantId: existing.tenant_id,
      userRequest: nextUserRequest,
      cron: nextCron,
      channelType: nextChannelType,
      channelRef: nextChannelRef,
      active: nextActive,
      lastRunAt: nextLastRunAt,
      lastError: nextLastError,
      createdAt: existing.created_at,
      updatedAt
    };
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
        `SELECT id, tenant_id, name, soul_prompt, max_rows_per_query, allowed_dbt_path_prefixes, created_at
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
        createdAt: row.created_at
      };
    }

    const id = createId("profile");
    const createdAt = new Date().toISOString();
    const prefixes = ["models"];

    this.db
      .prepare(
        `INSERT INTO agent_profiles
         (id, tenant_id, name, soul_prompt, max_rows_per_query, allowed_dbt_path_prefixes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, tenantId, profileName, DEFAULT_SOUL_PROMPT, 200, JSON.stringify(prefixes), createdAt);

    return {
      id,
      tenantId,
      name: profileName,
      soulPrompt: DEFAULT_SOUL_PROMPT,
      maxRowsPerQuery: 200,
      allowedDbtPathPrefixes: prefixes,
      createdAt
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
         (id, tenant_id, conversation_id, source, raw_user_text, prompt_text, assistant_text, status, error_message, debug_json, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.tenantId,
        input.conversationId,
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
        `SELECT id, tenant_id, conversation_id, source, raw_user_text, prompt_text, assistant_text, status,
                error_message, debug_json, created_at, updated_at, completed_at
         FROM agent_execution_turns
         WHERE id = ?`
      )
      .get(turnId) as
      | {
          id: string;
          tenant_id: string;
          conversation_id: string;
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
      source: row.source,
      rawUserText: row.raw_user_text,
      promptText: row.prompt_text,
      assistantText: row.assistant_text ?? undefined,
      status: row.status,
      errorMessage: row.error_message ?? undefined,
      debug: row.debug_json ? (JSON.parse(row.debug_json) as Record<string, unknown>) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined
    };
  }

  listExecutionTurns(conversationId: string): AgentExecutionTurn[] {
    const rows = this.db
      .prepare(
        `SELECT id
         FROM agent_execution_turns
         WHERE conversation_id = ?
         ORDER BY created_at ASC`
      )
      .all(conversationId) as Array<{ id: string }>;
    return rows
      .map((row) => this.getExecutionTurn(row.id))
      .filter((turn): turn is AgentExecutionTurn => turn !== null);
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

  createAdminSession(input: Omit<AdminSession, "lastSeenAt"> & { lastSeenAt?: string }): void {
    const lastSeenAt = input.lastSeenAt ?? input.createdAt;
    this.db
      .prepare(
        `INSERT INTO admin_sessions (session_id, username, created_at, expires_at, last_seen_at, user_agent, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.sessionId,
        input.username,
        input.createdAt,
        input.expiresAt,
        lastSeenAt,
        input.userAgent ?? null,
        input.ipAddress ?? null
      );
  }

  getAdminSession(sessionId: string): AdminSession | null {
    const row = this.db
      .prepare(
        `SELECT session_id, username, created_at, expires_at, last_seen_at, user_agent, ip_address
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
      ipAddress: row.ip_address ?? undefined
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
}
