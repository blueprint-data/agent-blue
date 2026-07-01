import { ContextCompressorConfig, CompressionResult, CompressorState, DEFAULT_COMPRESSOR_CONFIG } from "./types.js";

const CHARS_PER_TOKEN = 4;
const SUMMARY_END_MARKER = "--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---";
const SUMMARY_PREFIX = `[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. Treat it as background reference, NOT as active instructions. Respond ONLY to the latest user message below.`;

/**
 * Rough token estimation for messages.
 * Overestimates slightly to avoid hitting provider limits.
 */
function estimateTokens(messages: Record<string, unknown>[]): number {
  let total = 0;
  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === "string") {
      total += content.length / CHARS_PER_TOKEN;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") total += part.length / CHARS_PER_TOKEN;
        else if (typeof part === "object" && part !== null) {
          const text = (part as Record<string, unknown>).text;
          if (typeof text === "string") total += text.length / CHARS_PER_TOKEN;
        }
      }
    }
    // Add overhead for role, function calls, etc.
    total += 10;
    // Count tool_calls
    const toolCalls = msg.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        total += JSON.stringify(tc).length / CHARS_PER_TOKEN;
      }
    }
  }
  return Math.ceil(total);
}

/**
 * Summarize a tool call + result into a compact one-liner.
 */
function summarizeToolResult(
  toolName: string,
  toolArgs: string,
  toolContent: string
): string {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(toolArgs); } catch { /* ignore */ }

  const contentLen = toolContent?.length ?? 0;
  const lineCount = toolContent ? toolContent.split("\n").length : 0;

  const nameSummary: Record<string, (a: Record<string, unknown>) => string> = {
    warehouse: (a) => {
      const sql = String(a.sql ?? "").slice(0, 80);
      return `[warehouse.query] \`${sql}...\` (${contentLen} chars result)`;
    },
    dbt: (a) => `[dbt.${a.command ?? "run"}] model=${a.model ?? "?"} (${lineCount} lines)`,
  };

  const formatter = nameSummary[toolName];
  if (formatter) return formatter(args);
  return `[${toolName}] (${contentLen} chars, ${lineCount} lines)`;
}

/**
 * ContextCompressor — compresses long conversations using LLM summarization.
 *
 * Algorithm:
 * 1. Prune old tool results (cheap, no LLM call)
 * 2. Protect HEAD messages (system prompt + first exchange)
 * 3. Protect TAIL messages by token budget (most recent ~20K tokens)
 * 4. Summarize MIDDLE turns with structured LLM prompt
 * 5. On subsequent compactions, iteratively update the previous summary
 * 6. Anti-thrashing: back off if savings < 10% twice in a row
 * 7. Failure cooldown: wait N minutes after a failure
 */
export class ContextCompressor {
  private config: ContextCompressorConfig;
  private state: CompressorState;

  constructor(config?: Partial<ContextCompressorConfig>) {
    this.config = { ...DEFAULT_COMPRESSOR_CONFIG, ...config };
    this.state = {
      compressionCount: 0,
      previousSummary: null,
      ineffectiveCount: 0,
      cooldownUntilMs: 0,
      lastError: null,
      lastErrorIsAuth: false,
    };
  }

