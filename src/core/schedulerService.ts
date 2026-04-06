import { CronJob, CronTime } from "cron";
import type { AnalyticsAgentRuntime } from "./agentRuntime.js";
import type { ConversationStore } from "./interfaces.js";
import type { ScheduleChannelType, TenantSchedule } from "./types.js";

export interface SchedulerServiceOptions {
  store: ConversationStore;
  createRuntime: () => AnalyticsAgentRuntime;
  slackBotToken?: string;
  telegramBotToken?: string;
  timezone?: string;
  llmModel?: string;
  refreshIntervalMs?: number;
}

export class SchedulerService {
  private readonly jobs = new Map<string, CronJob>();
  private readonly tenantJobs = new Map<string, Set<string>>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private runtime: AnalyticsAgentRuntime | null = null;
  private readonly timezone: string;
  private readonly refreshIntervalMs: number;

  constructor(private readonly options: SchedulerServiceOptions) {
    this.timezone = options.timezone || "UTC";
    const interval = options.refreshIntervalMs ?? 60_000;
    this.refreshIntervalMs = Number.isFinite(interval) && interval > 0 ? interval : 60_000;
  }

  async start(): Promise<void> {
    await this.refreshAll();
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    this.refreshTimer = setInterval(() => {
      void this.refreshAll().catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[scheduler] refreshAll error", error);
      });
    }, this.refreshIntervalMs);
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const job of this.jobs.values()) {
      try {
        job.stop();
      } catch {
        // ignore
      }
    }
    this.jobs.clear();
    this.tenantJobs.clear();
    this.runtime = null;
  }

  async refreshAll(): Promise<void> {
    const tenants = this.options.store.listTenants().map((t) => t.tenantId);
    for (const tenantId of tenants) {
      await this.refreshTenant(tenantId);
    }
  }

  async refreshTenant(tenantId: string): Promise<void> {
    this.removeTenantJobs(tenantId);
    const schedules = this.options.store.listTenantSchedules(tenantId);
    for (const schedule of schedules) {
      this.registerSchedule(schedule);
    }
  }

  async runNow(tenantId: string, scheduleId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const schedule = this.options.store.getTenantSchedule(tenantId, scheduleId);
      if (!schedule) {
        return { ok: false, error: "Schedule not found" };
      }
      await this.executeSchedule(scheduleId, tenantId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  private async getRuntime(): Promise<AnalyticsAgentRuntime> {
    if (!this.runtime) {
      this.runtime = this.options.createRuntime();
    }
    return this.runtime;
  }

  private removeTenantJobs(tenantId: string): void {
    const ids = this.tenantJobs.get(tenantId);
    if (!ids) {
      return;
    }
    for (const id of ids) {
      const job = this.jobs.get(id);
      if (job) {
        try {
          job.stop();
        } catch {
          // ignore stop errors
        }
        this.jobs.delete(id);
      }
    }
    this.tenantJobs.delete(tenantId);
  }

  private trackTenantJob(tenantId: string, jobId: string): void {
    const next = this.tenantJobs.get(tenantId) ?? new Set<string>();
    next.add(jobId);
    this.tenantJobs.set(tenantId, next);
  }

  private registerSchedule(schedule: TenantSchedule): void {
    const { id, tenantId } = schedule;
    try {
      // validate cron expression eagerly
      // eslint-disable-next-line no-new
      new CronTime(schedule.cron, this.timezone);
    } catch (error) {
      this.options.store.updateTenantSchedule(id, {
        lastError: (error as Error).message
      });
      return;
    }

    if (!schedule.active) {
      this.options.store.updateTenantSchedule(id, { lastError: null });
      return;
    }

    const job = new CronJob(
      schedule.cron,
      () => {
        void this.executeSchedule(id, tenantId);
      },
      null,
      true,
      this.timezone
    );
    this.jobs.set(id, job);
    this.trackTenantJob(tenantId, id);
    this.options.store.updateTenantSchedule(id, { lastError: null });
  }

  private async executeSchedule(scheduleId: string, tenantId: string): Promise<void> {
    const schedule = this.options.store.getTenantSchedule(tenantId, scheduleId);
    if (!schedule || !schedule.active) {
      return;
    }

    const runtime = await this.getRuntime();
    const normalizedId = schedule.id.replace(/^sched_?/, "");
    const conversationId = `sched_${normalizedId}`;
    const startedAt = new Date().toISOString();
    try {
      this.options.store.createConversation({
        tenantId: schedule.tenantId,
        profileName: "default",
        conversationId,
        llmModel: this.options.llmModel,
        origin: {
          source: "admin",
          channelId: schedule.channelRef ?? undefined
        }
      });
      this.options.store.upsertConversationOrigin(conversationId, schedule.tenantId, {
        source: "admin",
        channelId: schedule.channelRef ?? undefined
      });
      const response = await runtime.respond(
        {
          tenantId: schedule.tenantId,
          profileName: "default",
          conversationId,
          llmModel: this.options.llmModel,
          origin: {
            source: "admin",
            channelId: schedule.channelRef ?? undefined
          }
        },
        schedule.userRequest,
        { promptText: schedule.userRequest }
      );
      await this.deliverText(schedule, response.text);
      this.options.store.updateTenantSchedule(schedule.id, {
        lastRunAt: startedAt,
        lastError: null
      });
    } catch (error) {
      this.options.store.updateTenantSchedule(schedule.id, {
        lastRunAt: startedAt,
        lastError: (error as Error).message
      });
    }
  }

  private async deliverText(schedule: TenantSchedule, text: string): Promise<void> {
    const channelType = schedule.channelType as ScheduleChannelType;
    if (channelType === "console") {
      // eslint-disable-next-line no-console
      console.log(`[schedule ${schedule.id}] ${text}`);
      return;
    }
    if (channelType === "custom") {
      return;
    }
    if (!schedule.channelRef?.trim()) {
      throw new Error("channelRef is required for delivery.");
    }

    if (channelType === "slack") {
      const token = this.options.slackBotToken || process.env.SLACK_BOT_TOKEN || "";
      if (!token) {
        throw new Error("SLACK_BOT_TOKEN is required for Slack delivery.");
      }
      const response = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({ channel: schedule.channelRef, text })
      });
      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (!data.ok) {
        throw new Error(data.error || "Slack API error");
      }
      return;
    }

    if (channelType === "telegram") {
      const token = this.options.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || "";
      if (!token) {
        throw new Error("TELEGRAM_BOT_TOKEN is required for Telegram delivery.");
      }
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ chat_id: schedule.channelRef, text })
      });
      const data = (await response.json()) as { ok?: boolean; description?: string };
      if (!data.ok) {
        throw new Error(data.description || "Telegram API error");
      }
    }
  }
}
