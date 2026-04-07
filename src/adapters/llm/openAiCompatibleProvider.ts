import type { LlmGenerateResult, LlmMessage, LlmProvider, LlmUsage } from "../../core/interfaces.js";

interface ChatCompletionResponse {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
}

function mapUsage(raw: ChatCompletionResponse["usage"]): LlmUsage | undefined {
  if (!raw) {
    return undefined;
  }
  const prompt = typeof raw.prompt_tokens === "number" ? raw.prompt_tokens : 0;
  const completion = typeof raw.completion_tokens === "number" ? raw.completion_tokens : 0;
  const total =
    typeof raw.total_tokens === "number" ? raw.total_tokens : prompt + completion;
  if (prompt === 0 && completion === 0 && total === 0 && raw.cost === undefined) {
    return undefined;
  }
  const usage: LlmUsage = {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total
  };
  if (typeof raw.cost === "number" && Number.isFinite(raw.cost)) {
    usage.cost = raw.cost;
  }
  return usage;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly extraHeaders: Record<string, string> = {}
  ) {}

  async generateText(input: {
    model: string;
    messages: LlmMessage[];
    temperature?: number;
  }): Promise<LlmGenerateResult> {
    if (!this.apiKey) {
      throw new Error("LLM_API_KEY is not configured.");
    }

    const endpoint = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(120_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders
        },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          temperature: input.temperature ?? 0.2
        })
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`LLM request failed (${response.status}): ${body}`);
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const text = data.choices?.[0]?.message?.content?.trim();
      const usage = mapUsage(data.usage);
      const generationId = typeof data.id === "string" && data.id.length > 0 ? data.id : undefined;
      if (text) {
        return { text, usage, generationId };
      }

      if (attempt === 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
      }
    }

    throw new Error("LLM returned empty response.");
  }
}
