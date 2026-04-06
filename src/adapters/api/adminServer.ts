import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { NextFunction, Request, Response } from "express";
import { fileURLToPath } from "node:url";
import { buildRuntime } from "../../app.js";
import type { ConversationStore } from "../../core/interfaces.js";
import { env } from "../../config/env.js";
import { SqliteConversationStore } from "../store/sqliteConversationStore.js";
import {
  createSessionId,
  createSignedSessionCookie,
  parseCookieHeader,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  verifyAdminPassword,
  verifySignedSessionCookie
} from "./admin/adminAuth.js";
import { createAdminApiRouter } from "./admin/adminApiRouter.js";
import { SlackBotSupervisor } from "./admin/slackBotSupervisor.js";
import { TelegramBotSupervisor } from "./admin/telegramBotSupervisor.js";
import { SchedulerService } from "./scheduler/schedulerService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminSessionCookieName = "agent_blue_admin_session";
const randomFallbackSecret = crypto.randomBytes(32).toString("base64url");

export interface AdminServerOptions {
  store: ConversationStore;
  port: number;
  appDataDir: string;
}

type AdminAuthMethod = "session" | "basic" | "bearer";

interface AdminRequestAuth {
  method: AdminAuthMethod;
  username: string;
}

function requestWithAdminAuth(req: Request): Request & { adminAuth?: AdminRequestAuth } {
  return req as Request & { adminAuth?: AdminRequestAuth };
}

function getSessionSecret(): string {
  return env.adminSessionSecret || env.adminPasswordHash || env.adminBasicPassword || randomFallbackSecret;
}

function getSessionTtlSeconds(): number {
  const hours = Number.isFinite(env.adminSessionTtlHours) && env.adminSessionTtlHours > 0 ? env.adminSessionTtlHours : 12;
  return Math.max(1, Math.floor(hours)) * 60 * 60;
}

function isSecureRequest(req: Request): boolean {
  if (req.secure) {
    return true;
  }
  const forwardedProto = req.get("x-forwarded-proto");
  return typeof forwardedProto === "string" && forwardedProto.toLowerCase().split(",")[0]?.trim() === "https";
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyLoginCredentials(username: string, password: string): boolean {
  if (env.adminPasswordHash) {
    if (!timingSafeStringEqual(username, env.adminUsername)) {
      return false;
    }
    return verifyAdminPassword(password, env.adminPasswordHash);
  }
  if (env.adminBasicPassword) {
    return timingSafeStringEqual(username, env.adminBasicUser) && timingSafeStringEqual(password, env.adminBasicPassword);
  }
  return false;
}

function readAuthenticatedSession(req: Request, store: ConversationStore): AdminRequestAuth | null {
  const cookies = parseCookieHeader(req.headers.cookie);
  const sessionId = verifySignedSessionCookie(cookies[adminSessionCookieName], getSessionSecret());
  if (!sessionId) {
    return null;
  }

  const session = store.getAdminSession(sessionId);
  if (!session) {
    return null;
  }
  const nowIso = new Date().toISOString();
  if (session.expiresAt <= nowIso) {
    store.deleteAdminSession(sessionId);
    return null;
  }

  const extendedExpiryIso = new Date(Date.now() + getSessionTtlSeconds() * 1000).toISOString();
  store.touchAdminSession(sessionId, nowIso, extendedExpiryIso);
  return {
    method: "session",
    username: session.username
  };
}

function readAuthenticatedHeader(req: Request): AdminRequestAuth | null {
  const authHeader = req.headers.authorization;
  const bearerToken = env.adminUiToken || env.adminBearerToken;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (bearerToken && timingSafeStringEqual(token, bearerToken)) {
      return {
        method: "bearer",
        username: env.adminUsername
      };
    }
  }

  if (authHeader?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      const username = separator === -1 ? decoded : decoded.slice(0, separator);
      const password = separator === -1 ? "" : decoded.slice(separator + 1);
      if (
        env.adminBasicPassword &&
        timingSafeStringEqual(username, env.adminBasicUser) &&
        timingSafeStringEqual(password, env.adminBasicPassword)
      ) {
        return {
          method: "basic",
          username
        };
      }
    } catch {
      return null;
    }
  }

  return null;
}

function getAuthenticatedAdmin(req: Request, store: ConversationStore): AdminRequestAuth | null {
  store.deleteExpiredAdminSessions();
  return readAuthenticatedSession(req, store) ?? readAuthenticatedHeader(req);
}

function enforceSameOriginForSession(req: Request): boolean {
  const origin = req.get("origin");
  const referer = req.get("referer");
  const forwardedHost = req.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const requestOrigin = `${forwardedProto ?? (isSecureRequest(req) ? "https" : req.protocol)}://${forwardedHost ?? req.get("host")}`;
  let requestUrl: URL | null = null;
  try {
    requestUrl = new URL(requestOrigin);
  } catch {
    requestUrl = null;
  }

  const matchesAllowedOrigin = (value: string): boolean => {
    try {
      const candidateUrl = new URL(value);
      if (candidateUrl.origin === requestOrigin) {
        return true;
      }
      return Boolean(
        requestUrl &&
          isLoopbackHostname(candidateUrl.hostname) &&
          isLoopbackHostname(requestUrl.hostname) &&
          candidateUrl.protocol === requestUrl.protocol
      );
    } catch {
      return false;
    }
  };

  if (origin) {
    return matchesAllowedOrigin(origin);
  }
  if (referer) {
    return matchesAllowedOrigin(referer);
  }
  return false;
}

