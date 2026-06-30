import { ContextCompressor } from "./contextCompressor.js";
import { IterationBudget } from "./iterationBudget.js";
import type { MemoryProvider } from "./memoryProvider.js";
import {
  type HarnessConfig,
  type HarnessConfig as HarnessConfigType,
  DEFAULT_HARNESS_CONFIG,
} from "./types.js";

/**
 * HarnessOrchestrator — top-level harness that wraps agent execution
 * with context compression, memory, iteration budgeting, analytics skills,
 * tenant context, and session resume.
 *
 * Flow per turn:
 *   1. Pre-turn: prefetch memory, check compression, load tenant context
 *   2. Execute: delegate to agent runtime (with iteration budget)
 *   3. Post-turn: save memory, extract analytics patterns, save session
 */
export class HarnessOrchestrator {
  readonly compressor: ContextCompressor;
  readonly budget: IterationBudget;
  readonly memory: MemoryProvider;
  readonly config: HarnessConfig;

  constructor(params: {
    memory: MemoryProvider;
    compressor?: ContextCompressor;
    budget?: IterationBudget;
    config?: Partial<HarnessConfig>;
  }) {
    this.memory = params.memory;
    this.compressor = params.compressor ?? new ContextCompressor();
    this.budget = params.budget ?? new IterationBudget({
      maxTotal: DEFAULT_HARNESS_CONFIG.iterationBudget.maxTotal,
      label: DEFAULT_HARNESS_CONFIG.iterationBudget.label,
    });
    this.config = { ...DEFAULT_HARNESS_CONFIG, ...params.config };
  }

  /**
   * Pre-turn hook: prefetch memory, load tenant context, load analytics skills.
   * Returns context blocks to inject into the system prompt.
   */
  async preTurn(params: {
    userMessage: string;
    tenantId: string;
  }): Promise<string[]> {
    const blocks: string[] = [];

    // 1. Memory prefetch
    const memoryContext = await this.memory.prefetch(params.userMessage);
    if (memoryContext) blocks.push(memoryContext);

    // 2. Tenant context
    if (this.config.tenantContext.enabled) {
      // loadTenantContext will be called from the harness.ts facade
    }

    return blocks;
  }

  /**
   * Post-turn hook: sync memory, extract analytics patterns.
   */
  async postTurn(params: {
    userMessage: string;
    assistantResponse: string;
    sql?: string;
    warehouse?: string;
    success: boolean;
    messages: Record<string, unknown>[];
    toolCalls?: Array<{
      tool: string;
      input: Record<string, unknown>;
      output?: unknown;
      error?: string;
      durationMs: number;
    }>;
  }): Promise<void> {
    // Sync turn to memory provider
    await this.memory.syncTurn({
      user: params.userMessage,
      assistant: params.assistantResponse,
      messages: params.messages,
      toolCalls: params.toolCalls,
    });

    // Extract analytics pattern if applicable
    if (this.config.analyticsSkills.enabled && params.success && params.sql && params.sql.trim()) {
      // maybeSaveAnalyticPattern called externally via harness.ts
    }
  }

  /** Check if budget allows another turn */
  canProceed(): boolean {
    return this.budget.consume();
  }

  /** Refund an iteration (e.g. tool cache hit) */
  refundIteration(): void {
    this.budget.refund();
  }

  /** Get harness status for diagnostics */
  getStatus(): Record<string, unknown> {
    return {
      budget: this.budget.status,
      compression: this.compressor.getState(),
      memory: this.memory.name,
    };
  }
}
