import { App } from "@slack/bolt";
import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import type { ChartConfiguration } from "chart.js";
import { AnalyticsAgentRuntime } from "../../../core/agentRuntime.js";
import type { ConversationStore } from "../../../core/interfaces.js";
import type { SlackTenantResolution } from "../../../core/interfaces.js";
import type { AdminBotEvent } from "../../../core/types.js";

export interface SlackAgentServerOptions {
  runtime: AnalyticsAgentRuntime;
  store: ConversationStore;
  botToken: string;
  signingSecret: string;
  port: number;
  defaultTenantId?: string;
  defaultProfileName?: string;
  llmModel?: string;
  teamTenantMap?: Record<string, string>;
  ownerTeamIds?: string[];
  ownerEnterpriseIds?: string[];
  strictTenantRouting?: boolean;
  onEvent?: (event: Omit<AdminBotEvent, "id" | "botName" | "createdAt">) => void | Promise<void>;
}

export interface SlackAgentServerController {
  port: number;
  stop(): Promise<void>;
}

function parseMessageText(raw: string): string {
  return raw.replace(/<@[^>]+>/g, "").trim();
}

function getTeamId(body: unknown, event: Record<string, unknown>): string | null {
  const bodyObj = body as Record<string, unknown>;
  const bodyTeamId = bodyObj["team_id"];
  if (typeof bodyTeamId === "string" && bodyTeamId.length > 0) {
    return bodyTeamId;
  }
  const eventTeamId = event["team"];
  if (typeof eventTeamId === "string" && eventTeamId.length > 0) {
    return eventTeamId;
  }
  return null;
}

function getEnterpriseId(body: unknown): string | null {
  const bodyObj = body as Record<string, unknown>;
  const enterpriseId = bodyObj["enterprise_id"];
  if (typeof enterpriseId === "string" && enterpriseId.length > 0) {
    return enterpriseId;
  }
  return null;
}

function getUserId(event: Record<string, unknown>): string | null {
  const userId = event["user"];
  if (typeof userId === "string" && userId.length > 0) {
    return userId;
  }
  return null;
}

function getBodyString(body: unknown, key: string): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getEnvelopeEventType(body: unknown, fallbackType: string): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fallbackType;
  }
  const event = (body as Record<string, unknown>)["event"];
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return fallbackType;
  }
  const eventType = (event as Record<string, unknown>)["type"];
  return typeof eventType === "string" && eventType.length > 0 ? eventType : fallbackType;
}

function buildSlackEventDedupeKey(input: {
  eventId?: string | null;
  eventType: string;
  teamId: string | null;
  channelId: string;
  userId: string | null;
  messageTs: string;
}): string {
  if (input.eventId) {
    return `event:${input.eventId}`;
  }
  return [
    "fallback",
    input.eventType,
    input.teamId ?? "unknown-team",
    input.channelId,
    input.messageTs,
    input.userId ?? "unknown-user"
  ].join(":");
}

function isOwnerContext(
  teamId: string | null,
  enterpriseId: string | null,
  ownerTeamIds: string[],
  ownerEnterpriseIds: string[]
): boolean {
  if (teamId && ownerTeamIds.includes(teamId)) {
    return true;
  }
  if (enterpriseId && ownerEnterpriseIds.includes(enterpriseId)) {
    return true;
  }
  return false;
}