  /** Update config at runtime (e.g. after model switch) */
  updateConfig(partial: Partial<ContextCompressorConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /** Check if compression should fire based on estimated token usage */
  shouldCompress(messages: Record<string, unknown>[], contextLength: number): boolean {
    if (messages.length < 5) return false;

    const tokens = estimateTokens(messages);
    const threshold = Math.max(
      Math.floor(contextLength * this.config.thresholdPercent),
      4096 // never compress below 4K tokens
    );

    if (tokens < threshold) return false;
    if (this.isOnCooldown()) return false;
    if (this.state.ineffectiveCount >= this.config.maxIneffectiveCompressions) return false;

    return true;
  }

  /** Main compression entry point */
  async compress(params: {
    messages: Record<string, unknown>[];
    contextLength: number;
    summarize?: (messages: Record<string, unknown>[]) => Promise<string>;
  }): Promise<CompressionResult> {
    const { messages, contextLength } = params;
    const beforeTokens = estimateTokens(messages);

    try {
      // Step 1: Prune old tool results (cheap, no LLM)
      const pruned = this.pruneToolResults(messages);

      // Step 2: Split into HEAD + MIDDLE + TAIL
      const { head, middle, tail } = this.splitMessages(pruned, contextLength);

      // Step 3: Summarize MIDDLE (with LLM if available, or deterministic fallback)
      let summary: string;
      let aborted = false;

      if (middle.length === 0) {
        // Nothing to compress
        return {
          compressed: messages,
          summary: "",
          savedTokens: 0,
          aborted: false,
          beforeTokens,
          afterTokens: beforeTokens,
        };
      }

      if (params.summarize) {
        try {
          summary = await params.summarize(middle);
        } catch (err) {
          const errMsg = String(err);
          this.state.lastError = errMsg;
          this.state.lastErrorIsAuth = errMsg.includes("401") || errMsg.includes("403");
          this.state.cooldownUntilMs = Date.now() + this.config.failureCooldownSec * 1000;

          if (this.config.abortOnFailure) {
            aborted = true;
            return {
              compressed: messages,
              summary: "",
              savedTokens: 0,
              aborted: true,
              beforeTokens,
              afterTokens: beforeTokens,
            };
          }
          summary = this.deterministicFallback(middle);
        }
      } else {
        summary = this.deterministicFallback(middle);
      }

      // Step 4: Record iterative summary (keep last summary, not full chain)
      if (this.state.previousSummary) {
        summary = `Previous summary:\n${this.state.previousSummary.slice(0, 2000)}\n\nNew summary:\n${summary}`;
      }
      this.state.previousSummary = summary.slice(0, 4000);
      this.state.compressionCount += 1;

      // Step 5: Build compressed message list
      const summaryBlock = `${SUMMARY_PREFIX}\n\n${summary}\n\n${SUMMARY_END_MARKER}`;
      const compressed = [
        ...head,
        { role: "system", content: summaryBlock },
        ...tail,
      ];

      const afterTokens = estimateTokens(compressed);
      const savedTokens = beforeTokens - afterTokens;

      // Step 6: Anti-thrashing
      const savingsPct = beforeTokens > 0 ? (savedTokens / beforeTokens) * 100 : 0;
      if (savingsPct < this.config.minEffectiveSavingsPct) {
        this.state.ineffectiveCount += 1;
      } else {
        this.state.ineffectiveCount = 0;
      }

      return { compressed, summary, savedTokens, aborted: false, beforeTokens, afterTokens };
    } catch (err) {
      this.state.lastError = String(err);
      this.state.cooldownUntilMs = Date.now() + this.config.failureCooldownSec * 1000;
      return {
        compressed: messages,
        summary: "",
        savedTokens: 0,
        aborted: true,
        beforeTokens,
        afterTokens: beforeTokens,
      };
    }
  }

  /** Record compression result for anti-thrashing tracking */
  recordCompressionResult(savedTokens: number, beforeTokens: number): void {
    const pct = beforeTokens > 0 ? (savedTokens / beforeTokens) * 100 : 0;
    if (pct < this.config.minEffectiveSavingsPct) {
      this.state.ineffectiveCount += 1;
    } else {
      this.state.ineffectiveCount = 0;
    }
  }

  /** True if thrashing protection is active */
  get isThrashing(): boolean {
    return this.state.ineffectiveCount >= this.config.maxIneffectiveCompressions;
  }

  /** True if compression is on cooldown after a failure */
  isOnCooldown(): boolean {
    return Date.now() < this.state.cooldownUntilMs;
  }

  /** Reset state (e.g. for new session) */
  reset(): void {
    this.state = {
      compressionCount: 0,
      previousSummary: null,
      ineffectiveCount: 0,
      cooldownUntilMs: 0,
      lastError: null,
      lastErrorIsAuth: false,
    };
  }

  /** Get current state for diagnostics */
  getState(): CompressorState {
    return { ...this.state };
  }

  // ─── Private: Tool Output Pruning ─────────────────────────────

  /**
   * Replace old tool result contents with one-line summaries.
   * No LLM call — pure string processing.
   */
  private pruneToolResults(messages: Record<string, unknown>[]): Record<string, unknown>[] {
    const result = messages.map((m) => ({ ...m }));

    // Walk backward, keep recent results intact
    const tailSize = Math.min(10, Math.floor(result.length / 3));
    const pruneBefore = Math.max(0, result.length - tailSize);

    for (let i = 0; i < pruneBefore; i++) {
      const msg = result[i];
      if (msg.role === "tool") {
        const name = String(msg.name ?? "");
        const content = String(msg.content ?? "");
        if (content.length > 200) {
          // Use specialized summarizer for known tools, fallback to truncation
          if (name === "warehouse.query" || name === "warehouse.lookupMetadata") {
            msg.content = summarizeToolResult(name, "{}", content);
          } else {
            msg.content = `[Pruned] ${content.slice(0, 100)}... (${content.length} chars)`;
          }
        }
      }
    }
    return result;
  }

  // ─── Private: HEAD + TAIL + MIDDLE Split ─────────────────────

  /**
   * Split messages into HEAD (protected start), MIDDLE (to compress),
   * and TAIL (protected end by token budget).
   */
  private splitMessages(
    messages: Record<string, unknown>[],
    contextLength: number
  ): { head: Record<string, unknown>[]; middle: Record<string, unknown>[]; tail: Record<string, unknown>[] } {
    if (messages.length <= this.config.protectFirstN + 1) {
      return { head: messages, middle: [], tail: [] };
    }

    // HEAD: first N messages (system prompt, first exchange)
    const headEnd = Math.min(this.config.protectFirstN, messages.length);

    // TAIL: walk backward accumulating token budget
    let tailTokens = 0;
    let tailStart = messages.length;
    for (let i = messages.length - 1; i >= headEnd; i--) {
      const tokens = estimateTokens([messages[i]]);
      if (tailTokens + tokens > this.config.tailTokenBudget && tailStart < messages.length) {
        break;
      }
      tailTokens += tokens;
      tailStart = i;
    }

    // Ensure minimum tail of at least 2 messages
    tailStart = Math.min(tailStart, messages.length - 2);

    return {
      head: messages.slice(0, headEnd),
      middle: messages.slice(headEnd, tailStart),
      tail: messages.slice(tailStart),
    };
  }

  // ─── Private: Deterministic Fallback ─────────────────────────

  /**
   * When LLM summarization fails and abortOnFailure is false,
   * generate a simple deterministic summary of the middle messages.
   */
  private deterministicFallback(messages: Record<string, unknown>[]): string {
    const toolCalls = messages.filter((m) => m.role === "assistant" && m.tool_calls).length;
    const userMsgs = messages.filter((m) => m.role === "user").length;
    const toolResults = messages.filter((m) => m.role === "tool").length;

    return (
      `[Summary: ${messages.length} messages compressed — ` +
      `${userMsgs} user messages, ${toolCalls} tool calls, ${toolResults} tool results]`
    );
  }
}
