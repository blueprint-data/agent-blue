import { describe, expect, it } from "vitest";
import type { MessageFeedback, MessageFeedbackRow } from "./types.js";

describe("MessageFeedback type", () => {
  it("accepts a valid thumbsup feedback object", () => {
    const feedback: MessageFeedback = {
      id: "feedback_abc123",
      tenantId: "acme",
      conversationId: "conv_123",
      executionTurnId: "turn_abc",
      channel: "C12345",
      messageTs: "1717600000.000100",
      userId: "U98765",
      reaction: "thumbsup",
      createdAt: "2024-06-05T10:00:00.000Z"
    };
    expect(feedback.id).toBe("feedback_abc123");
    expect(feedback.tenantId).toBe("acme");
    expect(feedback.conversationId).toBe("conv_123");
    expect(feedback.channel).toBe("C12345");
    expect(feedback.messageTs).toBe("1717600000.000100");
    expect(feedback.userId).toBe("U98765");
    expect(feedback.reaction).toBe("thumbsup");
    expect(feedback.createdAt).toBe("2024-06-05T10:00:00.000Z");
  });

  it("accepts a thumbsdown feedback with null userId", () => {
    const feedback: MessageFeedback = {
      id: "feedback_xyz789",
      tenantId: "tenant-b",
      conversationId: "conv_456",
      executionTurnId: null,
      channel: "C67890",
      messageTs: "1717600001.000200",
      userId: null,
      reaction: "thumbsdown",
      createdAt: "2024-06-05T11:00:00.000Z"
    };
    expect(feedback.reaction).toBe("thumbsdown");
    expect(feedback.userId).toBeNull();
  });
});

describe("MessageFeedbackRow type", () => {
  it("extends MessageFeedback with rawUserText and assistantText fields", () => {
    const row: MessageFeedbackRow = {
      id: "feedback_row1",
      tenantId: "acme",
      conversationId: "conv_123",
      executionTurnId: "turn_abc",
      channel: "slack",
      messageTs: "1717600000.000100",
      userId: "U98765",
      reaction: "thumbsup",
      createdAt: "2024-06-05T10:00:00.000Z",
      rawUserText: "What are the top 10 customers by revenue?",
      assistantText: "Here are the top 10 customers..."
    };
    expect(row.rawUserText).toBe("What are the top 10 customers by revenue?");
    expect(row.assistantText).toBe("Here are the top 10 customers...");
    expect(row.reaction).toBe("thumbsup");
  });

  it("accepts null rawUserText and assistantText (no linked turn)", () => {
    const row: MessageFeedbackRow = {
      id: "feedback_row2",
      tenantId: "acme",
      conversationId: "conv_456",
      executionTurnId: null,
      channel: "slack",
      messageTs: "1717600001.000200",
      userId: null,
      reaction: "thumbsdown",
      createdAt: "2024-06-05T11:00:00.000Z",
      rawUserText: null,
      assistantText: null
    };
    expect(row.rawUserText).toBeNull();
    expect(row.assistantText).toBeNull();
    expect(row.reaction).toBe("thumbsdown");
  });
});