function resolveTenantForSlackMessage(input: {
  store: ConversationStore;
  channelId: string;
  userId: string | null;
  teamId: string | null;
  enterpriseId: string | null;
  sharedTeamIds: string[];
  isDm: boolean;
  defaultTenantId: string | undefined;
  teamTenantMap: Record<string, string>;
  ownerTeamIds: string[];
  ownerEnterpriseIds: string[];
  strictTenantRouting: boolean;
}): SlackTenantResolution {
  const {
    store,
    channelId,
    userId,
    teamId,
    enterpriseId,
    sharedTeamIds,
    isDm,
    defaultTenantId,
    teamTenantMap,
    ownerTeamIds,
    ownerEnterpriseIds,
    strictTenantRouting
  } = input;

  const channelTenant = store.getSlackChannelTenant(channelId);
  if (channelTenant) {
    return { tenantId: channelTenant, rule: "channel" };
  }

  for (const sharedTeamId of sharedTeamIds) {
    const sharedTenant = store.getSlackSharedTeamTenant(sharedTeamId);
    if (sharedTenant) {
      return { tenantId: sharedTenant, rule: "shared_team" };
    }
  }

  if (isDm && userId) {
    const userTenant = store.getSlackUserTenant(userId);
    if (userTenant) {
      return { tenantId: userTenant, rule: "user" };
    }
  }

  if (teamId && teamTenantMap[teamId]) {
    return { tenantId: teamTenantMap[teamId], rule: "team" };
  }

  const ownerContext = isOwnerContext(teamId, enterpriseId, ownerTeamIds, ownerEnterpriseIds);
  if (ownerContext && defaultTenantId && defaultTenantId.length > 0) {
    return { tenantId: defaultTenantId, rule: "owner_default" };
  }

  if (strictTenantRouting) {
    return { tenantId: "", rule: "unmapped" };
  }

  if (defaultTenantId && defaultTenantId.length > 0) {
    return { tenantId: defaultTenantId, rule: "owner_default" };
  }

  return { tenantId: "", rule: "unmapped" };
}

function buildConversationId(teamId: string, channelId: string, threadTs: string): string {
  const safeThread = threadTs.replace(/\./g, "_");
  return `slack_${teamId}_${channelId}_${safeThread}`;
}

function normalizeThreadText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function buildThreadContextPrompt(lines: string[], userMessage: string): string {
  if (lines.length === 0) {
    return userMessage;
  }
  return [
    "Slack thread context (last 10 messages before the current one):",
    ...lines.map((line) => `- ${line}`),
    "",
    `Current message: ${userMessage}`
  ].join("\n");
}

function buildSlackFormattingPrompt(userMessage: string): string {
  return [
    "Formatting rules for this response:",
    "- You are replying in Slack mrkdwn.",
    "- Use *single asterisks* for bold (not **double asterisks**).",
    "- Keep formatting simple: short paragraphs and plain bullet lists.",
    "- Do not use Markdown headings or tables.",
    "",
    `User request: ${userMessage}`
  ].join("\n");
}

interface SlackChartArtifact {
  type?: unknown;
  format?: unknown;
  payload?: unknown;
}

function getChartConfigFromArtifacts(artifacts: unknown): Record<string, unknown> | null {
  if (!Array.isArray(artifacts)) {
    return null;
  }
  for (const artifactRaw of artifacts) {
    const artifact = artifactRaw as SlackChartArtifact;
    if (artifact.type !== "chartjs_config" || artifact.format !== "json") {
      continue;
    }
    if (!artifact.payload || typeof artifact.payload !== "object" || Array.isArray(artifact.payload)) {
      continue;
    }
    return artifact.payload as Record<string, unknown>;
  }
  return null;
}

async function buildChartPngBuffer(config: Record<string, unknown>): Promise<Buffer> {
  const renderer = new ChartJSNodeCanvas({
    width: 900,
    height: 500,
    backgroundColour: "white"
  });
  return renderer.renderToBuffer(config as unknown as ChartConfiguration);
}

export function parseSlackTeamTenantMap(raw: string): Record<string, string> {
  if (!raw.trim()) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SLACK_TEAM_TENANT_MAP must be a JSON object mapping team_id to tenant_id.");
  }
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"
    )
  );
}

