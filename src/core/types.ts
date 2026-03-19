export type Role = "system" | "user" | "assistant" | "tool";

export interface ConversationMessage {
  id: string;
  tenantId: string;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: string;
}

export interface AgentProfile {
  id: string;
  tenantId: string;
  name: string;
  soulPrompt: string;
  maxRowsPerQuery: number;
  allowedDbtPathPrefixes: string[];
  createdAt: string;
}

export type TenantMemoryStatus = "active" | "deleted";

export interface TenantMemory {
  id: string;
  tenantId: string;
  summary: string;
  status: TenantMemoryStatus;
  createdAt: string;
  updatedAt: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  lastUsedAt?: string;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface DbtModelInfo {
  name: string;
  relativePath: string;
}

export interface AgentContext {
  tenantId: string;
  profileName: string;
  conversationId: string;
  llmModel?: string;
  origin?: ConversationOrigin;
}

export interface AgentArtifact {
  type: "chartjs_config";
  format: "json";
  payload: Record<string, unknown>;
  summary?: Record<string, unknown>;
}

export interface AgentResponse {
  text: string;
  artifacts?: AgentArtifact[];
  debug?: Record<string, unknown>;
}

export type ConversationSource = "cli" | "slack" | "admin";

export interface ConversationOrigin {
  source: ConversationSource;
  teamId?: string;
  channelId?: string;
  threadTs?: string;
  userId?: string;
}

export type AgentExecutionStatus = "running" | "completed" | "failed";

export interface AgentExecutionTurn {
  id: string;
  tenantId: string;
  conversationId: string;
  source: ConversationSource;
  rawUserText: string;
  promptText: string;
  assistantText?: string;
  status: AgentExecutionStatus;
  errorMessage?: string;
  debug?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AdminConversationSummary {
  conversationId: string;
  tenantId: string;
  profileName: string;
  source?: ConversationSource;
  teamId?: string;
  channelId?: string;
  threadTs?: string;
  userId?: string;
  createdAt: string;
  lastMessageAt: string;
  messageCount: number;
  latestTurnStatus?: AgentExecutionStatus;
  latestUserText?: string;
  latestAssistantText?: string;
}

export interface AdminConversationDetail {
  summary: AdminConversationSummary;
  messages: ConversationMessage[];
  executionTurns: AgentExecutionTurn[];
}

export type AdminBotLifecycleState = "stopped" | "starting" | "running" | "stopping" | "error";

export interface AdminBotState {
  botName: string;
  desiredState: "running" | "stopped";
  actualState: AdminBotLifecycleState;
  port?: number;
  lastStartedAt?: string;
  lastStoppedAt?: string;
  lastErrorAt?: string;
  lastErrorMessage?: string;
  updatedAt: string;
}

export interface AdminBotEvent {
  id: string;
  botName: string;
  level: "info" | "warn" | "error";
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}
