import { LlmMessage, LlmProvider } from "../../core/interfaces.js";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly extraHeaders: Record<string, string> = {}
  ) {}

  async generateText(input: { model: string; messages: LlmMessage[]; temperature?: number }): Promise<string> {
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
      if (text) {
        return text;
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
