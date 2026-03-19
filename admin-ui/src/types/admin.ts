export interface SessionState {
  authenticated: boolean;
  username?: string;
  method?: string;
  loginEnabled: boolean;
}

export interface TenantRecord {
  tenantId: string;
  repoUrl: string;
  dbtSubpath: string;
  deployKeyPath: string;
  localPath: string;
  updatedAt: string;
}

export interface TenantMemoryRecord {
  id: string;
  tenantId: string;
  summary: string;
  status: "active" | "deleted";
  createdAt: string;
  updatedAt: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  lastUsedAt?: string;
}

export interface SlackMappingsResponse {
  channels: Array<{ channelId: string; tenantId: string; source: string; updatedAt: string }>;
  users: Array<{ userId: string; tenantId: string; updatedAt: string }>;
  sharedTeams: Array<{ sharedTeamId: string; tenantId: string; updatedAt: string }>;
}

export interface GuardrailsResponse {
  defaultTenantId?: string;
  ownerTeamIds: string[];
  ownerEnterpriseIds: string[];
  strictTenantRouting: boolean;
  teamTenantMap: Record<string, string>;
}

export interface CredentialReference {
  tenantId: string;
  deployKeyPath?: string;
  warehouseMetadata?: Record<string, string>;
  snowflakeKeyPath?: string | null;
  snowflakeKeyUploadedAt?: string | null;
}

export interface WizardStateResponse {
  tenantId: string;
  hasRepo: boolean;
  hasWarehouseConfig: boolean;
  warehouseProvider?: string;
  slackChannelCount: number;
  slackUserCount: number;
  slackSharedTeamCount: number;
}

export interface ConversationSummary {
  conversationId: string;
  tenantId: string;
  profileName: string;
  source?: string;
  teamId?: string;
  channelId?: string;
  threadTs?: string;
  userId?: string;
  createdAt: string;
  lastMessageAt: string;
  messageCount: number;
  latestTurnStatus?: string;
  latestUserText?: string;
  latestAssistantText?: string;
}

export interface ConversationMessage {
  id: string;
  tenantId: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: string;
}

export interface ExecutionTurn {
  id: string;
  tenantId: string;
  conversationId: string;
  source: string;
  rawUserText: string;
  promptText: string;
  assistantText?: string;
  status: string;
  errorMessage?: string;
  debug?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ConversationDetail {
  summary: ConversationSummary;
  messages: ConversationMessage[];
  executionTurns: ExecutionTurn[];
}

export interface BotStatus {
  botName: string;
  desiredState: string;
  actualState: string;
  port?: number;
  lastStartedAt?: string;
  lastStoppedAt?: string;
  lastErrorAt?: string;
  lastErrorMessage?: string;
  updatedAt: string;
}

export interface BotEvent {
  id: string;
  botName: string;
  level: "info" | "warn" | "error";
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface NotificationState {
  type: "success" | "error" | "info";
  text: string;
}

export interface KeyUploadResponse {
  tenantId: string;
  filePath: string;
  uploadedAt: string;
  fingerprint: string;
  message: string;
}

export interface TenantFormState {
  tenantId: string;
  repoUrl: string;
  dbtSubpath: string;
}

export interface NewTenantWizardState {
  tenantId: string;
  repoUrl: string;
  dbtSubpath: string;
  account: string;
  username: string;
  warehouse: string;
  database: string;
  schema: string;
  role: string;
  authType: "keypair" | "password";
  privateKeyPath: string;
  passwordEnvVar: string;
  channelInput: string;
  userInput: string;
  teamInput: string;
  channels: string[];
  users: string[];
  sharedTeams: string[];
  wizardTenantId: string | null;
  results: Record<string, unknown>;
  uploadingKey: boolean;
}

export interface ConversationFilters {
  tenantId: string;
  source: string;
  search: string;
}

export interface MappingDrafts {
  channelId: string;
  channelTenantId: string;
  userId: string;
  userTenantId: string;
  teamId: string;
  teamTenantId: string;
}

export type NotifyFn = (value: NotificationState | null) => void;
export type MappingKind = "channels" | "users" | "shared-teams";
