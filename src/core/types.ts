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
  allowedTools: string[];
  blockedSchemaPatterns: string[];
  blockedTablePatterns: string[];
  toolTimeoutMs: number;
  maxToolRetries: number;
  maxPlannerSteps: number;
  createdAt: string;
}

export type TenantMemorySource = "agent" | "manual";

export interface TenantMemory {
  id: string;
  tenantId: string;
  content: string;
  source: TenantMemorySource;
  createdAt: string;
  updatedAt: string;
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

export type ConversationSource = "cli" | "slack" | "telegram" | "admin";

export interface ConversationOrigin {
  source: ConversationSource;
  teamId?: string;
  channelId?: string;
  threadTs?: string;
  userId?: string;
}

export type AgentExecutionStatus = "running" | "completed" | "failed";

export interface ExecutionBudget {
  maxPlannerSteps: number;
  maxRowsPerQuery: number;
  toolTimeoutMs: number;
  maxToolRetries: number;
  contextBudgetChars: {
    tenantMemory: number;
    dbtModels: number;
    historySummary: number;
  };
}

export interface ContextSectionDiagnostic {
  section: string;
  includedItems: number;
  totalItems: number;
  approxChars: number;
  truncated: boolean;
  notes?: string[];
}

export type ExecutionTraceEventLevel = "info" | "success" | "warning" | "error";

export type ExecutionTraceEventType =
  | "turn.started"
  | "context.compiled"
  | "planner.invalid_json"
  | "planner.decision"
  | "policy.approved"
  | "policy.denied"
  | "tool.started"
  | "tool.retry"
  | "tool.completed"
  | "tool.failed"
  | "tool.reused"
  | "feedback.observation"
  | "turn.finalized";

export interface ExecutionTraceEvent {
  id: string;
  turnId: string;
  tenantId: string;
  conversationId: string;
  step?: number;
  type: ExecutionTraceEventType;
  level: ExecutionTraceEventLevel;
  message: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface ToolExecutionRecord {
  id: string;
  turnId: string;
  tenantId: string;
  conversationId: string;
  step?: number;
  cacheKey: string;
  tool: string;
  input: Record<string, unknown>;
  status: "ok" | "error" | "reused";
  durationMs: number;
  attemptCount: number;
  outputSummary?: Record<string, unknown>;
  output?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentExecutionTurn {
  id: string;
  tenantId: string;
  conversationId: string;
  traceId?: string;
  source: ConversationSource;
  rawUserText: string;
  promptText: string;
  assistantText?: string;
  status: AgentExecutionStatus;
  errorMessage?: string;
  debug?: Record<string, unknown>;
  events?: ExecutionTraceEvent[];
  toolExecutions?: ToolExecutionRecord[];
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

export type ScheduleChannelType = "slack" | "telegram" | "console" | "custom";

export interface TenantSchedule {
  id: string;
  tenantId: string;
  userRequest: string;
  cron: string;
  channelType: ScheduleChannelType;
  channelRef?: string | null;
  active: boolean;
  lastRunAt?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}
