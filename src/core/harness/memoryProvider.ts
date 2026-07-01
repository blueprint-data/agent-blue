import { TurnRecord, ToolSchema } from "./types.js";
import type { ConversationStore } from "../interfaces.js";
import type { AnalyticSkill } from "../types.js";

/**
 * MemoryProvider — pluggable memory backend for the agent harness.
 *
 * Lifecycle:
 *   initialize → prefetch (per turn) → syncTurn (per turn) → shutdown
 *
 * Built-in implementations:
 * - SqliteMemoryProvider: uses existing better-sqlite3 + ConversationStore
 * - EngramMemoryProvider: shells out to engram CLI (future)
 */
export interface MemoryProvider {
  readonly name: string;

  /** Initialize the provider for a session. Called once at start. */
  initialize(sessionId: string, tenantId: string): Promise<void>;

  /** Clean shutdown. Called at session end. */
  shutdown(): Promise<void>;

  /** Recall relevant context before processing a user message. */
  prefetch(query: string): Promise<string>;

  /** Persist a completed turn. Called after each response. */
  syncTurn(turn: TurnRecord): Promise<void>;

  /** Called when a session ends. Use for final extraction. */
  onSessionEnd(messages: Record<string, unknown>[]): Promise<void>;

  /** Called when session_id changes mid-stream (compression, branch, resume). */
  onSessionSwitch(newSessionId: string): Promise<void>;

  /** Extract insights before context compression discards old messages. */
  onPreCompress(messages: Record<string, unknown>[]): Promise<string>;

  /** Return tool schemas this provider exposes to the agent. */
  getToolSchemas(): ToolSchema[];

  /** Handle a tool call for one of this provider's exposed tools. */
  handleToolCall(name: string, args: Record<string, unknown>): Promise<string>;
}

/**
 * SqliteMemoryProvider — persists memory to the existing agent.db via ConversationStore.
 *
 * Uses:
 * - searchAnalyticSkills for prefetch
 * - analytic_skills table for pattern storage
 * - tenant_context and session_summaries tables
 */
export class SqliteMemoryProvider implements MemoryProvider {
  readonly name = "sqlite";
  private store: ConversationStore;
  private sessionId = "";
  private tenantId = "";

  constructor(store: ConversationStore) {
    this.store = store;
  }

  async initialize(sessionId: string, tenantId: string): Promise<void> {
    this.sessionId = sessionId;
    this.tenantId = tenantId;
  }

  async shutdown(): Promise<void> {
    // SQLite store is managed by the application lifecycle, not here
  }

  async prefetch(query: string): Promise<string> {
    try {
      const skills = this.store.searchAnalyticSkills(query, 5);
      if (skills.length === 0) return "";

      const blocks = skills.map((s, i) =>
        `[Skill ${i + 1}] ${s.description}\nSQL: ${s.sql}\n`
      );
      return `## Relevant Analytics Patterns\n${blocks.join("\n")}`;
    } catch {
      return "";
    }
  }

  async syncTurn(turn: TurnRecord): Promise<void> {
    // Future: extract key facts and persist to a memory_entries table
  }

  async onSessionEnd(messages: Record<string, unknown>[]): Promise<void> {
    // Future: final extraction
  }

  async onSessionSwitch(newSessionId: string): Promise<void> {
    this.sessionId = newSessionId;
  }

  async onPreCompress(messages: Record<string, unknown>[]): Promise<string> {
    return "";
  }

  getToolSchemas(): ToolSchema[] {
    return [];
  }

  async handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
    throw new Error(`SqliteMemoryProvider: unknown tool "${name}"`);
  }

  /** Access the underlying store for direct operations */
  getStore(): ConversationStore {
    return this.store;
  }
}

/**
 * EngramMemoryProvider — shells out to the Engram CLI for cross-session persistence.
 *
 * This is a lightweight wrapper that uses engram CLI for:
 * - mem_search for prefetch
 * - mem_save for syncTurn
 */
export class EngramMemoryProvider implements MemoryProvider {
  readonly name = "engram";
  private project = "";
  private sessionId = "";
  private tenantId = "";

  constructor(project: string) {
    this.project = project;
  }

  async initialize(sessionId: string, tenantId: string): Promise<void> {
    this.sessionId = sessionId;
    this.tenantId = tenantId;
  }

  async shutdown(): Promise<void> {}

  async prefetch(query: string): Promise<string> {
    // Would shell out to: engram search --type pattern --project <project>
    return "";
  }

  async syncTurn(turn: TurnRecord): Promise<void> {}
  async onSessionEnd(messages: Record<string, unknown>[]): Promise<void> {}
  async onSessionSwitch(newSessionId: string): Promise<void> {
    this.sessionId = newSessionId;
  }
  async onPreCompress(messages: Record<string, unknown>[]): Promise<string> {
    return "";
  }
  getToolSchemas(): ToolSchema[] {
    return [];
  }
  async handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
    throw new Error(`EngramMemoryProvider: unknown tool "${name}"`);
  }

  getProject(): string { return this.project; }
}
