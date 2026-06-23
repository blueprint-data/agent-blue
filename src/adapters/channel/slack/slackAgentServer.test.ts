/**
 * Tests for feedback link map and reaction_added handler in slackAgentServer.ts.
 * Tests use module exports extracted via named exports or tested directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  rememberAnswerTurn,
  feedbackLinkMap,
  handleReactionAdded
} from "./slackAgentServer.js";

// ─── 4.1 / 4.2: Bounded FIFO Map ─────────────────────────────────────────────

describe("feedbackLinkMap FIFO eviction", () => {
  it("evicts the oldest entry when inserting beyond 1000 entries", () => {
    // Clear the map state before testing
    feedbackLinkMap.clear();

    // Insert 1000 entries
    for (let index = 1; index <= 1000; index += 1) {
      rememberAnswerTurn(`C${index}`, `ts_${index}`, "tenant-a", `conv_${index}`, null);
    }

    expect(feedbackLinkMap.size).toBe(1000);

    // The first key inserted
    const firstKey = "C1:ts_1";
    expect(feedbackLinkMap.has(firstKey)).toBe(true);

    // Insert entry 1001 — should evict C1:ts_1
    rememberAnswerTurn("C1001", "ts_1001", "tenant-a", "conv_1001", null);

    expect(feedbackLinkMap.size).toBe(1000);
    expect(feedbackLinkMap.has(firstKey)).toBe(false);
    expect(feedbackLinkMap.has("C1001:ts_1001")).toBe(true);
  });

  it("rememberAnswerTurn stores the correct tenantId and conversationId", () => {
    feedbackLinkMap.clear();

    rememberAnswerTurn("CCHAN", "1234567890.001", "my-tenant", "my-conv", null);

    const entry = feedbackLinkMap.get("CCHAN:1234567890.001");
    expect(entry?.tenantId).toBe("my-tenant");
    expect(entry?.conversationId).toBe("my-conv");
    expect(entry?.executionTurnId).toBeNull();
  });

  it("rememberAnswerTurn stores executionTurnId when provided", () => {
    feedbackLinkMap.clear();

    rememberAnswerTurn("CCHAN", "1234567890.002", "my-tenant", "my-conv", "turn_xyz");

    const entry = feedbackLinkMap.get("CCHAN:1234567890.002");
    expect(entry?.executionTurnId).toBe("turn_xyz");
  });
});

// ─── 5.1: handleReactionAdded ─────────────────────────────────────────────────

describe("handleReactionAdded", () => {
  function makeClient(saveMessageFeedbackFn = vi.fn()): {
    client: { reactions: { add: ReturnType<typeof vi.fn> }; auth: { test: ReturnType<typeof vi.fn> } };
    saveMessageFeedback: ReturnType<typeof vi.fn>;
  } {
    const saveMessageFeedback = saveMessageFeedbackFn;
    const client = {
      reactions: { add: vi.fn() },
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: "UBOT123" })
      }
    };
    return { client, saveMessageFeedback };
  }

  function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: "reaction_added",
      reaction: "thumbsup",
      user: "UUSER001",
      item: { type: "message", channel: "CCHAN", ts: "1234567890.001" },
      ...overrides
    };
  }

  beforeEach(() => {
    feedbackLinkMap.clear();
    rememberAnswerTurn("CCHAN", "1234567890.001", "tenant-x", "conv-x", "turn-x");
  });

  it("ignores unknown message_ts — no saveMessageFeedback call", async () => {
    const { client, saveMessageFeedback } = makeClient();
    const event = makeEvent({ item: { type: "message", channel: "CCHAN", ts: "9999999999.000" } });

    await handleReactionAdded(event, client as never, "tenant-x", "UBOT123", saveMessageFeedback as never);

    expect(saveMessageFeedback).not.toHaveBeenCalled();
  });

  it("ignores non-feedback reactions like 'tada'", async () => {
    const { client, saveMessageFeedback } = makeClient();
    const event = makeEvent({ reaction: "tada" });

    await handleReactionAdded(event, client as never, "tenant-x", "UBOT123", saveMessageFeedback as never);

    expect(saveMessageFeedback).not.toHaveBeenCalled();
  });

  it("ignores events where item.type !== 'message'", async () => {
    const { client, saveMessageFeedback } = makeClient();
    const event = makeEvent({ item: { type: "file", channel: "CCHAN", ts: "1234567890.001" } });

    await handleReactionAdded(event, client as never, "tenant-x", "UBOT123", saveMessageFeedback as never);

    expect(saveMessageFeedback).not.toHaveBeenCalled();
  });

  it("self-filters: ignores event where user === botUserId", async () => {
    const { client, saveMessageFeedback } = makeClient();
    const event = makeEvent({ user: "UBOT123" });

    await handleReactionAdded(event, client as never, "tenant-x", "UBOT123", saveMessageFeedback as never);

    expect(saveMessageFeedback).not.toHaveBeenCalled();
  });

  it("calls saveMessageFeedback with correct fields for valid thumbsup from non-bot user", async () => {
    const { client, saveMessageFeedback } = makeClient();
    const event = makeEvent();

    await handleReactionAdded(event, client as never, "tenant-x", "UBOT123", saveMessageFeedback as never);

    expect(saveMessageFeedback).toHaveBeenCalledTimes(1);
    expect(saveMessageFeedback).toHaveBeenCalledWith({
      tenantId: "tenant-x",
      conversationId: "conv-x",
      executionTurnId: "turn-x",
      channel: "CCHAN",
      messageTs: "1234567890.001",
      userId: "UUSER001",
      reaction: "thumbsup"
    });
  });

  it("calls saveMessageFeedback for thumbsdown reaction", async () => {
    const { client, saveMessageFeedback } = makeClient();
    const event = makeEvent({ reaction: "thumbsdown" });

    await handleReactionAdded(event, client as never, "tenant-x", "UBOT123", saveMessageFeedback as never);

    expect(saveMessageFeedback).toHaveBeenCalledTimes(1);
    expect(saveMessageFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ reaction: "thumbsdown" })
    );
  });

  it("normalizes Slack alias '+1' to thumbsup", async () => {
    const { client, saveMessageFeedback } = makeClient();
    const event = makeEvent({ reaction: "+1" });

    await handleReactionAdded(event, client as never, "tenant-x", "UBOT123", saveMessageFeedback as never);

    expect(saveMessageFeedback).toHaveBeenCalledTimes(1);
    expect(saveMessageFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ reaction: "thumbsup" })
    );
  });

  it("normalizes Slack alias '-1' to thumbsdown", async () => {
    const { client, saveMessageFeedback } = makeClient();
    const event = makeEvent({ reaction: "-1" });

    await handleReactionAdded(event, client as never, "tenant-x", "UBOT123", saveMessageFeedback as never);

    expect(saveMessageFeedback).toHaveBeenCalledTimes(1);
    expect(saveMessageFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ reaction: "thumbsdown" })
    );
  });

  it("swallows errors from saveMessageFeedback without re-throwing", async () => {
    const throwingSave = vi.fn().mockImplementation(() => {
      throw new Error("DB failure");
    });
    const { client } = makeClient();
    const event = makeEvent();

    await expect(
      handleReactionAdded(event, client as never, "tenant-x", "UBOT123", throwingSave as never)
    ).resolves.toBeUndefined();
  });
});
