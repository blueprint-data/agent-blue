import { Bot, InputFile } from "grammy";
import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import type { ChartConfiguration } from "chart.js";
import { AnalyticsAgentRuntime } from "../../../core/agentRuntime.js";
import type { ConversationStore } from "../../../core/interfaces.js";
import type { AdminBotEvent } from "../../../core/types.js";

export interface TelegramAgentServerOptions {
  runtime: AnalyticsAgentRuntime;
  store: ConversationStore;
  botToken: string;
  defaultTenantId?: string;
  defaultProfileName?: string;
  llmModel?: string;
  onEvent?: (event: Omit<AdminBotEvent, "id" | "botName" | "createdAt">) => void | Promise<void>;
}

export interface TelegramAgentServerController {
  stop(): Promise<void>;
}

interface TelegramChartArtifact {
  type?: unknown;
  format?: unknown;
  payload?: unknown;
}

function getChartConfigFromArtifacts(artifacts: unknown): Record<string, unknown> | null {
  if (!Array.isArray(artifacts)) {
    return null;
  }
  for (const artifactRaw of artifacts) {
    const artifact = artifactRaw as TelegramChartArtifact;
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

function extractBotMentionText(text: string, botUsername: string): string | null {
  const mentionPattern = new RegExp(`@${escapeRegex(botUsername)}\\b`, "i");
  if (!mentionPattern.test(text)) {
    return null;
  }
  return text.replace(mentionPattern, "").trim();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTelegramFormattingPrompt(userMessage: string): string {
  return [
    "Formatting rules for this response:",
    "- You are replying in a Telegram chat.",
    "- Use **double asterisks** for bold.",
    "- Use short paragraphs separated by blank lines.",
    "- Use plain bullet lists with - dashes.",
    "- Use `backticks` for inline code and ``` for code blocks.",
    "- Do NOT use Markdown headings (#). Use bold text instead.",
    "- Do NOT use tables. Use bullet lists to present tabular data.",
    "- Keep formatting minimal and readable on mobile.",
    "",
    `User request: ${userMessage}`
  ].join("\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function markdownToTelegramHtml(text: string): string {
  const codeBlocks: string[] = [];
  let result = text.replace(/```(?:\w*\n)?([\s\S]*?)```/g, (_match, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre>${escapeHtml(code.trim())}</pre>`);
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  const inlineCode: string[] = [];
  result = result.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const idx = inlineCode.length;
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE_${idx}\x00`;
  });

  result = escapeHtml(result);

  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, "<i>$1</i>");
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`\x00CODEBLOCK_${i}\x00`, codeBlocks[i]);
  }
  for (let i = 0; i < inlineCode.length; i++) {
    result = result.replace(`\x00INLINE_${i}\x00`, inlineCode[i]);
  }

  return result.trim();
}

function buildConversationId(chatId: number, topicId: number | undefined): string {
  const topic = topicId ? `_topic${topicId}` : "";
  return `telegram_${chatId}${topic}`;
}

export async function startTelegramAgentServer(
  options: TelegramAgentServerOptions
): Promise<TelegramAgentServerController> {
  if (!options.botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required.");
  }

  const bot = new Bot(options.botToken);
  const processedUpdateIds = new Set<number>();
  const MAX_PROCESSED_CACHE = 5000;

  const emitEvent = async (
    eventType: string,
    level: AdminBotEvent["level"],
    message: string,
    metadata?: Record<string, unknown>
  ): Promise<void> => {
    try {
      await options.onEvent?.({ level, eventType, message, metadata });
    } catch {
      // ignore observer failures
    }
  };

  const botInfo = await bot.api.getMe();
  const botUsername = botInfo.username;

  bot.on("message:text", async (ctx) => {
    const updateId = ctx.update.update_id;
    if (processedUpdateIds.has(updateId)) {
      return;
    }
    processedUpdateIds.add(updateId);
    if (processedUpdateIds.size > MAX_PROCESSED_CACHE) {
      const entries = [...processedUpdateIds];
      for (let i = 0; i < entries.length - MAX_PROCESSED_CACHE; i++) {
        processedUpdateIds.delete(entries[i]);
      }
    }

    const chat = ctx.chat;
    const message = ctx.message;
    const chatId = chat.id;
    const chatIdStr = chatId.toString();
    const isGroup = chat.type === "group" || chat.type === "supergroup";
    const isPrivate = chat.type === "private";

    if (!isGroup && !isPrivate) {
      return;
    }

    let userText: string;
    if (isGroup) {
      const replyToBot =
        message.reply_to_message?.from?.id === botInfo.id;
      const mentionedText = botUsername
        ? extractBotMentionText(message.text, botUsername)
        : null;
      if (mentionedText !== null) {
        userText = mentionedText;
      } else if (replyToBot) {
        userText = message.text;
      } else {
        return;
      }
    } else {
      userText = message.text;
    }

    if (!userText.trim()) {
      return;
    }

    const userId = message.from?.id?.toString() ?? null;
    const topicId = message.message_thread_id;
    const chatTitle = "title" in chat ? (chat as unknown as Record<string, unknown>).title : null;
    process.stderr.write(
      `[telegram] message from chat_id=${chatIdStr}${chatTitle ? ` (${chatTitle})` : ""} user=${userId ?? "unknown"} type=${chat.type}\n`
    );

    const tenantId =
      options.store.getTelegramChatTenant(chatIdStr) ??
      options.defaultTenantId ??
      "";

    if (!tenantId) {
      await emitEvent("routing.unmapped", "warn", "Telegram message rejected: no tenant mapping.", {
        chatId: chatIdStr
      });
      await ctx.reply(
        `No tenant mapping found for this chat. Run:\n  npm run dev -- telegram-map-channel --chat ${chatIdStr} --tenant <your-tenant-id>`
      );
      return;
    }

    await emitEvent("message.received", "info", "Telegram message received.", {
      tenantId,
      chatId: chatIdStr,
      userId
    });

    const profileName = options.defaultProfileName ?? "default";
    const conversationId = buildConversationId(chatId, topicId);

    try {
      await ctx.replyWithChatAction("typing");

      const promptText = buildTelegramFormattingPrompt(userText);
      const response = await options.runtime.respond(
        {
          tenantId,
          profileName,
          conversationId,
          llmModel: options.llmModel,
          origin: {
            source: "telegram" as "slack" | "cli",
            channelId: chatIdStr,
            userId: userId ?? undefined
          }
        },
        userText,
        { promptText }
      );

      const html = markdownToTelegramHtml(response.text);
      const replyOpts = {
        parse_mode: "HTML" as const,
        reply_parameters: isGroup ? { message_id: message.message_id } : undefined
      };
      try {
        await ctx.reply(html, replyOpts);
      } catch {
        await ctx.reply(response.text, {
          reply_parameters: replyOpts.reply_parameters
        });
      }

      await emitEvent("message.completed", "info", "Telegram message processed.", {
        tenantId,
        chatId: chatIdStr,
        conversationId
      });

      const chartConfig = getChartConfigFromArtifacts(response.artifacts);
      if (chartConfig) {
        try {
          const chartPng = await buildChartPngBuffer(chartConfig);
          await ctx.replyWithPhoto(new InputFile(chartPng, `chart-${Date.now()}.png`));
        } catch (chartError) {
          await emitEvent("message.chart_upload_failed", "warn", "Failed to send Telegram chart.", {
            tenantId,
            chatId: chatIdStr,
            error: (chartError as Error).message
          });
          process.stderr.write(
            `Warning: failed to render/send Telegram chart: ${(chartError as Error).message}\n`
          );
        }
      }
    } catch (error) {
      await emitEvent("message.error", "error", "Telegram message processing failed.", {
        tenantId,
        chatId: chatIdStr,
        error: (error as Error).message
      });
      const errMsg = `I hit an error while processing that request: ${(error as Error).message}`;
      await ctx.reply(errMsg, {
        reply_parameters: isGroup ? { message_id: message.message_id } : undefined
      });
    }
  });

  bot.catch(async (err) => {
    await emitEvent("bot.error", "error", "Telegram bot error.", {
      error: err.message
    });
    process.stderr.write(`Telegram bot error: ${err.message}\n`);
  });

  bot.start({
    onStart: () => {
      void emitEvent("bot.started", "info", "Telegram agent bot started.", {
        username: botUsername
      });
      process.stdout.write(
        `Telegram agent bot started as @${botUsername} (long polling)\n`
      );
    }
  });

  return {
    async stop() {
      await emitEvent("bot.stopping", "info", "Stopping Telegram agent bot.");
      await bot.stop();
      await emitEvent("bot.stopped", "info", "Telegram agent bot stopped.");
    }
  };
}
