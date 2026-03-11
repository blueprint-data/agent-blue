import { AnalyticsAgentRuntime } from "../../../core/agentRuntime.js";
import type { ConversationStore } from "../../../core/interfaces.js";
import type { AdminBotEvent, AdminBotState } from "../../../core/types.js";
import { env } from "../../../config/env.js";
import {
  startTelegramAgentServer,
  type TelegramAgentServerController
} from "../../channel/telegram/telegramAgentServer.js";

export interface TelegramBotSupervisorOptions {
  store: ConversationStore;
  createRuntime: () => AnalyticsAgentRuntime;
}

export class TelegramBotSupervisor {
  private controller: TelegramAgentServerController | null = null;
  private operation: Promise<AdminBotState> | null = null;
  private readonly botName = "telegram";

  constructor(private readonly options: TelegramBotSupervisorOptions) {
    this.reconcilePersistedState();
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private appendEvent(level: AdminBotEvent["level"], eventType: string, message: string, metadata?: Record<string, unknown>): void {
    this.options.store.appendAdminBotEvent({
      botName: this.botName,
      level,
      eventType,
      message,
      metadata
    });
  }

  private defaultState(): AdminBotState {
    return {
      botName: this.botName,
      desiredState: "stopped",
      actualState: "stopped",
      updatedAt: this.nowIso()
    };
  }

  private readState(): AdminBotState {
    return this.options.store.getAdminBotState(this.botName) ?? this.defaultState();
  }

  private saveState(input: Omit<AdminBotState, "updatedAt">): AdminBotState {
    return this.options.store.upsertAdminBotState(input);
  }

  private reconcilePersistedState(): void {
    const current = this.options.store.getAdminBotState(this.botName);
    if (!current) {
      return;
    }
    if (current.actualState === "running" || current.actualState === "starting" || current.actualState === "stopping") {
      const reconciled = this.saveState({
        botName: this.botName,
        desiredState: "stopped",
        actualState: "stopped",
        lastStartedAt: current.lastStartedAt,
        lastStoppedAt: this.nowIso(),
        lastErrorAt: current.lastErrorAt,
        lastErrorMessage: current.lastErrorMessage
      });
      this.appendEvent("warn", "bot.reconciled", "Reset stale Telegram bot state after process restart.", {
        previousActualState: current.actualState,
        updatedAt: reconciled.updatedAt
      });
    }
  }

  private async runExclusive(fn: () => Promise<AdminBotState>): Promise<AdminBotState> {
    if (this.operation) {
      return this.operation;
    }
    this.operation = fn().finally(() => {
      this.operation = null;
    });
    return this.operation;
  }

  getStatus(): AdminBotState {
    return this.readState();
  }

  listEvents(limit = 100): AdminBotEvent[] {
    return this.options.store.listAdminBotEvents(this.botName, limit);
  }

  async start(): Promise<AdminBotState> {
    return this.runExclusive(async () => {
      const current = this.readState();
      if (this.controller) {
        return this.saveState({
          botName: this.botName,
          desiredState: "running",
          actualState: "running",
          lastStartedAt: current.lastStartedAt ?? this.nowIso(),
          lastStoppedAt: current.lastStoppedAt,
          lastErrorAt: current.lastErrorAt,
          lastErrorMessage: current.lastErrorMessage
        });
      }

      if (!env.telegramBotToken) {
        const errorMessage = "TELEGRAM_BOT_TOKEN is not set. Cannot start Telegram bot.";
        this.appendEvent("error", "bot.start_failed", errorMessage);
        return this.saveState({
          botName: this.botName,
          desiredState: "running",
          actualState: "error",
          lastStartedAt: current.lastStartedAt,
          lastStoppedAt: current.lastStoppedAt,
          lastErrorAt: this.nowIso(),
          lastErrorMessage: errorMessage
        });
      }

      this.saveState({
        botName: this.botName,
        desiredState: "running",
        actualState: "starting",
        lastStartedAt: current.lastStartedAt,
        lastStoppedAt: current.lastStoppedAt,
        lastErrorAt: current.lastErrorAt,
        lastErrorMessage: current.lastErrorMessage
      });
      this.appendEvent("info", "bot.starting", "Starting Telegram bot.");

      try {
        this.controller = await startTelegramAgentServer({
          runtime: this.options.createRuntime(),
          store: this.options.store,
          botToken: env.telegramBotToken,
          defaultTenantId: env.telegramDefaultTenantId || undefined,
          defaultProfileName: env.telegramDefaultProfileName || "default",
          llmModel: env.llmModel,
          onEvent: (event) => {
            this.appendEvent(event.level, event.eventType, event.message, event.metadata);
          }
        });

        return this.saveState({
          botName: this.botName,
          desiredState: "running",
          actualState: "running",
          lastStartedAt: this.nowIso(),
          lastStoppedAt: current.lastStoppedAt,
          lastErrorAt: undefined,
          lastErrorMessage: undefined
        });
      } catch (error) {
        const errorMessage = (error as Error).message;
        this.appendEvent("error", "bot.start_failed", "Failed to start Telegram bot.", {
          error: errorMessage
        });
        return this.saveState({
          botName: this.botName,
          desiredState: "running",
          actualState: "error",
          lastStartedAt: current.lastStartedAt,
          lastStoppedAt: current.lastStoppedAt,
          lastErrorAt: this.nowIso(),
          lastErrorMessage: errorMessage
        });
      }
    });
  }

  async stop(): Promise<AdminBotState> {
    return this.runExclusive(async () => {
      const current = this.readState();
      if (!this.controller) {
        return this.saveState({
          botName: this.botName,
          desiredState: "stopped",
          actualState: "stopped",
          lastStartedAt: current.lastStartedAt,
          lastStoppedAt: current.lastStoppedAt ?? this.nowIso(),
          lastErrorAt: current.lastErrorAt,
          lastErrorMessage: current.lastErrorMessage
        });
      }

      this.saveState({
        botName: this.botName,
        desiredState: "stopped",
        actualState: "stopping",
        lastStartedAt: current.lastStartedAt,
        lastStoppedAt: current.lastStoppedAt,
        lastErrorAt: current.lastErrorAt,
        lastErrorMessage: current.lastErrorMessage
      });
      this.appendEvent("info", "bot.stopping", "Stopping Telegram bot.");

      try {
        await this.controller.stop();
        this.controller = null;
        return this.saveState({
          botName: this.botName,
          desiredState: "stopped",
          actualState: "stopped",
          lastStartedAt: current.lastStartedAt,
          lastStoppedAt: this.nowIso(),
          lastErrorAt: current.lastErrorAt,
          lastErrorMessage: current.lastErrorMessage
        });
      } catch (error) {
        const errorMessage = (error as Error).message;
        this.appendEvent("error", "bot.stop_failed", "Failed to stop Telegram bot.", {
          error: errorMessage
        });
        return this.saveState({
          botName: this.botName,
          desiredState: "stopped",
          actualState: "error",
          lastStartedAt: current.lastStartedAt,
          lastStoppedAt: current.lastStoppedAt,
          lastErrorAt: this.nowIso(),
          lastErrorMessage: errorMessage
        });
      }
    });
  }

  async restart(): Promise<AdminBotState> {
    await this.stop();
    return this.start();
  }
}
