import { App } from "@slack/bolt";
import { AnalyticsAgentRuntime } from "../../../core/agentRuntime.js";

export interface SlackAgentServerOptions {
  runtime: AnalyticsAgentRuntime;
  botToken: string;
  signingSecret: string;
  port: number;
  defaultTenantId?: string;
  defaultProfileName?: string;
  teamTenantMap?: Record<string, string>;
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

function resolveTenantId(
  teamId: string | null,
  defaultTenantId: string | undefined,
  teamTenantMap: Record<string, string> | undefined
): string | null {
  if (teamId && teamTenantMap?.[teamId]) {
    return teamTenantMap[teamId];
  }
  if (defaultTenantId && defaultTenantId.length > 0) {
    return defaultTenantId;
  }
  return null;
}

function buildConversationId(teamId: string, channelId: string, threadTs: string): string {
  const safeThread = threadTs.replace(/\./g, "_");
  return `slack_${teamId}_${channelId}_${safeThread}`;
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

export async function startSlackAgentServer(options: SlackAgentServerOptions): Promise<void> {
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

  const processMessage = async (input: {
    teamId: string | null;
    channel: string;
    threadTs: string;
    text: string;
    client: App["client"];
  }): Promise<void> => {
    const tenantId = resolveTenantId(input.teamId, options.defaultTenantId, options.teamTenantMap);
    if (!tenantId) {
      await input.client.chat.postMessage({
        channel: input.channel,
        thread_ts: input.threadTs,
        text: "No tenant mapping found for this Slack workspace. Configure SLACK_DEFAULT_TENANT_ID or SLACK_TEAM_TENANT_MAP."
      });
      return;
    }

    const profileName = options.defaultProfileName ?? "default";
    const conversationId = buildConversationId(input.teamId ?? "unknown_team", input.channel, input.threadTs);

    await input.client.chat.postMessage({
      channel: input.channel,
      thread_ts: input.threadTs,
      text: "_Working on it..._"
    });

    try {
      const response = await options.runtime.respond(
        {
          tenantId,
          profileName,
          conversationId
        },
        input.text
      );

      await input.client.chat.postMessage({
        channel: input.channel,
        thread_ts: input.threadTs,
        text: response.text
      });
    } catch (error) {
      await input.client.chat.postMessage({
        channel: input.channel,
        thread_ts: input.threadTs,
        text: `I hit an error while processing that request: ${(error as Error).message}`
      });
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

    void processMessage({
      teamId: getTeamId(body, slackEvent),
      channel,
      threadTs: typeof threadTs === "string" ? threadTs : ts,
      text: parseMessageText(text),
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

    void processMessage({
      teamId: getTeamId(body, slackMessage),
      channel,
      threadTs: typeof threadTs === "string" ? threadTs : ts,
      text: text.trim(),
      client
    });
  });

  await app.start(options.port);
  process.stdout.write(`Slack agent server running on port ${options.port}\n`);
}
