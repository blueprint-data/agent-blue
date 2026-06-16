import { describe, expect, it } from "vitest";
import type { ConversationStore } from "./interfaces.js";
import type { MessageFeedback } from "./types.js";

describe("ConversationStore saveMessageFeedback port", () => {
  it("ConversationStore declares saveMessageFeedback with correct signature", () => {
    // Build a minimal implementation that satisfies the ConversationStore interface.
    // If saveMessageFeedback is missing from the interface, TypeScript will error here.
    const feedback: MessageFeedback = {
      id: "feedback_001",
      tenantId: "tenant-a",
      conversationId: "conv_abc",
      channel: "C111",
      messageTs: "1717600000.000100",
      userId: "U999",
      reaction: "thumbsup",
      createdAt: "2024-06-05T10:00:00.000Z"
    };

    let capturedInput: Parameters<ConversationStore["saveMessageFeedback"]>[0] | null = null;

    const store: Pick<ConversationStore, "saveMessageFeedback"> = {
      saveMessageFeedback(input) {
        capturedInput = input;
        return feedback;
      }
    };

    const result = store.saveMessageFeedback({
      tenantId: "tenant-a",
      conversationId: "conv_abc",
      channel: "C111",
      messageTs: "1717600000.000100",
      userId: "U999",
      reaction: "thumbsup"
    });

    expect(capturedInput).not.toBeNull();
    expect(capturedInput!.tenantId).toBe("tenant-a");
    expect(capturedInput!.reaction).toBe("thumbsup");
    expect(result.id).toBe("feedback_001");
    expect(result.createdAt).toBe("2024-06-05T10:00:00.000Z");
  });

  it("saveMessageFeedback accepts thumbsdown with null userId", () => {
    const store: Pick<ConversationStore, "saveMessageFeedback"> = {
      saveMessageFeedback(input) {
        return {
          id: "feedback_002",
          ...input,
          createdAt: "2024-06-05T12:00:00.000Z"
        };
      }
    };

    const result = store.saveMessageFeedback({
      tenantId: "tenant-b",
      conversationId: "conv_xyz",
      channel: "C222",
      messageTs: "1717600001.000200",
      userId: null,
      reaction: "thumbsdown"
    });

    expect(result.reaction).toBe("thumbsdown");
    expect(result.userId).toBeNull();
    expect(result.id).toBe("feedback_002");
  });
});
