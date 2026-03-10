import { AnalyticsAgentRuntime } from "../../../core/agentRuntime.js";
import type { ConversationStore } from "../../../core/interfaces.js";
import type { AdminBotEvent, AdminBotState } from "../../../core/types.js";
import { env } from "../../../config/env.js";
import {
  parseSlackTeamTenantMap,
  SlackAgentServerController,
  startSlackAgentServer
} from "../../channel/slack/slackAgentServer.js";

export interface SlackBotSupervisorOptions {
  store: ConversationStore;
  createRuntime: () => AnalyticsAgentRuntime;
}

export class SlackBotSupervisor {
  private controller: SlackAgentServerController | null = null;
  private operation: Promise<AdminBotState> | null = null;
  private readonly botName = "slack";

  constructor(private readonly options: SlackBotSupervisorOptions) {
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
      port: env.slackPort,
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
        port: current.port,
        lastStartedAt: current.lastStartedAt,
        lastStoppedAt: this.nowIso(),
        lastErrorAt: current.lastErrorAt,
        lastErrorMessage: current.lastErrorMessage
      });
      this.appendEvent("warn", "bot.reconciled", "Reset stale Slack bot state after process restart.", {
        previousActualState: current.actualState,
        updatedAt: reconciled.updatedAt
      });
    }
  }

  private effectiveSlackPort(port?: number): number {
    return Number.isFinite(port) && typeof port === "number" && port > 0 ? port : env.slackPort;
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

  async start(port?: number): Promise<AdminBotState> {
    return this.runExclusive(async () => {
      const current = this.readState();
      if (this.controller) {
        return this.saveState({
          botName: this.botName,
          desiredState: "running",
          actualState: "running",
          port: this.controller.port,
          lastStartedAt: current.lastStartedAt ?? this.nowIso(),
          lastStoppedAt: current.lastStoppedAt,
          lastErrorAt: current.lastErrorAt,
          lastErrorMessage: current.lastErrorMessage
        });
      }

      const effectivePort = this.effectiveSlackPort(port ?? current.port);
      this.saveState({
        botName: this.botName,
        desiredState: "running",
        actualState: "starting",
        port: effectivePort,
        lastStartedAt: current.lastStartedAt,
        lastStoppedAt: current.lastStoppedAt,
        lastErrorAt: current.lastErrorAt,
        lastErrorMessage: current.lastErrorMessage
      });
      this.appendEvent("info", "bot.starting", "Starting Slack bot.", { port: effectivePort });

      try {
        const guardrails = this.options.store.getGuardrails();
        const teamTenantMap =
          guardrails?.teamTenantMap && Object.keys(guardrails.teamTenantMap).length > 0
            ? guardrails.teamTenantMap
            : parseSlackTeamTenantMap(env.slackTeamTenantMapRaw);
        const ownerTeamIds =
          guardrails?.ownerTeamIds && guardrails.ownerTeamIds.length > 0
            ? guardrails.ownerTeamIds
            : env.slackOwnerTeamIdsRaw
                .split(",")
                .map((value) => value.trim())
                .filter((value) => value.length > 0);
        const ownerEnterpriseIds =
          guardrails?.ownerEnterpriseIds && guardrails.ownerEnterpriseIds.length > 0
            ? guardrails.ownerEnterpriseIds
            : env.slackOwnerEnterpriseIdsRaw
                .split(",")
                .map((value) => value.trim())
                .filter((value) => value.length > 0);

        this.controller = await startSlackAgentServer({
          runtime: this.options.createRuntime(),
          store: this.options.store,
          botToken: env.slackBotToken,
          signingSecret: env.slackSigningSecret,
          port: effectivePort,
          defaultTenantId: env.slackDefaultTenantId || guardrails?.defaultTenantId || undefined,
          defaultProfileName: env.slackDefaultProfileName || "default",
          llmModel: env.llmModel,
          teamTenantMap,
          ownerTeamIds,
          ownerEnterpriseIds,
          strictTenantRouting: guardrails?.strictTenantRouting ?? env.slackStrictTenantRouting,
          onEvent: (event) => {
            this.appendEvent(event.level, event.eventType, event.message, event.metadata);
          }
        });

        const startedAt = this.nowIso();
        return this.saveState({
          botName: this.botName,
          desiredState: "running",
          actualState: "running",
          port: effectivePort,
          lastStartedAt: startedAt,
          lastStoppedAt: current.lastStoppedAt,
          lastErrorAt: undefined,
          lastErrorMessage: undefined
        });
      } catch (error) {
        const errorMessage = (error as Error).message;
        const failedAt = this.nowIso();
        this.appendEvent("error", "bot.start_failed", "Failed to start Slack bot.", {
          error: errorMessage,
          port: effectivePort
        });
        return this.saveState({
          botName: this.botName,
          desiredState: "running",
          actualState: "error",
          port: effectivePort,
          lastStartedAt: current.lastStartedAt,
          lastStoppedAt: current.lastStoppedAt,
          lastErrorAt: failedAt,
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
          port: current.port,
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
        port: current.port ?? this.controller.port,
        lastStartedAt: current.lastStartedAt,
        lastStoppedAt: current.lastStoppedAt,
        lastErrorAt: current.lastErrorAt,
        lastErrorMessage: current.lastErrorMessage
      });
      this.appendEvent("info", "bot.stopping", "Stopping Slack bot.", {
        port: current.port ?? this.controller.port
      });

      try {
        await this.controller.stop();
        this.controller = null;
        return this.saveState({
          botName: this.botName,
          desiredState: "stopped",
          actualState: "stopped",
          port: current.port,
          lastStartedAt: current.lastStartedAt,
          lastStoppedAt: this.nowIso(),
          lastErrorAt: current.lastErrorAt,
          lastErrorMessage: current.lastErrorMessage
        });
      } catch (error) {
        const errorMessage = (error as Error).message;
        this.appendEvent("error", "bot.stop_failed", "Failed to stop Slack bot.", {
          error: errorMessage
        });
        return this.saveState({
          botName: this.botName,
          desiredState: "stopped",
          actualState: "error",
          port: current.port,
          lastStartedAt: current.lastStartedAt,
          lastStoppedAt: current.lastStoppedAt,
          lastErrorAt: this.nowIso(),
          lastErrorMessage: errorMessage
        });
      }
    });
  }

  async restart(port?: number): Promise<AdminBotState> {
    await this.stop();
    return this.start(port);
  }
}