export async function startSlackAgentServer(options: SlackAgentServerOptions): Promise<SlackAgentServerController> {
  if (!options.botToken) {
    throw new Error("SLACK_BOT_TOKEN is required.");
  }
  if (!options.signingSecret) {
    throw new Error("SLACK_SIGNING_SECRET is required.");
  }

  const app = new App({
    token: options.botToken,
    signingSecret: options.signingSecret
  });
  const emitEvent = async (
    eventType: string,
    level: AdminBotEvent["level"],
    message: string,
    metadata?: Record<string, unknown>
  ): Promise<void> => {
    try {
      await options.onEvent?.({
        level,
        eventType,
        message,
        metadata
      });
    } catch {
      // ignore observer failures
    }
  };

  const shouldSkipDuplicateMessage = (input: {
    body: unknown;
    fallbackEventType: string;
    teamId: string | null;
    channelId: string;
    userId: string | null;
    messageTs: string;
  }): boolean => {
    const eventId = getBodyString(input.body, "event_id");
    const eventType = getEnvelopeEventType(input.body, input.fallbackEventType);
    const eventKey = buildSlackEventDedupeKey({
      eventId,
      eventType,
      teamId: input.teamId,
      channelId: input.channelId,
      userId: input.userId,
      messageTs: input.messageTs
    });
    const isNew = options.store.tryMarkSlackEventProcessed({
      eventKey,
      eventId,
      eventType,
      teamId: input.teamId,
      channelId: input.channelId,
      userId: input.userId,
      messageTs: input.messageTs
    });
    if (isNew) {
      return false;
    }
    void emitEvent("message.duplicate_skipped", "info", "Skipped duplicate Slack event.", {
      eventKey,
      eventId,
      eventType,
      channelId: input.channelId,
      teamId: input.teamId,
      userId: input.userId,
      messageTs: input.messageTs
    });
    return true;
  };

  const processMessage = async (input: {
    body: unknown;
    teamId: string | null;
    userId: string | null;
    channel: string;
    threadTs: string;
    text: string;
    currentTs: string;
    includeThreadContext: boolean;
    isDm: boolean;
    client: App["client"];
  }): Promise<void> => {
    const processingReaction = "hourglass_flowing_sand";
    let reactionAdded = false;

    let sharedTeamIds: string[] = [];
    if (!input.isDm) {
      try {
        const channelInfo = await input.client.conversations.info({
          channel: input.channel,
          include_num_members: false
        });
        const chan = channelInfo.channel as { shared_team_ids?: string[] } | undefined;
        sharedTeamIds = Array.isArray(chan?.shared_team_ids) ? chan.shared_team_ids : [];
      } catch {
        sharedTeamIds = [];
      }
    }

    const resolution = resolveTenantForSlackMessage({
      store: options.store,
      channelId: input.channel,
      userId: input.userId,
      teamId: input.teamId,
      enterpriseId: getEnterpriseId(input.body),
      sharedTeamIds,
      isDm: input.isDm,
      defaultTenantId: options.defaultTenantId,
      teamTenantMap: options.teamTenantMap ?? {},
      ownerTeamIds: options.ownerTeamIds ?? [],
      ownerEnterpriseIds: options.ownerEnterpriseIds ?? [],
      strictTenantRouting: options.strictTenantRouting ?? false
    });

    if (resolution.rule === "unmapped" || !resolution.tenantId) {
      await emitEvent("routing.unmapped", "warn", "Slack message rejected due to missing tenant mapping.", {
        channelId: input.channel,
        teamId: input.teamId,
        userId: input.userId,
        threadTs: input.threadTs
      });
      await input.client.chat.postMessage({
        channel: input.channel,
        thread_ts: input.threadTs,
        text: "No tenant mapping found for this Slack workspace or channel. Configure channel mapping (slack-map-channel), user mapping (slack-map-user), or SLACK_TEAM_TENANT_MAP."
      });
      return;
    }

    const tenantId = resolution.tenantId;
    await emitEvent("message.received", "info", "Slack message received for processing.", {
      tenantId,
      channelId: input.channel,
      teamId: input.teamId,
      userId: input.userId,
      threadTs: input.threadTs,
      rule: resolution.rule,
      isDm: input.isDm
    });

    if (options.store.logSlackTenantRoutingAudit) {
      options.store.logSlackTenantRoutingAudit({
        messageTs: input.currentTs,
        channelId: input.channel,
        userId: input.userId,
        resolvedTenant: tenantId,
        ruleUsed: resolution.rule
      });
    }

    if (process.env.AGENT_VERBOSE === "1" || process.env.AGENT_VERBOSE?.toLowerCase() === "true") {
      process.stderr.write(
        `[slack] tenant=${tenantId} rule=${resolution.rule} channel=${input.channel} team=${input.teamId ?? "n/a"}\n`
      );
    }

    if (
      (resolution.rule === "team" || resolution.rule === "owner_default") &&
      options.strictTenantRouting === false
    ) {
      process.stderr.write(
        `[slack] Warning: using fallback rule "${resolution.rule}". For production, prefer explicit channel/user mapping. Set SLACK_STRICT_TENANT_ROUTING=true to require mappings.\n`
      );
    }

    if (!tenantId || tenantId.length === 0) {
      process.stderr.write("[slack] Assertion failed: tenantId must be non-empty before respond.\n");
      return;
    }

    try {
      await input.client.reactions.add({
        channel: input.channel,
        timestamp: input.currentTs,
        name: processingReaction
      });
      reactionAdded = true;
    } catch (error) {
      await emitEvent("message.reaction_add_failed", "warn", "Failed to add Slack processing reaction.", {
        tenantId,
        channelId: input.channel,
        error: (error as Error).message
      });
      process.stderr.write(`Warning: failed to add processing reaction: ${(error as Error).message}\n`);
    }

    const profileName = options.defaultProfileName ?? "default";
    const conversationId = buildConversationId(input.teamId ?? "unknown_team", input.channel, input.threadTs);

    try {
      let promptText = buildSlackFormattingPrompt(input.text);
      if (input.includeThreadContext) {
        try {
          const replies = await input.client.conversations.replies({
            channel: input.channel,
            ts: input.threadTs,
            limit: 15,
            inclusive: true
          });
          const messages = Array.isArray(replies.messages) ? replies.messages : [];
          const previousMessages = messages
            .filter((message) => {
              const ts = typeof message.ts === "string" ? Number.parseFloat(message.ts) : Number.NaN;
              const currentTs = Number.parseFloat(input.currentTs);
              return Number.isFinite(ts) && Number.isFinite(currentTs) && ts < currentTs;
            })
            .slice(-10)
            .map((message) => {
              const author =
                typeof message.user === "string"
                  ? `user:${message.user}`
                  : typeof message.bot_id === "string"
                    ? `bot:${message.bot_id}`
                    : "unknown";
              const text = normalizeThreadText(message.text) ?? "(no text)";
              return `${author}: ${text}`;
            });
          promptText = buildSlackFormattingPrompt(buildThreadContextPrompt(previousMessages, input.text));
        } catch (error) {
          await emitEvent("message.thread_context_failed", "warn", "Failed to fetch Slack thread context.", {
            tenantId,
            channelId: input.channel,
            error: (error as Error).message
          });
          process.stderr.write(
            `Warning: failed to read Slack thread context: ${(error as Error).message}\n`
          );
        }
      }

      const response = await options.runtime.respond(
        {
          tenantId,
          profileName,
          conversationId,
          llmModel: options.llmModel,
          origin: {
            source: "slack",
            teamId: input.teamId ?? undefined,
            channelId: input.channel,
            threadTs: input.threadTs,
            userId: input.userId ?? undefined
          }
        },
        input.text,
        {
          promptText
        }
      );

      await input.client.chat.postMessage({
        channel: input.channel,
        thread_ts: input.threadTs,
        text: response.text
      });
      await emitEvent("message.completed", "info", "Slack message processed successfully.", {
        tenantId,
        channelId: input.channel,
        conversationId,
        hasArtifacts: Array.isArray(response.artifacts) && response.artifacts.length > 0
      });

      const chartConfig = getChartConfigFromArtifacts(response.artifacts);
      if (chartConfig) {
        try {
          const chartPng = await buildChartPngBuffer(chartConfig);
          await input.client.files.uploadV2({
            channel_id: input.channel,
            thread_ts: input.threadTs,
            filename: `chart-${Date.now()}.png`,
            title: "Generated chart",
            file: chartPng
          });
        } catch (chartError) {
          await emitEvent("message.chart_upload_failed", "warn", "Failed to render or upload Slack chart.", {
            tenantId,
            channelId: input.channel,
            error: (chartError as Error).message
          });
          process.stderr.write(`Warning: failed to render/send chart image: ${(chartError as Error).message}\n`);
        }
      }
    } catch (error) {
      await emitEvent("message.error", "error", "Slack message processing failed.", {
        tenantId,
        channelId: input.channel,
        conversationId,
        error: (error as Error).message
      });
      await input.client.chat.postMessage({
        channel: input.channel,
        thread_ts: input.threadTs,
        text: `I hit an error while processing that request: ${(error as Error).message}`
      });
    } finally {
      if (reactionAdded) {
        try {
          await input.client.reactions.remove({
            channel: input.channel,
            timestamp: input.currentTs,
            name: processingReaction
          });
        } catch (error) {
          await emitEvent("message.reaction_remove_failed", "warn", "Failed to remove Slack processing reaction.", {
            tenantId,
            channelId: input.channel,
            error: (error as Error).message
          });
          process.stderr.write(`Warning: failed to remove processing reaction: ${(error as Error).message}\n`);
        }
      }
    }
  };

  app.event("app_mention", async ({ event, body, client }) => {
    const slackEvent = event as unknown as Record<string, unknown>;
    const channel = slackEvent["channel"];
    const ts = slackEvent["ts"];
    const threadTs = slackEvent["thread_ts"];
    const text = slackEvent["text"];
    if (typeof channel !== "string" || typeof ts !== "string" || typeof text !== "string") {
      return;
    }
    const teamId = getTeamId(body, slackEvent);
    const userId = getUserId(slackEvent);
    if (
      shouldSkipDuplicateMessage({
        body,
        fallbackEventType: "app_mention",
        teamId,
        channelId: channel,
        userId,
        messageTs: ts
      })
    ) {
      return;
    }

    void processMessage({
      body,
      teamId,
      userId,
      channel,
      threadTs: typeof threadTs === "string" ? threadTs : ts,
      text: parseMessageText(text),
      currentTs: ts,
      includeThreadContext: typeof threadTs === "string" && threadTs.length > 0,
      isDm: false,
      client
    });
  });

  app.message(async ({ message, body, client }) => {
    const slackMessage = message as unknown as Record<string, unknown>;
    if (typeof slackMessage["subtype"] === "string" || typeof slackMessage["bot_id"] === "string") {
      return;
    }
    if (slackMessage["channel_type"] !== "im") {
      return;
    }

    const channel = slackMessage["channel"];
    const ts = slackMessage["ts"];
    const threadTs = slackMessage["thread_ts"];
    const text = slackMessage["text"];
    if (typeof channel !== "string" || typeof ts !== "string" || typeof text !== "string") {
      return;
    }
    const teamId = getTeamId(body, slackMessage);
    const userId = getUserId(slackMessage);
    if (
      shouldSkipDuplicateMessage({
        body,
        fallbackEventType: "message",
        teamId,
        channelId: channel,
        userId,
        messageTs: ts
      })
    ) {
      return;
    }

    void processMessage({
      body,
      teamId,
      userId,
      channel,
      threadTs: typeof threadTs === "string" ? threadTs : ts,
      text: text.trim(),
      currentTs: ts,
      includeThreadContext: false,
      isDm: true,
      client
    });
  });

  await app.start(options.port);
  await emitEvent("bot.started", "info", "Slack agent server started.", { port: options.port });
  process.stdout.write(`Slack agent server running on port ${options.port}\n`);
  return {
    port: options.port,
    async stop() {
      await emitEvent("bot.stopping", "info", "Stopping Slack agent server.", { port: options.port });
      await app.stop();
      await emitEvent("bot.stopped", "info", "Slack agent server stopped.", { port: options.port });
    }
  };
}
