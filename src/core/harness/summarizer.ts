/**
 * LLM summarizer adapter for ContextCompressor.
 *
 * Provides a `summarize()` callback that uses an LlmProvider to compress
 * a middle segment of conversation messages into a structured summary.
 * The summarizer uses a cheap/fast model to minimize token cost.
 */
import type { LlmProvider, LlmMessage } from "../interfaces.js";

const SUMMARIZER_SYSTEM_PROMPT = `You are a conversation summarizer for an analytics agent.
Summarize the following conversation segment concisently while preserving:
- What analytics questions were asked
- What SQL queries were executed (keep the SQL patterns, not the full results)
- What answers were given
- Which tools were used and their outcomes
- Any decisions or conclusions reached

Format the summary as plain paragraphs. Do not use markdown headings or bullet lists.`;

/**
 * Creates a summarizer function that can be passed to ContextCompressor.compress().
 * The summarizer uses the provided LLM provider with a cheap model to summarize
 * a batch of conversation messages.
 */
export function createSummarizer(
  llm: LlmProvider,
  model?: string
): (messages: Record<string, unknown>[]) => Promise<string> {
  return async (messages: Record<string, unknown>[]): Promise<string> => {
    const llmMessages: LlmMessage[] = [
      { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
      { role: "user", content: formatMessagesForSummary(messages) },
    ];

    const result = await llm.generateText({
      model: model ?? "opencode-go/minimax-m2.7",
      messages: llmMessages,
      temperature: 0.3,
    });

    return result.text;
  };
}

/**
 * Formats a batch of conversation messages into a single text block for the summarizer.
 */
function formatMessagesForSummary(messages: Record<string, unknown>[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const role = msg.role ?? "unknown";
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    const name = msg.name ?? "";
    const toolCalls = msg.tool_calls;

    if (role === "tool") {
      // Truncate tool results to 200 chars to save tokens
      const truncated = content.length > 200 ? content.slice(0, 200) + "..." : content;
      parts.push(`[${name ?? "tool"} result]: ${truncated}`);
    } else if (toolCalls && Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const fn = tc.function ?? {};
        parts.push(`[${role}] tool_call: ${fn.name ?? "unknown"}(${JSON.stringify(fn.arguments ?? {})})`);
      }
    } else {
      const preview = content.length > 500 ? content.slice(0, 500) + "..." : content;
      parts.push(`[${role}]: ${preview}`);
    }
  }

  return parts.join("\n\n");
}
