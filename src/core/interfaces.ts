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
  DbtModelInfo,
  QueryResult,
  TenantMemory,
  TenantMemorySource
} from "./types.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmProvider {
  generateText(input: { model: string; messages: LlmMessage[]; temperature?: number }): Promise<string>;
}

export interface WarehouseAdapter {
  readonly provider?: TenantWarehouseProvider;
  query(sql: string, opts?: { timeoutMs?: number }): Promise<QueryResult>;
}

export interface ChartBuildRequest {
  type?: "bar" | "line" | "pie" | "doughnut";
  title?: string;
  xKey?: string;
  yKey?: string;
  seriesKey?: string;
  horizontal?: boolean;
  stacked?: boolean;
  grouped?: boolean;
  percentStacked?: boolean;
  sort?: "none" | "asc" | "desc" | "label_asc" | "label_desc";
  smooth?: boolean;
  tension?: number;
  fill?: boolean;
  step?: boolean;
  pointRadius?: number;
  donutCutout?: number;
  showPercentLabels?: boolean;
  topN?: number;
  otherLabel?: string;
  stackId?: string;
  maxPoints?: number;
}

export interface ChartBuildResult {
  config: Record<string, unknown>;
  summary: {
    type: string;
    xKey: string | null;
    yKey: string | null;
    seriesKey: string | null;
    labelsCount: number;
    datasetsCount: number;
    pointsCount: number;
  };
}

export interface ChartTool {
  buildFromQueryResult(input: {
    request: ChartBuildRequest;
    result: QueryResult;
    maxPoints: number;
  }): ChartBuildResult;
}

export interface DbtRepositoryService {
  syncRepo(tenantId: string): Promise<void>;
  listModels(tenantId: string, dbtSubpath?: string): Promise<DbtModelInfo[]>;
  getModelSql(tenantId: string, modelName: string, dbtSubpath?: string): Promise<string | null>;
}

export type SlackTenantMappingRule =
  | "channel"
  | "shared_team"
  | "user"
  | "team"
  | "owner_default"
  | "unmapped";

export interface SlackTenantResolution {
  tenantId: string;
  rule: SlackTenantMappingRule;
}

export interface ConversationStore {
  init(): void;
  createConversation(context: AgentContext): void;
  addMessage(message: Omit<ConversationMessage, "id" | "createdAt">): ConversationMessage;
  getMessages(conversationId: string, limit?: number): ConversationMessage[];
  listTenantMemories(tenantId: string, limit?: number): TenantMemory[];
  getTenantMemory(tenantId: string, memoryId: string): TenantMemory | null;
  createTenantMemory(input: { tenantId: string; content: string; source: TenantMemorySource }): TenantMemory;
  deleteTenantMemory(memoryId: string): void;
  getOrCreateProfile(tenantId: string, profileName: string): AgentProfile;
  upsertTenantRepo(input: {
    tenantId: string;
    repoUrl: string;
    dbtSubpath: string;
    deployKeyPath: string;
    localPath: string;
  }): void;
  getTenantRepo(tenantId: string): {
    tenantId: string;
    repoUrl: string;
    dbtSubpath: string;
    deployKeyPath: string;
    localPath: string;
  } | null;

  getSlackChannelTenant(channelId: string): string | null;
  upsertSlackChannelTenant(channelId: string, tenantId: string, source?: string): void;
  getSlackUserTenant(userId: string): string | null;
  upsertSlackUserTenant(userId: string, tenantId: string): void;
  getSlackSharedTeamTenant(sharedTeamId: string): string | null;
  upsertSlackSharedTeamTenant(sharedTeamId: string, tenantId: string): void;
  listSlackChannelMappings(): Array<{ channelId: string; tenantId: string; source: string; updatedAt: string }>;
  listSlackUserMappings(): Array<{ userId: string; tenantId: string; updatedAt: string }>;
  listSlackSharedTeamMappings(): Array<{ sharedTeamId: string; tenantId: string; updatedAt: string }>;
  tryMarkSlackEventProcessed(input: {
    eventKey: string;
    eventId?: string | null;
    eventType?: string | null;
    teamId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    messageTs?: string | null;
  }): boolean;
  logSlackTenantRoutingAudit?(input: {
    messageTs: string;
    channelId: string;
    userId: string | null;
    resolvedTenant: string;
    ruleUsed: string;
  }): void;

  getTelegramChatTenant(chatId: string): string | null;
  upsertTelegramChatTenant(chatId: string, tenantId: string, source?: string): void;
  listTelegramChatMappings(): Array<{ chatId: string; tenantId: string; source: string; updatedAt: string }>;
  deleteTelegramChatMapping(chatId: string): void;