function clearSessionCookie(res: Response, secure: boolean): void {
  res.setHeader("Set-Cookie", serializeClearedSessionCookie(adminSessionCookieName, secure));
}

function requireAdminAuth(store: ConversationStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const adminAuth = getAuthenticatedAdmin(req, store);
    if (!adminAuth) {
      if (env.adminBasicPassword) {
        res.setHeader("WWW-Authenticate", 'Basic realm="Agent Blue Admin"');
      }
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (
      adminAuth.method === "session" &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase()) &&
      !enforceSameOriginForSession(req)
    ) {
      res.status(403).json({ error: "Cross-site session request rejected" });
      return;
    }

    requestWithAdminAuth(req).adminAuth = adminAuth;
    next();
  };
}

function resolveAdminUiPaths(): { staticDir: string; indexFile: string } {
  const rootDir = path.join(__dirname, "..", "..", "..", "admin-ui");
  const distDir = path.join(rootDir, "dist");
  const distIndex = path.join(distDir, "index.html");
  if (fs.existsSync(distIndex)) {
    return {
      staticDir: distDir,
      indexFile: distIndex
    };
  }
  return {
    staticDir: rootDir,
    indexFile: path.join(rootDir, "index.html")
  };
}

export function startAdminServer(options: AdminServerOptions): void {
  const { store, port, appDataDir } = options;
  const app = express();
  const sessionTtlSeconds = getSessionTtlSeconds();
  const loginEnabled = Boolean(env.adminPasswordHash || env.adminBasicPassword);
  const authMiddleware = requireAdminAuth(store);
  const slackBotSupervisor = new SlackBotSupervisor({
    store,
    createRuntime: () => buildRuntime(store as SqliteConversationStore)
  });
  const telegramBotSupervisor = new TelegramBotSupervisor({
    store,
    createRuntime: () => buildRuntime(store as SqliteConversationStore)
  });
  const schedulerService = new SchedulerService({
    store,
    createRuntime: () => buildRuntime(store as SqliteConversationStore),
    slackBotToken: env.slackBotToken,
    telegramBotToken: env.telegramBotToken,
    llmModel: env.llmModel,
    timezone: "UTC",
    refreshIntervalMs: 60_000
  });
  schedulerService.start();

  app.set("trust proxy", 1);
  app.use(express.json());

  app.post("/api/admin/auth/login", (req: Request, res: Response) => {
    if (!loginEnabled) {
      res.status(503).json({
        error: "Admin login is not configured. Set ADMIN_PASSWORD_HASH or ADMIN_BASIC_PASSWORD."
      });
      return;
    }

    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      res.status(400).json({ error: "username and password are required" });
      return;
    }

    if (!verifyLoginCredentials(username, password)) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const sessionId = createSessionId();
    const signedCookie = createSignedSessionCookie(sessionId, getSessionSecret());
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + sessionTtlSeconds * 1000).toISOString();
    store.createAdminSession({
      sessionId,
      username,
      createdAt: nowIso,
      lastSeenAt: nowIso,
      expiresAt,
      userAgent: req.get("user-agent") ?? undefined,
      ipAddress: req.ip || undefined
    });
    res.setHeader(
      "Set-Cookie",
      serializeSessionCookie(adminSessionCookieName, signedCookie, {
        maxAgeSeconds: sessionTtlSeconds,
        sameSite: "Strict",
        secure: isSecureRequest(req)
      })
    );
    res.json({
      authenticated: true,
      username,
      method: "session",
      expiresAt
    });
  });

  app.get("/api/admin/auth/session", (req: Request, res: Response) => {
    const auth = getAuthenticatedAdmin(req, store);
    if (!auth) {
      res.json({ authenticated: false, loginEnabled });
      return;
    }
    res.json({
      authenticated: true,
      username: auth.username,
      method: auth.method,
      loginEnabled
    });
  });

  app.post("/api/admin/auth/logout", authMiddleware, (req: Request, res: Response) => {
    const cookies = parseCookieHeader(req.headers.cookie);
    const sessionId = verifySignedSessionCookie(cookies[adminSessionCookieName], getSessionSecret());
    if (sessionId) {
      store.deleteAdminSession(sessionId);
    }
    clearSessionCookie(res, isSecureRequest(req));
    res.status(204).send();
  });

  app.use(
    "/api/admin",
    authMiddleware,
    createAdminApiRouter({ store, appDataDir, slackBotSupervisor, telegramBotSupervisor, schedulerService })
  );

  const { staticDir, indexFile } = resolveAdminUiPaths();
  app.use(
    "/admin",
    express.static(staticDir, {
      index: false,
      redirect: false
    })
  );
  app.get(/^\/admin(?:\/.*)?$/, (_req: Request, res: Response) => {
    res.sendFile(indexFile);
  });

  app.listen(port, () => {
    console.log(`Admin server listening on http://localhost:${port}`);
    console.log(`Admin UI serving from ${staticDir}`);
    if (!env.adminSessionSecret) {
      console.warn("ADMIN_SESSION_SECRET is not set. Using a process-local fallback secret.");
    }
    if (env.adminPasswordHash) {
      console.log(`Admin login enabled for username "${env.adminUsername}" via hashed password.`);
    } else if (env.adminBasicPassword) {
      console.warn("Admin login is using ADMIN_BASIC_PASSWORD fallback. Prefer ADMIN_PASSWORD_HASH.");
    } else {
      console.warn("Admin login is disabled. Configure ADMIN_PASSWORD_HASH or ADMIN_BASIC_PASSWORD.");
    }
    if (env.adminUiToken || env.adminBearerToken) {
      console.log("Admin API bearer auth enabled for non-browser/API clients.");
    }
  });
}
