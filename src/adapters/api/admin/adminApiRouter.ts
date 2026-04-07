import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CronTime } from "cron";
import { NextFunction, Request, Response, Router } from "express";
import multer from "multer";
import type { ConversationStore } from "../../../core/interfaces.js";
import type {
  AdminGuardrails,
  TenantBigQueryConfig,
  TenantCredentialsRef,
  TenantSnowflakeConfig,
  TenantWarehouseProvider
} from "../../../core/interfaces.js";
import type { SchedulerService } from "../../../core/schedulerService.js";
import { initializeTenant } from "../../../bootstrap/initTenant.js";
import { buildWarehouseFromTenantConfig } from "../../../app.js";
import { GitDbtRepositoryService } from "../../dbt/dbtRepoService.js";
import { env } from "../../../config/env.js";
import type { AdminRequestAuth } from "./adminAccess.js";
import { adminAuthFromRequest, denyUnlessSuperadmin, denyUnlessTenantAccess } from "./adminApiAuth.js";

function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] ?? "" : (value ?? "");
}

export interface AdminApiRouterOptions {
  store: ConversationStore;
  appDataDir: string;
  schedulerService?: SchedulerService;
}

export function createAdminApiRouter(options: AdminApiRouterOptions): Router {
  const { store, appDataDir, schedulerService } = options;
  const router = Router();
  const dbtRepo = new GitDbtRepositoryService(store);
  const maxTenantMemoryChars = 300;

  function channelBotPublicFlags(tenantId: string): {
    hasSlackBotOverride: boolean;
    hasTelegramBotOverride: boolean;
  } {
    const s = store.getTenantChannelBotSecrets(tenantId);
    return {
      hasSlackBotOverride: Boolean(s?.slackBotToken && s.slackSigningSecret),
      hasTelegramBotOverride: Boolean(s?.telegramBotToken && s.telegramBotToken.trim().length > 0)
    };
  }

  function filterSlackMappingsForAuth(auth: AdminRequestAuth) {
    const full = {
      channels: store.listSlackChannelMappings(),
      users: store.listSlackUserMappings(),
      sharedTeams: store.listSlackSharedTeamMappings()
    };
    if (auth.role === "superadmin") {
      return full;
    }
    const tid = auth.scopedTenantId;
    if (!tid) {
      return { channels: [] as typeof full.channels, users: [] as typeof full.users, sharedTeams: [] as typeof full.sharedTeams };
    }
    return {
      channels: full.channels.filter((c) => c.tenantId === tid),
      users: full.users.filter((u) => u.tenantId === tid),
      sharedTeams: full.sharedTeams.filter((s) => s.tenantId === tid)
    };
  }

  router.get("/tenants", (req: Request, res: Response) => {
    try {
      const auth = adminAuthFromRequest(req);
      if (auth.role === "tenant_admin") {
        const tid = auth.scopedTenantId;
        if (!tid) {
          res.json([]);
          return;
        }
        if (denyUnlessTenantAccess(req, res, tid)) {
          return;
        }
        const all = store.listTenants();
        res.json(
          all
            .filter((t) => t.tenantId === tid)
            .map((t) => ({ ...t, ...channelBotPublicFlags(t.tenantId) }))
        );
        return;
      }
      res.json(store.listTenants().map((t) => ({ ...t, ...channelBotPublicFlags(t.tenantId) })));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/tenants/:tenantId", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const tenant = store.listTenants().find((entry) => entry.tenantId === tenantId);
      const base = tenant ?? repo;
      res.json({ ...base, ...channelBotPublicFlags(tenantId) });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post("/tenants", (req: Request, res: Response) => {
    try {
      if (denyUnlessSuperadmin(req, res)) {
        return;
      }
      const { tenantId, repoUrl, dbtSubpath = "models" } = req.body as {
        tenantId?: string;
        repoUrl?: string;
        dbtSubpath?: string;
      };
      if (!tenantId || !repoUrl) {
        res.status(400).json({ error: "tenantId and repoUrl required" });
        return;
      }
      const result = initializeTenant({ appDataDir, tenantId, repoUrl, dbtSubpath, force: false }, store);
      res.status(201).json({
        tenantId,
        repoUrl,
        dbtSubpath,
        localRepoPath: result.localRepoPath,
        message: "Tenant initialized. Add public key as GitHub Deploy Key."
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.patch("/tenants/:tenantId", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const { repoUrl, dbtSubpath, deployKeyPath } = req.body as {
        repoUrl?: string;
        dbtSubpath?: string;
        deployKeyPath?: string;
      };
      store.upsertTenantRepo({
        tenantId,
        repoUrl: repoUrl ?? repo.repoUrl,
        dbtSubpath: dbtSubpath ?? repo.dbtSubpath,
        deployKeyPath: deployKeyPath ?? repo.deployKeyPath,
        localPath: repo.localPath
      });
      const updated = store.getTenantRepo(tenantId);
      res.json(updated ? { ...updated, ...channelBotPublicFlags(tenantId) } : null);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.patch("/tenants/:tenantId/channel-bots", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const body = req.body as {
        slackBotToken?: string;
        slackSigningSecret?: string;
        telegramBotToken?: string;
        clearSlack?: boolean;
        clearTelegram?: boolean;
      };
      const prev = store.getTenantChannelBotSecrets(tenantId);
      let slackBotToken = prev?.slackBotToken ?? null;
      let slackSigningSecret = prev?.slackSigningSecret ?? null;
      let telegramBotToken = prev?.telegramBotToken ?? null;

      if (body.clearSlack) {
        slackBotToken = null;
        slackSigningSecret = null;
      }
      if (body.clearTelegram) {
        telegramBotToken = null;
      }

      const slackTokUpd = body.slackBotToken !== undefined;
      const slackSecUpd = body.slackSigningSecret !== undefined;
      if (!body.clearSlack && (slackTokUpd || slackSecUpd)) {
        const t = slackTokUpd ? String(body.slackBotToken).trim() : (slackBotToken ?? "");
        const s = slackSecUpd ? String(body.slackSigningSecret).trim() : (slackSigningSecret ?? "");
        if (t.length > 0 !== (s.length > 0)) {
          res.status(400).json({
            error:
              "When updating Slack credentials, provide both slackBotToken and slackSigningSecret (non-empty), or clear with clearSlack."
          });
          return;
        }
        slackBotToken = t.length > 0 ? t : null;
        slackSigningSecret = s.length > 0 ? s : null;
      }

      if (body.telegramBotToken !== undefined) {
        const trimmed = String(body.telegramBotToken).trim();
        telegramBotToken = trimmed.length > 0 ? trimmed : null;
      }

      store.upsertTenantChannelBotSecrets({
        tenantId,
        slackBotToken,
        slackSigningSecret,
        telegramBotToken
      });
      res.json({ ok: true, ...channelBotPublicFlags(tenantId) });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.delete("/tenants/:tenantId", (req: Request, res: Response) => {
    try {
      if (denyUnlessSuperadmin(req, res)) {
        return;
      }
      const tenantId = param(req, "tenantId");
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const keyMeta = store.getTenantKeyMetadata(tenantId);
      if (keyMeta?.filePath && fs.existsSync(keyMeta.filePath)) {
        try {
          fs.unlinkSync(keyMeta.filePath);
        } catch {
          // ignore unlink errors
        }
      }
      store.deleteTenant(tenantId);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/tenants/:tenantId/memories", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 100;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
      res.json(store.listTenantMemories(tenantId, limit));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post("/tenants/:tenantId/memories", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const rawContent = typeof req.body?.content === "string" ? req.body.content : "";
      const content = rawContent.trim();
      if (!content) {
        res.status(400).json({ error: "content is required" });
        return;
      }
      if (content.length > maxTenantMemoryChars) {
        res.status(400).json({ error: `content must be at most ${maxTenantMemoryChars} characters` });
        return;
      }
      const memory = store.createTenantMemory({
        tenantId,
        content,
        source: "manual"
      });
      res.status(201).json(memory);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.delete("/tenants/:tenantId/memories/:memoryId", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const memoryId = param(req, "memoryId");
      const memory = store.getTenantMemory(tenantId, memoryId);
      if (!memory) {
        res.status(404).json({ error: "Tenant memory not found" });
        return;
      }
      store.deleteTenantMemory(memory.id);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/tenants/:tenantId/admin-login-domains", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      res.json({ domains: store.listAdminLoginDomainsForTenant(tenantId) });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.put("/tenants/:tenantId/admin-login-domains", (req: Request, res: Response) => {
    try {
      if (denyUnlessSuperadmin(req, res)) {
        return;
      }
      const tenantId = param(req, "tenantId");
      if (!store.getTenantRepo(tenantId)) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const body = req.body as { domains?: unknown };
      const raw = body.domains;
      let domains: string[] = [];
      if (Array.isArray(raw)) {
        domains = raw.filter((x): x is string => typeof x === "string");
      } else if (typeof raw === "string") {
        domains = raw
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }
      try {
        store.setAdminLoginDomainsForTenant(tenantId, domains);
        res.json({ domains: store.listAdminLoginDomainsForTenant(tenantId) });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  function validateScheduleCron(cron: string): string | null {
    try {
      // eslint-disable-next-line no-new
      new CronTime(cron, env.schedulerTimezone || "UTC");
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }

  function assertTenantExists(tenantId: string): void {
    const repo = store.getTenantRepo(tenantId);
    if (!repo) {
      throw new Error("Tenant not found");
    }
  }

  router.get("/tenants/:tenantId/schedules", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      assertTenantExists(tenantId);
      res.json(store.listTenantSchedules(tenantId));
    } catch (error) {
      const message = (error as Error).message;
      res.status(message === "Tenant not found" ? 404 : 500).json({ error: message });
    }
  });

  router.get("/tenants/:tenantId/schedules/channel-options", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      assertTenantExists(tenantId);
      const slackChannels = store
        .listSlackChannelMappings()
        .filter((entry) => entry.tenantId === tenantId)
        .map((entry) => ({ channelId: entry.channelId, source: entry.source }));
      const telegramChats = store
        .listTelegramChatMappings()
        .filter((entry) => entry.tenantId === tenantId)
        .map((entry) => ({ chatId: entry.chatId, source: entry.source }));
      res.json({ slackChannels, telegramChats });
    } catch (error) {
      const message = (error as Error).message;
      res.status(message === "Tenant not found" ? 404 : 500).json({ error: message });
    }
  });

  router.post("/tenants/:tenantId/schedules", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      assertTenantExists(tenantId);

      const { userRequest, cron, channelType, channelRef, active } = req.body as {
        userRequest?: string;
        cron?: string;
        channelType?: string;
        channelRef?: string;
        active?: boolean;
      };

      const normalizedRequest = typeof userRequest === "string" ? userRequest.trim() : "";
      const normalizedCron = typeof cron === "string" ? cron.trim() : "";
      const normalizedChannelType = typeof channelType === "string" ? channelType.trim() : "";
      const normalizedChannelRef = typeof channelRef === "string" ? channelRef.trim() : undefined;
      if (!normalizedRequest || !normalizedCron || !normalizedChannelType) {
        res.status(400).json({ error: "userRequest, cron, and channelType are required" });
        return;
      }
      if (!["slack", "telegram", "console", "custom"].includes(normalizedChannelType)) {
        res.status(400).json({ error: "channelType must be slack, telegram, console, or custom" });
        return;
      }
      const cronError = validateScheduleCron(normalizedCron);
      if (cronError) {
        res.status(400).json({ error: "Invalid cron expression", hint: cronError });
        return;
      }

      const schedule = store.createTenantSchedule({
        tenantId,
        userRequest: normalizedRequest,
        cron: normalizedCron,
        channelType: normalizedChannelType as "slack" | "telegram" | "console" | "custom",
        channelRef: normalizedChannelRef,
        active: active !== false
      });
      void schedulerService?.refreshTenant(tenantId);
      res.status(201).json(schedule);
    } catch (error) {
      const message = (error as Error).message;
      res.status(message === "Tenant not found" ? 404 : 500).json({ error: message });
    }
  });

  router.put("/tenants/:tenantId/schedules/:scheduleId", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      const scheduleId = param(req, "scheduleId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      assertTenantExists(tenantId);
      const existing = store.getTenantSchedule(tenantId, scheduleId);
      if (!existing) {
        res.status(404).json({ error: "Schedule not found" });
        return;
      }

      const { userRequest, cron, channelType, channelRef, active } = req.body as {
        userRequest?: string;
        cron?: string;
        channelType?: string;
        channelRef?: string;
        active?: boolean;
      };

      const updates: Record<string, unknown> = {};
      if (typeof userRequest === "string") {
        updates.userRequest = userRequest.trim();
      }
      if (typeof cron === "string") {
        const normalizedCron = cron.trim();
        const cronError = validateScheduleCron(normalizedCron);
        if (cronError) {
          res.status(400).json({ error: "Invalid cron expression", hint: cronError });
          return;
        }
        updates.cron = normalizedCron;
      }
      if (typeof channelType === "string") {
        const normalizedType = channelType.trim();
        if (!["slack", "telegram", "console", "custom"].includes(normalizedType)) {
          res.status(400).json({ error: "channelType must be slack, telegram, console, or custom" });
          return;
        }
        updates.channelType = normalizedType as "slack" | "telegram" | "console" | "custom";
      }
      if (typeof channelRef === "string") {
        updates.channelRef = channelRef.trim();
      }
      if (typeof active === "boolean") {
        updates.active = active;
      }

      const updated = store.updateTenantSchedule(scheduleId, updates);
      if (!updated || updated.tenantId !== tenantId) {
        res.status(404).json({ error: "Schedule not found" });
        return;
      }
      void schedulerService?.refreshTenant(tenantId);
      res.json(updated);
    } catch (error) {
      const message = (error as Error).message;
      res.status(message === "Tenant not found" ? 404 : 500).json({ error: message });
    }
  });

  router.delete("/tenants/:tenantId/schedules/:scheduleId", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      const scheduleId = param(req, "scheduleId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      assertTenantExists(tenantId);
      const existing = store.getTenantSchedule(tenantId, scheduleId);
      if (!existing) {
        res.status(404).json({ error: "Schedule not found" });
        return;
      }
      store.deleteTenantSchedule(scheduleId);
      void schedulerService?.refreshTenant(tenantId);
      res.status(204).send();
    } catch (error) {
      const message = (error as Error).message;
      res.status(message === "Tenant not found" ? 404 : 500).json({ error: message });
    }
  });

  router.post("/tenants/:tenantId/schedules/:scheduleId/test", async (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      const scheduleId = param(req, "scheduleId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      assertTenantExists(tenantId);
      const schedule = store.getTenantSchedule(tenantId, scheduleId);
      if (!schedule) {
        res.status(404).json({ error: "Schedule not found" });
        return;
      }
      if (!schedulerService) {
        res.status(503).json({ error: "Scheduler service unavailable" });
        return;
      }

      void schedulerService.runNow(tenantId, scheduleId);
      store.appendAdminBotEvent({
        botName: "scheduler",
        level: "info",
        eventType: "schedule.test_triggered",
        message: "Schedule test run requested",
        metadata: { tenantId, scheduleId }
      });
      res.json({ status: "queued" });
    } catch (error) {
      const message = (error as Error).message;
      res.status(message === "Tenant not found" ? 404 : 500).json({ error: message });
    }
  });

  router.get("/scheduler/events", (req: Request, res: Response) => {
    try {
      const auth = adminAuthFromRequest(req);
      const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 100;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
      const tenantFilter =
        auth.role === "tenant_admin"
          ? auth.scopedTenantId ?? null
          : typeof req.query.tenantId === "string"
            ? req.query.tenantId
            : null;
      const events = store
        .listAdminBotEvents("scheduler", limit)
        .filter((event) => !tenantFilter || event.metadata?.tenantId === tenantFilter);
      res.json(events);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  const maxKeySize = 64 * 1024;
  const uploadP8 = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxKeySize },
    fileFilter(_req, file, cb) {
      if (path.extname(file.originalname || "").toLowerCase() !== ".p8") {
        cb(new Error("Only .p8 files are allowed"));
        return;
      }
      cb(null, true);
    }
  });

  const uploadJson = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxKeySize },
    fileFilter(_req, file, cb) {
      if (path.extname(file.originalname || "").toLowerCase() !== ".json") {
        cb(new Error("Only .json files are allowed"));
        return;
      }
      cb(null, true);
    }
  });

  router.post(
    "/tenants/:tenantId/key-upload",
    (req: Request, res: Response, next: NextFunction) => {
      uploadP8.single("file")(req, res, (error: unknown) => {
        if (error) {
          const message = error instanceof Error ? error.message : "Upload failed";
          res.status(400).json({ error: message });
          return;
        }
        next();
      });
    },
    (req: Request, res: Response) => {
      try {
        const tenantId = param(req, "tenantId");
        if (denyUnlessTenantAccess(req, res, tenantId)) {
          return;
        }
        const repo = store.getTenantRepo(tenantId);
        if (!repo) {
          res.status(404).json({ error: "Tenant not found" });
          return;
        }
        const file = req.file;
        if (!file?.buffer) {
          res.status(400).json({ error: "No file uploaded. Use form field 'file' with a .p8 file." });
          return;
        }
        const keysDir = path.join(appDataDir, "keys", tenantId);
        fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
        const filePath = path.join(keysDir, `snowflake_key_${Date.now()}.p8`);
        fs.writeFileSync(filePath, file.buffer, { mode: 0o600 });
        const fingerprint = crypto.createHash("sha256").update(file.buffer).digest("hex").slice(0, 16);
        const uploadedAt = new Date().toISOString();
        const existing = store.getTenantKeyMetadata(tenantId);
        if (existing?.filePath && existing.filePath !== filePath && fs.existsSync(existing.filePath)) {
          try {
            fs.unlinkSync(existing.filePath);
          } catch {
            // ignore cleanup errors
          }
        }
        store.upsertTenantKeyMetadata({ tenantId, filePath, uploadedAt, fingerprint });
        const warehouseConfig = store.getTenantWarehouseConfig(tenantId);
        if (warehouseConfig?.provider === "snowflake" && warehouseConfig.snowflake) {
          store.upsertTenantWarehouseConfig({
            ...warehouseConfig,
            snowflake: {
              ...warehouseConfig.snowflake,
              authType: "keypair",
              privateKeyPath: filePath
            }
          });
        }
        res.status(201).json({
          tenantId,
          filePath,
          uploadedAt,
          fingerprint,
          message: "Key uploaded. Warehouse config updated to use keypair auth."
        });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  router.post(
    "/tenants/:tenantId/bq-key-upload",
    (req: Request, res: Response, next: NextFunction) => {
      uploadJson.single("file")(req, res, (error: unknown) => {
        if (error) {
          const message = error instanceof Error ? error.message : "Upload failed";
          res.status(400).json({ error: message });
          return;
        }
        next();
      });
    },
    (req: Request, res: Response) => {
      try {
        const tenantId = param(req, "tenantId");
        if (denyUnlessTenantAccess(req, res, tenantId)) {
          return;
        }
        const repo = store.getTenantRepo(tenantId);
        if (!repo) {
          res.status(404).json({ error: "Tenant not found" });
          return;
        }
        const file = req.file;
        if (!file?.buffer) {
          res.status(400).json({ error: "No file uploaded. Use form field 'file' with a .json service account key file." });
          return;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(file.buffer.toString("utf-8")) as Record<string, unknown>;
        } catch {
          res.status(400).json({ error: "File is not valid JSON." });
          return;
        }
        if (parsed.type !== "service_account") {
          res.status(400).json({ error: "JSON file must be a Google Cloud service account key (type: \"service_account\")." });
          return;
        }
        const keysDir = path.join(appDataDir, "keys", tenantId);
        fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
        const filePath = path.join(keysDir, `bigquery_sa_${Date.now()}.json`);
        fs.writeFileSync(filePath, file.buffer, { mode: 0o600 });
        const fingerprint = crypto.createHash("sha256").update(file.buffer).digest("hex").slice(0, 16);
        const uploadedAt = new Date().toISOString();
        const existing = store.getTenantKeyMetadata(tenantId);
        if (existing?.filePath && existing.filePath !== filePath && fs.existsSync(existing.filePath)) {
          try {
            fs.unlinkSync(existing.filePath);
          } catch {
            // ignore cleanup errors
          }
        }
        store.upsertTenantKeyMetadata({ tenantId, filePath, uploadedAt, fingerprint });
        const warehouseConfig = store.getTenantWarehouseConfig(tenantId);
        if (warehouseConfig?.provider === "bigquery" && warehouseConfig.bigquery) {
          store.upsertTenantWarehouseConfig({
            ...warehouseConfig,
            bigquery: {
              ...warehouseConfig.bigquery,
              authType: "service-account-key",
              serviceAccountKeyPath: filePath
            }
          });
        }
        res.status(201).json({
          tenantId,
          filePath,
          uploadedAt,
          fingerprint,
          clientEmail: typeof parsed.client_email === "string" ? parsed.client_email : undefined,
          message: "BigQuery service account key uploaded. Warehouse config updated."
        });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  router.post("/tenants/:tenantId/repo-refresh", async (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({ status: "failed", error: "Tenant not found", refreshedAt: null });
        return;
      }
      await dbtRepo.syncRepo(tenantId);
      const models = await dbtRepo.listModels(tenantId);
      res.json({
        status: "success",
        message: `Repo refreshed. ${models.length} dbt models found.`,
        refreshedAt: new Date().toISOString(),
        modelCount: models.length
      });
    } catch (error) {
      res.status(500).json({
        status: "failed",
        error: (error as Error).message,
        refreshedAt: null,
        hint: "Ensure the deploy key was added to the GitHub repo as a Deploy Key (read-only)."
      });
    }
  });

  router.get("/slack-mappings", (req: Request, res: Response) => {
    try {
      const auth = adminAuthFromRequest(req);
      res.json(filterSlackMappingsForAuth(auth));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.put("/slack-mappings/channels/:channelId", (req: Request, res: Response) => {
    try {
      const channelId = param(req, "channelId");
      const { tenantId } = req.body as { tenantId?: string };
      if (!tenantId) {
        res.status(400).json({ error: "tenantId required" });
        return;
      }
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(400).json({ error: "Tenant not found" });
        return;
      }
      store.upsertSlackChannelTenant(channelId, tenantId, "manual");
      res.json({ channelId, tenantId, source: "manual" });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.delete("/slack-mappings/channels/:channelId", (req: Request, res: Response) => {
    try {
      const channelId = param(req, "channelId");
      const existing = store.listSlackChannelMappings().find((c) => c.channelId === channelId);
      if (existing && denyUnlessTenantAccess(req, res, existing.tenantId)) {
        return;
      }
      store.deleteSlackChannelMapping(channelId);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.put("/slack-mappings/users/:userId", (req: Request, res: Response) => {
    try {
      const userId = param(req, "userId");
      const { tenantId } = req.body as { tenantId?: string };
      if (!tenantId) {
        res.status(400).json({ error: "tenantId required" });
        return;
      }
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(400).json({ error: "Tenant not found" });
        return;
      }
      store.upsertSlackUserTenant(userId, tenantId);
      res.json({ userId, tenantId });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.delete("/slack-mappings/users/:userId", (req: Request, res: Response) => {
    try {
      const userId = param(req, "userId");
      const existing = store.listSlackUserMappings().find((u) => u.userId === userId);
      if (existing && denyUnlessTenantAccess(req, res, existing.tenantId)) {
        return;
      }
      store.deleteSlackUserMapping(userId);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.put("/slack-mappings/shared-teams/:teamId", (req: Request, res: Response) => {
    try {
      const teamId = param(req, "teamId");
      const { tenantId } = req.body as { tenantId?: string };
      if (!tenantId) {
        res.status(400).json({ error: "tenantId required" });
        return;
      }
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(400).json({ error: "Tenant not found" });
        return;
      }
      store.upsertSlackSharedTeamTenant(teamId, tenantId);
      res.json({ sharedTeamId: teamId, tenantId });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.delete("/slack-mappings/shared-teams/:teamId", (req: Request, res: Response) => {
    try {
      const teamId = param(req, "teamId");
      const existing = store.listSlackSharedTeamMappings().find((s) => s.sharedTeamId === teamId);
      if (existing && denyUnlessTenantAccess(req, res, existing.tenantId)) {
        return;
      }
      store.deleteSlackSharedTeamMapping(teamId);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/guardrails", (req: Request, res: Response) => {
    try {
      if (denyUnlessSuperadmin(req, res)) {
        return;
      }
      res.json(
        store.getGuardrails() ?? {
          ownerTeamIds: [],
          ownerEnterpriseIds: [],
          strictTenantRouting: false,
          teamTenantMap: {}
        }
      );
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.patch("/guardrails", (req: Request, res: Response) => {
    try {
      if (denyUnlessSuperadmin(req, res)) {
        return;
      }
      const body = req.body as Partial<AdminGuardrails>;
      const current = store.getGuardrails();
      const merged: AdminGuardrails = {
        defaultTenantId: body.defaultTenantId ?? current?.defaultTenantId,
        ownerTeamIds: body.ownerTeamIds ?? current?.ownerTeamIds ?? [],
        ownerEnterpriseIds: body.ownerEnterpriseIds ?? current?.ownerEnterpriseIds ?? [],
        strictTenantRouting: body.strictTenantRouting ?? current?.strictTenantRouting ?? false,
        teamTenantMap: body.teamTenantMap ?? current?.teamTenantMap ?? {}
      };
      if (merged.defaultTenantId && !store.getTenantRepo(merged.defaultTenantId)) {
        res.status(400).json({ error: "Default tenant does not exist. Create the tenant first." });
        return;
      }
      for (const tenantId of Object.values(merged.teamTenantMap ?? {})) {
        if (!store.getTenantRepo(tenantId)) {
          res.status(400).json({ error: `Tenant "${tenantId}" in team map does not exist.` });
          return;
        }
      }
      store.upsertGuardrails(merged);
      res.json(merged);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/credentials-ref/:tenantId", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const ref = store.getTenantCredentialsRef(tenantId);
      const keyMeta = store.getTenantKeyMetadata(tenantId);
      res.json({
        tenantId,
        deployKeyPath: ref?.deployKeyPath ?? repo.deployKeyPath,
        warehouseMetadata: ref?.warehouseMetadata ?? {},
        snowflakeKeyPath: keyMeta?.filePath ?? null,
        snowflakeKeyUploadedAt: keyMeta?.uploadedAt ?? null
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.patch("/credentials-ref/:tenantId", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const { deployKeyPath, warehouseMetadata } = req.body as Partial<TenantCredentialsRef>;
      const current = store.getTenantCredentialsRef(tenantId);
      const merged: TenantCredentialsRef = {
        tenantId,
        deployKeyPath: deployKeyPath ?? current?.deployKeyPath ?? repo.deployKeyPath,
        warehouseMetadata: warehouseMetadata ?? current?.warehouseMetadata ?? {}
      };
      store.upsertTenantCredentialsRef(merged);
      res.json(merged);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/tenants/:tenantId/warehouse", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const config = store.getTenantWarehouseConfig(tenantId);
      if (!config) {
        res.json({ tenantId, provider: null });
        return;
      }
      const sanitized: Record<string, unknown> = {
        tenantId: config.tenantId,
        provider: config.provider,
        updatedAt: config.updatedAt
      };
      if (config.provider === "snowflake" && config.snowflake) {
        sanitized.snowflake = {
          account: config.snowflake.account,
          username: config.snowflake.username,
          warehouse: config.snowflake.warehouse,
          database: config.snowflake.database,
          schema: config.snowflake.schema,
          role: config.snowflake.role,
          authType: config.snowflake.authType
        };
      }
      if (config.provider === "bigquery" && config.bigquery) {
        sanitized.bigquery = {
          projectId: config.bigquery.projectId,
          dataset: config.bigquery.dataset,
          location: config.bigquery.location,
          authType: config.bigquery.authType ?? "adc"
        };
      }
      res.json(sanitized);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/telegram-mappings", (req: Request, res: Response) => {
    try {
      const auth = adminAuthFromRequest(req);
      const all = store.listTelegramChatMappings();
      if (auth.role === "superadmin") {
        res.json(all);
        return;
      }
      const tid = auth.scopedTenantId;
      if (!tid) {
        res.json([]);
        return;
      }
      res.json(all.filter((m) => m.tenantId === tid));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.put("/telegram-mappings/:chatId", (req: Request, res: Response) => {
    try {
      const chatId = param(req, "chatId");
      const { tenantId } = req.body as { tenantId?: string };
      if (!tenantId) {
        res.status(400).json({ error: "tenantId required" });
        return;
      }
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(400).json({ error: "Tenant not found" });
        return;
      }
      store.upsertTelegramChatTenant(chatId, tenantId, "manual");
      res.json({ chatId, tenantId, source: "manual" });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.delete("/telegram-mappings/:chatId", (req: Request, res: Response) => {
    try {
      const chatId = param(req, "chatId");
      const existing = store.listTelegramChatMappings().find((m) => m.chatId === chatId);
      if (existing && denyUnlessTenantAccess(req, res, existing.tenantId)) {
        return;
      }
      store.deleteTelegramChatMapping(chatId);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/conversations", (req: Request, res: Response) => {
    try {
      const auth = adminAuthFromRequest(req);
      let tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : undefined;
      if (auth.role === "tenant_admin" && auth.scopedTenantId) {
        tenantId = auth.scopedTenantId;
      }
      const source = typeof req.query.source === "string" ? req.query.source : undefined;
      const search = typeof req.query.search === "string" ? req.query.search : undefined;
      const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 100;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
      res.json(
        store.listAdminConversations({
          tenantId,
          source: source as "cli" | "slack" | "telegram" | "admin" | undefined,
          search,
          limit
        })
      );
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/conversations/:conversationId", (req: Request, res: Response) => {
    try {
      const detail = store.getAdminConversationDetail(param(req, "conversationId"));
      if (!detail) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      if (denyUnlessTenantAccess(req, res, detail.summary.tenantId)) {
        return;
      }
      res.json(detail);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/execution-turns/:turnId", (req: Request, res: Response) => {
    try {
      const turn = store.getExecutionTurn(param(req, "turnId"));
      if (!turn) {
        res.status(404).json({ error: "Execution turn not found" });
        return;
      }
      if (denyUnlessTenantAccess(req, res, turn.tenantId)) {
        return;
      }
      res.json(turn);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post("/wizard/tenant/init", (req: Request, res: Response) => {
    try {
      if (denyUnlessSuperadmin(req, res)) {
        return;
      }
      const { tenantId, repoUrl, dbtSubpath = "models", warehouseProvider = "snowflake" } = req.body as {
        tenantId?: string;
        repoUrl?: string;
        dbtSubpath?: string;
        warehouseProvider?: string;
      };
      if (!tenantId || !repoUrl) {
        res.status(400).json({ status: "failed", error: "tenantId and repoUrl required", step: "init" });
        return;
      }
      const result = initializeTenant({ appDataDir, tenantId, repoUrl, dbtSubpath, force: false }, store);
      res.status(201).json({
        status: "passed",
        step: "init",
        tenantId,
        repoUrl,
        dbtSubpath,
        warehouseProvider,
        localRepoPath: result.localRepoPath,
        publicKey: result.publicKey,
        message: "Tenant initialized. Add the public key as a GitHub Deploy Key (read-only), then verify repo access."
      });
    } catch (error) {
      res.status(500).json({ status: "failed", step: "init", error: (error as Error).message });
    }
  });

  router.post("/wizard/tenant/:tenantId/repo-verify", async (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(404).json({
          status: "failed",
          step: "repo_verify",
          error: "Tenant not found. Run init first."
        });
        return;
      }
      await dbtRepo.syncRepo(tenantId);
      const models = await dbtRepo.listModels(tenantId);
      res.json({
        status: "passed",
        step: "repo_verify",
        modelCount: models.length,
        message: `Repo synced successfully. ${models.length} dbt models found.`
      });
    } catch (error) {
      res.status(500).json({
        status: "failed",
        step: "repo_verify",
        error: (error as Error).message,
        hint: "Ensure the deploy key was added to the GitHub repo as a Deploy Key (read-only)."
      });
    }
  });

  router.get("/wizard/tenant/:tenantId/state", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const warehouseConfig = store.getTenantWarehouseConfig(tenantId);
      const channels = store.listSlackChannelMappings().filter((entry) => entry.tenantId === tenantId);
      const users = store.listSlackUserMappings().filter((entry) => entry.tenantId === tenantId);
      const sharedTeams = store.listSlackSharedTeamMappings().filter((entry) => entry.tenantId === tenantId);
      const botFlags = channelBotPublicFlags(tenantId);
      res.json({
        tenantId,
        hasRepo: true,
        hasWarehouseConfig: !!warehouseConfig,
        warehouseProvider: warehouseConfig?.provider,
        slackChannelCount: channels.length,
        slackUserCount: users.length,
        slackSharedTeamCount: sharedTeams.length,
        hasSlackBotOverride: botFlags.hasSlackBotOverride,
        hasTelegramBotOverride: botFlags.hasTelegramBotOverride,
        slackEventsPathSuffix: `/slack/events/tenants/${encodeURIComponent(tenantId)}`
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.put("/wizard/tenant/:tenantId/warehouse", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(404).json({ status: "failed", step: "warehouse", error: "Tenant not found. Run init first." });
        return;
      }
      const body = req.body as {
        provider?: TenantWarehouseProvider;
        snowflake?: TenantSnowflakeConfig;
        bigquery?: TenantBigQueryConfig;
      };
      const existing = store.getTenantWarehouseConfig(tenantId);

      const provider = body.provider ?? "snowflake";
      let snowflake = body.snowflake;
      let bigquery = body.bigquery;

      // GET /tenants/:id/warehouse strips paths for the admin UI; merge stored paths so edits (e.g. role) persist.
      if (provider === "snowflake" && snowflake && existing?.provider === "snowflake" && existing.snowflake) {
        const prev = existing.snowflake;
        if (snowflake.authType === "keypair" && !snowflake.privateKeyPath && prev.privateKeyPath) {
          snowflake = { ...snowflake, privateKeyPath: prev.privateKeyPath };
        }
        if (snowflake.authType === "password" && !snowflake.passwordEnvVar && prev.passwordEnvVar) {
          snowflake = { ...snowflake, passwordEnvVar: prev.passwordEnvVar };
        }
      }

      if (provider === "bigquery" && bigquery && existing?.provider === "bigquery" && existing.bigquery) {
        const prev = existing.bigquery;
        if (
          bigquery.authType === "service-account-key" &&
          !bigquery.serviceAccountKeyPath &&
          prev.serviceAccountKeyPath
        ) {
          bigquery = { ...bigquery, serviceAccountKeyPath: prev.serviceAccountKeyPath };
        }
      }

      if (provider === "snowflake") {
        if (
          !snowflake?.account ||
          !snowflake.username ||
          !snowflake.warehouse ||
          !snowflake.database ||
          !snowflake.schema
        ) {
          res.status(400).json({
            status: "failed",
            step: "warehouse",
            error: "Snowflake config requires account, username, warehouse, database, schema."
          });
          return;
        }
        if (snowflake.authType === "keypair" && !snowflake.privateKeyPath) {
          res.status(400).json({
            status: "failed",
            step: "warehouse",
            error: "privateKeyPath required for keypair auth."
          });
          return;
        }
        if (snowflake.authType === "password" && !snowflake.passwordEnvVar) {
          snowflake.passwordEnvVar = "SNOWFLAKE_PASSWORD";
        }
      }
      if (provider === "bigquery") {
        if (!bigquery?.projectId) {
          res.status(400).json({
            status: "failed",
            step: "warehouse",
            error: "BigQuery config requires projectId."
          });
          return;
        }
        if (bigquery.authType === "service-account-key" && !bigquery.serviceAccountKeyPath) {
          res.status(400).json({
            status: "failed",
            step: "warehouse",
            error: "serviceAccountKeyPath required for service-account-key auth. Upload a key file first."
          });
          return;
        }
      }
      store.upsertTenantWarehouseConfig({
        tenantId,
        provider,
        snowflake,
        bigquery
      });
      res.json({
        status: "passed",
        step: "warehouse",
        message: "Warehouse config saved. Run warehouse test to verify connectivity."
      });
    } catch (error) {
      res.status(500).json({ status: "failed", step: "warehouse", error: (error as Error).message });
    }
  });

  router.post("/wizard/tenant/:tenantId/warehouse-test", async (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      const config = store.getTenantWarehouseConfig(tenantId);
      if (!config) {
        res.status(404).json({
          status: "failed",
          step: "warehouse_test",
          error: "Warehouse config not found. Save warehouse config first."
        });
        return;
      }
      const warehouse = buildWarehouseFromTenantConfig(config);
      const testQuery = config.provider === "bigquery"
        ? "SELECT 1 AS test"
        : "SELECT CURRENT_ACCOUNT() AS account, CURRENT_ROLE() AS role, CURRENT_DATABASE() AS database_name, CURRENT_SCHEMA() AS schema_name LIMIT 1";
      const result = await warehouse.query(testQuery);
      res.json({
        status: "passed",
        step: "warehouse_test",
        rowCount: result.rowCount,
        sample: result.rows[0],
        message: "Warehouse connectivity verified."
      });
    } catch (error) {
      res.status(500).json({
        status: "failed",
        step: "warehouse_test",
        error: (error as Error).message,
        hint: "For Snowflake keypair: ensure privateKeyPath is correct. For password: set the passwordEnvVar in env. For BigQuery SA key: ensure the key file exists and has correct permissions."
      });
    }
  });

  router.put("/wizard/tenant/:tenantId/slack-mappings", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(404).json({
          status: "failed",
          step: "slack_mappings",
          error: "Tenant not found. Run init first."
        });
        return;
      }
      const body = req.body as {
        channels?: Array<{ channelId: string }>;
        users?: Array<{ userId: string }>;
        sharedTeams?: Array<{ sharedTeamId: string }>;
      };
      const channels = body.channels ?? [];
      const users = body.users ?? [];
      const sharedTeams = body.sharedTeams ?? [];
      for (const { channelId } of channels) {
        if (channelId) {
          store.upsertSlackChannelTenant(channelId, tenantId, "wizard");
        }
      }
      for (const { userId } of users) {
        if (userId) {
          store.upsertSlackUserTenant(userId, tenantId);
        }
      }
      for (const { sharedTeamId } of sharedTeams) {
        if (sharedTeamId) {
          store.upsertSlackSharedTeamTenant(sharedTeamId, tenantId);
        }
      }
      res.json({
        status: "passed",
        step: "slack_mappings",
        channelsAdded: channels.length,
        usersAdded: users.length,
        sharedTeamsAdded: sharedTeams.length,
        message: "Slack mappings saved."
      });
    } catch (error) {
      res.status(500).json({ status: "failed", step: "slack_mappings", error: (error as Error).message });
    }
  });

  router.post("/wizard/tenant/:tenantId/final-validate", async (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (denyUnlessTenantAccess(req, res, tenantId)) {
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(404).json({ ready: false, error: "Tenant not found.", checks: [] });
        return;
      }
      const warehouseConfig = store.getTenantWarehouseConfig(tenantId);
      const channels = store.listSlackChannelMappings().filter((entry) => entry.tenantId === tenantId);
      const users = store.listSlackUserMappings().filter((entry) => entry.tenantId === tenantId);
      const sharedTeams = store.listSlackSharedTeamMappings().filter((entry) => entry.tenantId === tenantId);
      const hasSlackMapping = channels.length > 0 || users.length > 0 || sharedTeams.length > 0;

      const checks: Array<{ name: string; passed: boolean; message?: string }> = [];
      let repoOk = false;
      let warehouseOk = false;

      try {
        await dbtRepo.syncRepo(tenantId);
        const models = await dbtRepo.listModels(tenantId);
        repoOk = true;
        checks.push({ name: "repo_sync", passed: true, message: `${models.length} models` });
      } catch (error) {
        checks.push({ name: "repo_sync", passed: false, message: (error as Error).message });
      }

      if (warehouseConfig) {
        try {
          const warehouse = buildWarehouseFromTenantConfig(warehouseConfig);
          const testQuery = warehouseConfig.provider === "bigquery"
            ? "SELECT 1 AS ok"
            : "SELECT 1 AS ok LIMIT 1";
          await warehouse.query(testQuery);
          warehouseOk = true;
          checks.push({ name: "warehouse_connect", passed: true });
        } catch (error) {
          checks.push({ name: "warehouse_connect", passed: false, message: (error as Error).message });
        }
      } else {
        checks.push({
          name: "warehouse_connect",
          passed: false,
          message: "Warehouse config missing."
        });
      }

      checks.push({
        name: "slack_mapping",
        passed: hasSlackMapping,
        message: hasSlackMapping
          ? `${channels.length} channels, ${users.length} users, ${sharedTeams.length} shared teams`
          : "No Slack mappings. Add at least one channel, user, or shared-team mapping."
      });

      const ready = repoOk && warehouseOk && hasSlackMapping;
      res.json({
        ready,
        checks,
        launchCommand: ready ? "npm run dev -- slack --profile default --port 3000" : undefined,
        message: ready
          ? "Tenant is ready. Start the Slack server with the command above."
          : "Resolve failed checks before go-live."
      });
    } catch (error) {
      res.status(500).json({ ready: false, error: (error as Error).message, checks: [] });
    }
  });

  return router;
}
