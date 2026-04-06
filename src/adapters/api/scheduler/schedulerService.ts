import { CronJob } from "cron";
import { AnalyticsAgentRuntime } from "../../../core/agentRuntime.js";
import type { ConversationStore } from "../../../core/interfaces.js";
import type { TenantSchedule } from "../../../core/types.js";
import { env } from "../../../config/env.js";

export interface SchedulerServiceOptions {
  store: ConversationStore;
  createRuntime: () => AnalyticsAgentRuntime;
  slackBotToken?: string;
  telegramBotToken?: string;
  timezone?: string;
  llmModel?: string;
  refreshIntervalMs?: number;
}

type TaskRecord = {
  job: CronJob;
  schedule: TenantSchedule;
};

export class SchedulerService {
  private tasks: Map<string, TaskRecord> = new Map();
  private stopped = false;
  private readonly timezone: string;
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly refreshIntervalMs: number;

  constructor(private readonly options: SchedulerServiceOptions) {
    this.timezone = options.timezone || "UTC";
    this.refreshIntervalMs = options.refreshIntervalMs ?? 60_000;
  }

  start(): void {
    this.stopped = false;
    this.refreshAll();
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    this.refreshTimer = setInterval(() => this.refreshAll(), this.refreshIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const entry of this.tasks.values()) {
      entry.job.stop();
    }
    this.tasks.clear();
  }

  refreshAll(): void {
    if (this.stopped) return;
    const tenants = this.options.store.listTenants();
    for (const tenant of tenants) {
      this.refreshTenant(tenant.tenantId);
    }
  }

  refreshTenant(tenantId: string): void {
    if (this.stopped) return;
    // remove previous tasks for tenant
    for (const [scheduleId, record] of this.tasks) {
      if (record.schedule.tenantId === tenantId) {
        record.job.stop();
        this.tasks.delete(scheduleId);
      }
    }

    const schedules = this.options.store.listTenantSchedules(tenantId);
    for (const schedule of schedules) {
      if (!schedule.active) continue;
      try {
        const job = new CronJob(
          schedule.cron,
          () => {
            void this.executeSchedule(schedule);
          },
          null,
          true,
          this.timezone
        );
        this.tasks.set(schedule.id, { job, schedule });
      } catch (error) {
        this.options.store.updateTenantSchedule(schedule.id, {
          lastRunAt: new Date().toISOString(),
          lastError: (error as Error).message
        });
      }
    }
  }

  async runNow(tenantId: string, scheduleId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const schedule = this.options.store.getTenantSchedule(tenantId, scheduleId);
    if (!schedule) {
      return { ok: false, error: "Schedule not found" };
    }
    try {
      await this.executeSchedule(schedule);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  private async executeSchedule(schedule: TenantSchedule): Promise<void> {
    const nowIso = new Date().toISOString();
    try {
      const runtime = this.options.createRuntime();
      const conversationId = `sched_${schedule.id}`;
      this.options.store.createConversation({
        tenantId: schedule.tenantId,
        profileName: "default",
        conversationId
      });
      this.options.store.upsertConversationOrigin(conversationId, schedule.tenantId, {
        source: "admin",
        channelId: schedule.channelRef
      });
      this.options.store.addMessage({
        tenantId: schedule.tenantId,
        conversationId,
        role: "user",
        content: schedule.userRequest
      });

      const response = await runtime.respond(
        {
          tenantId: schedule.tenantId,
          profileName: "default",
          conversationId,
          llmModel: this.options.llmModel ?? env.llmModel,
          origin: { source: "admin", channelId: schedule.channelRef }
        },
        schedule.userRequest
      );

      this.options.store.addMessage({
        tenantId: schedule.tenantId,
        conversationId,
        role: "assistant",
        content: response.text
      });

      await this.deliver(schedule, response.text);

      this.options.store.updateTenantSchedule(schedule.id, {
        lastRunAt: nowIso,
        lastError: undefined
      });
    } catch (error) {
      this.options.store.updateTenantSchedule(schedule.id, {
        lastRunAt: nowIso,
        lastError: (error as Error).message
      });
    }
  }

  private async deliver(schedule: TenantSchedule, text: string): Promise<void> {
    switch (schedule.channelType) {
      case "slack": {
        const token = this.options.slackBotToken ?? env.slackBotToken;
        if (!token) throw new Error("Missing SLACK_BOT_TOKEN for scheduled message.");
        const response = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8"
          },
          body: JSON.stringify({ channel: schedule.channelRef, text })
        });
        const json = (await response.json()) as { ok?: boolean; error?: string };
        if (!json.ok) {
          throw new Error(json.error || "Failed to post Slack message");
        }
        return;
      }
      case "telegram": {
        const token = this.options.telegramBotToken ?? env.telegramBotToken;
        if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN for scheduled message.");
        const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: schedule.channelRef, text })
        });
        const json = (await response.json()) as { ok?: boolean; description?: string };
        if (!json.ok) {
          throw new Error(json.description || "Failed to post Telegram message");
        }
        return;
      }
      case "console": {
        // eslint-disable-next-line no-console
        console.log(`[schedule:${schedule.id}] ${text}`);
        return;
      }
      case "custom": {
        // No-op placeholder for custom integrations
        return;
      }
      default:
        throw new Error(`Unsupported channel type: ${schedule.channelType}`);
    }
  }
}
