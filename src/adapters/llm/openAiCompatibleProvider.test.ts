import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider } from "./openAiCompatibleProvider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAiCompatibleProvider", () => {
  it("returns text, usage, and generation id from chat completion response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id: "gen-openrouter-1",
        choices: [{ message: { content: "  hello  " } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          cost: 0.00015
        }
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider("https://openrouter.ai/api/v1", "test-key");
    const result = await provider.generateText({
      model: "google/gemini-2.0-flash",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0
    });

    expect(result.text).toBe("hello");
    expect(result.generationId).toBe("gen-openrouter-1");
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
      cost: 0.00015
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("works when usage is omitted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "ok" } }]
        })
      }))
    );

    const provider = new OpenAiCompatibleProvider("https://api.example/v1", "k");
    const result = await provider.generateText({
      model: "m",
      messages: [{ role: "user", content: "x" }]
    });

    expect(result.text).toBe("ok");
    expect(result.usage).toBeUndefined();
  });
});