  // Admin operations
  listTenants(): Array<{
    tenantId: string;
    repoUrl: string;
    dbtSubpath: string;
    deployKeyPath: string;
    localPath: string;
    updatedAt: string;
  }>;
  deleteTenant(tenantId: string): void;
  deleteSlackChannelMapping(channelId: string): void;
  deleteSlackUserMapping(userId: string): void;
  deleteSlackSharedTeamMapping(sharedTeamId: string): void;
  getGuardrails(): AdminGuardrails | null;
  upsertGuardrails(input: AdminGuardrails): void;
  getTenantCredentialsRef(tenantId: string): TenantCredentialsRef | null;
  upsertTenantCredentialsRef(input: TenantCredentialsRef): void;
  getTenantWarehouseConfig(tenantId: string): TenantWarehouseConfig | null;
  upsertTenantWarehouseConfig(input: Omit<TenantWarehouseConfig, "updatedAt">): void;
  getTenantKeyMetadata(tenantId: string): TenantKeyMetadata | null;
  upsertTenantKeyMetadata(input: TenantKeyMetadata): void;
  deleteTenantKeyMetadata(tenantId: string): void;
  upsertConversationOrigin(conversationId: string, tenantId: string, origin: ConversationOrigin): void;
  getConversationOrigin(conversationId: string): ConversationOrigin | null;
  createExecutionTurn(input: Omit<AgentExecutionTurn, "id" | "createdAt" | "updatedAt">): AgentExecutionTurn;
  completeExecutionTurn(input: {
    turnId: string;
    status: "completed" | "failed";
    assistantText?: string;
    errorMessage?: string;
    debug?: Record<string, unknown>;
    completedAt?: string;
  }): void;
  getExecutionTurn(turnId: string): AgentExecutionTurn | null;
  listExecutionTurns(conversationId: string): AgentExecutionTurn[];
  listAdminConversations(input?: {
    tenantId?: string;
    source?: ConversationSource;
    search?: string;
    limit?: number;
  }): AdminConversationSummary[];
  getAdminConversationDetail(conversationId: string): AdminConversationDetail | null;
  getAdminBotState(botName: string): AdminBotState | null;
  upsertAdminBotState(input: Omit<AdminBotState, "updatedAt">): AdminBotState;
  appendAdminBotEvent(input: Omit<AdminBotEvent, "id" | "createdAt">): AdminBotEvent;
  listAdminBotEvents(botName: string, limit?: number): AdminBotEvent[];
  createAdminSession(input: Omit<AdminSession, "lastSeenAt"> & { lastSeenAt?: string }): void;
  getAdminSession(sessionId: string): AdminSession | null;
  touchAdminSession(sessionId: string, lastSeenAt: string, expiresAt?: string): void;
  deleteAdminSession(sessionId: string): void;
  deleteExpiredAdminSessions(nowIso?: string): number;
}

export interface AdminGuardrails {
  defaultTenantId?: string;
  ownerTeamIds: string[];
  ownerEnterpriseIds: string[];
  strictTenantRouting: boolean;
  teamTenantMap?: Record<string, string>;
}

export interface TenantCredentialsRef {
  tenantId: string;
  deployKeyPath?: string;
  warehouseMetadata?: { provider?: string; lastRotated?: string };
}

/** Metadata for tenant Snowflake .p8 key file (path + metadata only; no raw key content). */
export interface TenantKeyMetadata {
  tenantId: string;
  filePath: string;
  uploadedAt: string;
  fingerprint?: string;
}

export type TenantWarehouseProvider = "snowflake" | "bigquery";

export interface TenantSnowflakeConfig {
  account: string;
  username: string;
  warehouse: string;
  database: string;
  schema: string;
  role?: string;
  authType: "password" | "keypair";
  /** For keypair: path to private key file */
  privateKeyPath?: string;
  /** For password: env var name to read password from (e.g. TENANT_X_SNOWFLAKE_PASSWORD) */
  passwordEnvVar?: string;
}

export interface TenantBigQueryConfig {
  projectId: string;
  dataset?: string;
  location?: string;
  authType?: "adc" | "service-account-key";
  serviceAccountKeyPath?: string;
}

export interface TenantWarehouseConfig {
  tenantId: string;
  provider: TenantWarehouseProvider;
  snowflake?: TenantSnowflakeConfig;
  bigquery?: TenantBigQueryConfig;
  updatedAt: string;
}

export interface AdminSession {
  sessionId: string;
  username: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface ChannelAdapter {
  send(text: string): Promise<void>;
}
