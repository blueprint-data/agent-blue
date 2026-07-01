/**
 * Harness v3 — shared types for context compression, memory providers,
 * iteration budgets, and harness-level orchestration.
 */

// ─── Context Compressor ───────────────────────────────────────

export interface ContextCompressorConfig {
  /** Cheap/fast model ID used for summarization (e.g. "opencode-go/minimax-m2.7") */
  model: string;
  /** Compress when estimated tokens reach this fraction of context window (default 0.50) */
  thresholdPercent: number;
  /** Summary should be this fraction of compressed content (default 0.20) */
  targetRatio: number;
  /** Number of leading messages to always preserve verbatim (default 3) */
  protectFirstN: number;
  /** Token budget reserved for the protected tail (default ~20K tokens) */
  tailTokenBudget: number;
  /** Absolute ceiling for the generated summary in tokens (default 12K) */
  maxSummaryTokens: number;
  /** When true, abort compression entirely on LLM failure instead of inserting a degraded placeholder */
  abortOnFailure: boolean;
  /** Seconds to wait before retrying compression after a failure (default 600) */
  failureCooldownSec: number;
  /** Minimum savings percent to consider compression effective (default 10) */
  minEffectiveSavingsPct: number;
  /** Max consecutive ineffective compressions before thrashing protection kicks in (default 2) */
  maxIneffectiveCompressions: number;
}

export const DEFAULT_COMPRESSOR_CONFIG: ContextCompressorConfig = {
  model: "opencode-go/minimax-m2.7",
  thresholdPercent: 0.50,
  targetRatio: 0.20,
  protectFirstN: 3,
  tailTokenBudget: 20_000,
  maxSummaryTokens: 12_000,
  abortOnFailure: true,
  failureCooldownSec: 600,
  minEffectiveSavingsPct: 10,
  maxIneffectiveCompressions: 2,
};

export interface CompressionResult {
  /** Compressed message list (HEAD + summary + TAIL) */
  compressed: Record<string, unknown>[];
  /** The generated summary text */
  summary: string;
  /** Estimated tokens saved by compression */
  savedTokens: number;
  /** True if compression was aborted (failure) and messages are unchanged */
  aborted: boolean;
  /** Token count before compression */
  beforeTokens: number;
  /** Token count after compression */
  afterTokens: number;
}

export interface CompressorState {
  /** Running count of compressions performed */
  compressionCount: number;
  /** Previous summary for iterative updates */
  previousSummary: string | null;
  /** Anti-thrashing: consecutive ineffective compressions */
  ineffectiveCount: number;
  /** Timestamp until which compression is on cooldown (monotonic ms) */
  cooldownUntilMs: number;
  /** Last error message for diagnostics */
  lastError: string | null;
  /** Was the last error an auth/permission failure (non-recoverable)? */
  lastErrorIsAuth: boolean;
}

// ─── Memory Provider ──────────────────────────────────────────

export interface MemoryProviderConfig {
  /** Provider name: "sqlite" | "engram" */
  provider: string;
  /** Provider-specific options */
  options?: Record<string, unknown>;
}

export interface TurnRecord {
  user: string;
  assistant: string;
  messages: Record<string, unknown>[];
  toolCalls?: Array<{
    tool: string;
    input: Record<string, unknown>;
    output?: unknown;
    error?: string;
    durationMs: number;
  }>;
  metadata?: Record<string, unknown>;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ─── Iteration Budget ─────────────────────────────────────────

export interface IterationBudgetConfig {
  /** Maximum iterations allowed (default 90 for parent, 50 for subagent) */
  maxTotal: number;
  /** Label for diagnostics (e.g. "parent", "subagent:explore") */
  label?: string;
}

// ─── Harness Orchestrator ─────────────────────────────────────

export interface HarnessConfig {
  memory: MemoryProviderConfig;
  compression: Partial<ContextCompressorConfig>;
  iterationBudget: IterationBudgetConfig;
  analyticsSkills: {
    enabled: boolean;
    minComplexity: number;
    maxPatternsPerQuery: number;
  };
  tenantContext: {
    enabled: boolean;
    cacheTtlMs: number;
  };
  sessionResume: {
    enabled: boolean;
    maxExchanges: number;
  };
}

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  memory: { provider: "sqlite" },
  compression: {},
  iterationBudget: { maxTotal: 90, label: "parent" },
  analyticsSkills: {
    enabled: true,
    minComplexity: 3,
    maxPatternsPerQuery: 5,
  },
  tenantContext: {
    enabled: true,
    cacheTtlMs: 300_000,
  },
  sessionResume: {
    enabled: true,
    maxExchanges: 4,
  },
};
