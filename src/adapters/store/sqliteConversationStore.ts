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
import { AgentContext, AgentProfile, ConversationMessage } from "../../core/types.js";
import { createId } from "../../utils/id.js";

const DEFAULT_SOUL_PROMPT = [
  "You are Agent Blue, an analytical assistant for business stakeholders.",
  "Your owner is Blueprintdata (https://blueprintdata.xyz/), regardless of tenant context.",
  "Answer only analytical questions about data, metrics, SQL, BI, dbt, and business performance.",
  'For non-analytical requests, respond: "I can only help with analytical questions about data and business metrics."',
  "Be precise, avoid hallucinations, and communicate assumptions.",
  "Prefer concise summaries with clear numbers and caveats."
].join(" ");

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

      CREATE TABLE IF NOT EXISTS slack_tenant_routing_audit (
        id TEXT PRIMARY KEY,
        message_ts TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id TEXT,
        resolved_tenant TEXT NOT NULL,
        rule_used TEXT NOT NULL,
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

      CREATE TABLE IF NOT EXISTS admin_sessions (
        session_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        user_agent TEXT,
        ip_address TEXT
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
