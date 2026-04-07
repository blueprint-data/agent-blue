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
  ScheduleChannelType,
  TenantMemory,
  TenantMemorySource,
  TenantSchedule
} from "./types.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Subset of OpenAI/OpenRouter chat completion usage; fields optional when provider omits them. */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** OpenRouter/native billed amount when present (credits or provider-specific). */
  cost?: number;
}

export interface LlmGenerateResult {
  text: string;
  usage?: LlmUsage;
  generationId?: string;
}

export interface LlmProvider {
  generateText(input: { model: string; messages: LlmMessage[]; temperature?: number }): Promise<LlmGenerateResult>;
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
  | "unmapped"
  | "tenant_app_url";

export interface SlackTenantResolution {
  tenantId: string;
  rule: SlackTenantMappingRule;
}

export interface TenantLlmSettings {
  tenantId: string;
  llmModel: string | null;
  updatedAt: string;
}

export interface InsertLlmUsageEventInput {
  tenantId: string;
  executionTurnId: string;
  conversationId: string;
  model: string;
  generationId?: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number | null;
  callIndex: number;
}

export interface LlmUsageEventRow {
  id: string;
  tenantId: string;
  executionTurnId: string;
  conversationId: string;
  createdAt: string;
  model: string;
  generationId: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number | null;
  callIndex: number;
}

export interface TenantLlmUsageSummary {
  requestCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  /** Sum of reported costs when present (OpenRouter credits). */
  totalCost: number;
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
  /** domain (lowercase) -> tenantId for Google admin login; DB rows only (use merge with env in API). */
  getAdminLoginDomainTenantMap(): Record<string, string>;
  listAdminLoginDomainsForTenant(tenantId: string): string[];
  /** Replaces all DB domains for the tenant. Domains must be unique globally. Throws if tenant missing or domain owned by another tenant. */
  setAdminLoginDomainsForTenant(tenantId: string, domains: string[]): void;

  listTenantSchedules(tenantId: string): TenantSchedule[];
  getTenantSchedule(tenantId: string, scheduleId: string): TenantSchedule | null;
  createTenantSchedule(input: {
    tenantId: string;
    userRequest: string;
    cron: string;
    channelType: ScheduleChannelType;
    channelRef?: string | null;
    active?: boolean;
  }): TenantSchedule;
  updateTenantSchedule(
    scheduleId: string,
    updates: Partial<Omit<TenantSchedule, "id" | "tenantId" | "createdAt" | "updatedAt">>
  ): TenantSchedule | null;
  deleteTenantSchedule(scheduleId: string): void;
  getTenantChannelBotSecrets(tenantId: string): TenantChannelBotSecrets | null;
  /** Replaces stored row for the tenant (caller merges partial updates). */
  upsertTenantChannelBotSecrets(input: {
    tenantId: string;
    slackBotToken: string | null;
    slackSigningSecret: string | null;
    telegramBotToken: string | null;
  }): void;
  /** Tenants with a non-empty per-tenant Telegram bot token (for multi-bot polling). */
  listTenantTelegramBotOverrides(): Array<{ tenantId: string; telegramBotToken: string }>;

  getTenantLlmSettings(tenantId: string): TenantLlmSettings | null;
  upsertTenantLlmSettings(tenantId: string, llmModel: string | null): TenantLlmSettings;
  insertLlmUsageEvent(input: InsertLlmUsageEventInput): void;
  getTenantLlmUsageSummary(
    tenantId: string,
    range?: { fromIso?: string; toIso?: string }
  ): TenantLlmUsageSummary;
  listTenantLlmUsageEvents(
    tenantId: string,
    opts?: { limit?: number; fromIso?: string; toIso?: string }
  ): LlmUsageEventRow[];
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

/** Per-tenant Slack app + Telegram bot tokens (stored server-side; never returned to clients). */
export interface TenantChannelBotSecrets {
  tenantId: string;
  slackBotToken: string | null;
  slackSigningSecret: string | null;
  telegramBotToken: string | null;
  updatedAt: string;
}

export type AdminPrincipalRole = "superadmin" | "tenant_admin";

export type AdminAuthProvider = "password" | "google";

export interface AdminSession {
  sessionId: string;
  username: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent?: string;
  ipAddress?: string;
  authProvider: AdminAuthProvider;
  email?: string;
  googleSub?: string;
  role: AdminPrincipalRole;
  /** When role is tenant_admin, the only tenant this principal may access. */
  scopedTenantId?: string | null;
}

export interface ChannelAdapter {
  send(text: string): Promise<void>;
}
