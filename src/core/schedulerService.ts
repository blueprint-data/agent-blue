import { CronJob, CronTime } from "cron";
import type { ChartConfiguration } from "chart.js";
import type { AnalyticsAgentRuntime } from "./agentRuntime.js";
import type { ConversationStore } from "./interfaces.js";
import type { AgentArtifact, ScheduleChannelType, TenantSchedule } from "./types.js";

export interface SchedulerServiceOptions {
  store: ConversationStore;
  createRuntime: () => AnalyticsAgentRuntime;
  slackBotToken?: string;
  telegramBotToken?: string;
  timezone?: string;
  llmModel?: string;
  refreshIntervalMs?: number;
}

function getChartConfigFromArtifacts(artifacts: AgentArtifact[] | undefined): Record<string, unknown> | null {
  if (!Array.isArray(artifacts)) {
    return null;
  }
  for (const artifact of artifacts) {
    if (artifact.type === "chartjs_config" && artifact.format === "json" && artifact.payload) {
      return artifact.payload;
    }
  }
  return null;
}

async function buildChartPngBuffer(config: Record<string, unknown>): Promise<Buffer> {
  const { ChartJSNodeCanvas } = await import("chartjs-node-canvas");
  const renderer = new ChartJSNodeCanvas({ width: 900, height: 500, backgroundColour: "white" });
  return renderer.renderToBuffer(config as unknown as ChartConfiguration);
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
      await this.executeSchedule(scheduleId, tenantId, true);
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

  private async executeSchedule(scheduleId: string, tenantId: string, forceRun = false): Promise<void> {
    const schedule = this.options.store.getTenantSchedule(tenantId, scheduleId);
    if (!schedule || (!schedule.active && !forceRun)) {
      return;
    }

    const runtime = await this.getRuntime();
    const normalizedId = schedule.id.replace(/^sched_?/, "");
    const runId = Date.now().toString(36);
    const conversationId = `sched_${normalizedId}_${runId}`;
    const startedAt = new Date().toISOString();
    try {
      this.options.store.appendAdminBotEvent({
        botName: "scheduler",
        level: "info",
        eventType: "schedule.execution_started",
        message: "Schedule execution started",
        metadata: { tenantId, scheduleId, conversationId, forceRun, startedAt }
      });
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
      const chartConfig = getChartConfigFromArtifacts(response.artifacts);
      if (chartConfig) {
        await this.deliverChart(schedule, chartConfig);
      }
      this.options.store.updateTenantSchedule(schedule.id, {
        lastRunAt: startedAt,
        lastError: null
      });
      this.options.store.appendAdminBotEvent({
        botName: "scheduler",
        level: "info",
        eventType: "schedule.execution_completed",
        message: "Schedule execution completed",
        metadata: {
          tenantId,
          scheduleId,
          conversationId,
          artifactCount: Array.isArray(response.artifacts) ? response.artifacts.length : 0
        }
      });
    } catch (error) {
      this.options.store.updateTenantSchedule(schedule.id, {
        lastRunAt: startedAt,
        lastError: (error as Error).message
      });
      this.options.store.appendAdminBotEvent({
        botName: "scheduler",
        level: "error",
        eventType: "schedule.execution_failed",
        message: "Schedule execution failed",
        metadata: { tenantId, scheduleId, conversationId, error: (error as Error).message }
      });
    }
  }

  private async deliverChart(schedule: TenantSchedule, chartConfig: Record<string, unknown>): Promise<void> {
    const channelType = schedule.channelType as ScheduleChannelType;
    if (channelType !== "slack" && channelType !== "telegram") {
      return;
    }
    if (!schedule.channelRef?.trim()) {
      return;
    }

    let chartPng: Buffer;
    try {
      chartPng = await buildChartPngBuffer(chartConfig);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[scheduler] chart render failed for ${schedule.id}:`, err);
      return;
    }

    if (channelType === "slack") {
      const token = this.options.slackBotToken || process.env.SLACK_BOT_TOKEN || "";
      if (!token) return;
      try {
        const { WebClient } = await import("@slack/web-api");
        const client = new WebClient(token);
        await client.files.uploadV2({
          channel_id: schedule.channelRef,
          filename: `chart-${Date.now()}.png`,
          title: "Generated chart",
          file: chartPng
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[scheduler] Slack chart upload failed for ${schedule.id}:`, err);
      }
      return;
    }

    if (channelType === "telegram") {
      const token = this.options.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || "";
      if (!token) return;
      try {
        const form = new FormData();
        form.append("chat_id", schedule.channelRef);
        form.append(
          "photo",
          new Blob([chartPng.buffer as ArrayBuffer], { type: "image/png" }),
          `chart-${Date.now()}.png`
        );
        await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
          method: "POST",
          body: form
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[scheduler] Telegram chart upload failed for ${schedule.id}:`, err);
      }
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
      if (!text?.trim()) {
        throw new Error("Agent returned an empty response — nothing to deliver to Slack.");
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
