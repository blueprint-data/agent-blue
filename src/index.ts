import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execSync } from "node:child_process";
import { buildLlmProvider, buildRuntime, buildSnowflakeWarehouse, buildStore } from "./app.js";
import { initializeTenant } from "./bootstrap/initTenant.js";
import { GitDbtRepositoryService } from "./adapters/dbt/dbtRepoService.js";
import { parseSlackTeamTenantMap, startSlackAgentServer } from "./adapters/channel/slack/slackAgentServer.js";
import { startTelegramAgentServer } from "./adapters/channel/telegram/telegramAgentServer.js";
import { startAdminServer } from "./adapters/api/adminServer.js";
import { hashAdminPassword } from "./adapters/api/admin/adminAuth.js";
import { createId } from "./utils/id.js";
import { getStringArg, parseArgs } from "./utils/args.js";
import { env } from "./config/env.js";

const canUseAnsi = Boolean(output.isTTY) && process.env.NO_COLOR !== "1";

function paint(text: string, code: number): string {
  if (!canUseAnsi) {
    return text;
  }
  return `\u001b[${code}m${text}\u001b[0m`;
}

function infoLabel(label: string): string {
  return paint(label, 36);
}

function successText(text: string): string {
  return paint(text, 32);
}

function errorText(text: string): string {
  return paint(text, 31);
}

function warnText(text: string): string {
  return paint(text, 33);
}

function printVerboseDebug(debug: Record<string, unknown> | undefined): void {
  if (!debug) {
    output.write(`${infoLabel("[debug]")} no debug payload\n`);
    return;
  }

  const plan = debug.plan as Record<string, unknown> | undefined;
  if (plan?.action) {
    output.write(`${infoLabel("[debug]")} planner.action=${String(plan.action)}\n`);
  }
  const plannerAttempts = debug.plannerAttempts as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(plannerAttempts) && plannerAttempts.length > 0) {
    output.write(`${infoLabel("[debug]")} planner.attempts=${plannerAttempts.length}\n`);
  }

  const sql = debug.sql;
  if (typeof sql === "string" && sql.trim().length > 0) {
    output.write(`${infoLabel("[debug]")} sql:\n${paint(sql, 37)}\n`);
  }

  const toolCalls = debug.toolCalls as
    | Array<{
        tool?: string;
        input?: Record<string, unknown>;
        status?: string;
        durationMs?: number;
        outputSummary?: Record<string, unknown>;
        output?: unknown;
        error?: string;
      }>
    | undefined;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    output.write(`${infoLabel("[debug]")} tool calls:\n`);
    for (const call of toolCalls) {
      const status =
        call.status === "ok"
          ? successText(`status=${call.status ?? "unknown"}`)
          : call.status === "error"
            ? errorText(`status=${call.status ?? "unknown"}`)
            : warnText(`status=${call.status ?? "unknown"}`);
      output.write(
        `  - ${paint(call.tool ?? "unknown", 35)} ${status} durationMs=${call.durationMs ?? -1}\n`
      );
      if (call.input) {
        output.write(`    input=${JSON.stringify(call.input)}\n`);
      }
      if (call.outputSummary) {
        output.write(`    output=${JSON.stringify(call.outputSummary)}\n`);
      }
      if (call.output) {
        output.write(`    output_full=${JSON.stringify(call.output)}\n`);
      }
      if (call.error) {
        output.write(`    error=${call.error}\n`);
      }
    }
  }

  const timings = debug.timings as Record<string, unknown> | undefined;
  if (timings) {
    output.write(`${infoLabel("[debug]")} timings=${JSON.stringify(timings)}\n`);
  }
}

function printArtifacts(artifacts: unknown): void {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return;
  }

  const renderAsciiChart = (payload: unknown): string | null => {
    const config = payload as {
      type?: unknown;
      data?: {
        labels?: unknown;
        datasets?: unknown;
      };
    };
    const labels = Array.isArray(config.data?.labels) ? config.data?.labels : [];
    const datasets = Array.isArray(config.data?.datasets) ? config.data?.datasets : [];
    if (labels.length === 0 || datasets.length === 0) {
      return null;
    }

    const firstDataset = datasets[0] as { label?: unknown; data?: unknown };
    const points = Array.isArray(firstDataset?.data) ? firstDataset.data : [];
    if (points.length === 0) {
      return null;
    }

    const numericValues = points
      .map((value) => {
        if (typeof value === "number" && Number.isFinite(value)) {
          return value;
        }
        if (typeof value === "string" && value.trim().length > 0) {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
      })
      .filter((value): value is number => value !== null);
    if (numericValues.length === 0) {
      return null;
    }

    const maxValue = Math.max(...numericValues, 1);
    const barWidth = 24;
    const labelWidth = 18;
    const chartLabel = typeof firstDataset.label === "string" ? firstDataset.label : "Series";
    const chartType = typeof config.type === "string" ? config.type : "chart";
    const lines: string[] = [];
    lines.push(`${infoLabel("[chart]")} ${chartType} ${chartLabel}`);
    for (let i = 0; i < Math.min(labels.length, points.length); i += 1) {
      const rawLabel = labels[i] === null || labels[i] === undefined ? "(null)" : String(labels[i]);
      const valueRaw = points[i];
      const value =
        typeof valueRaw === "number"
          ? valueRaw
          : typeof valueRaw === "string"
            ? Number(valueRaw)
            : Number.NaN;
      const safeValue = Number.isFinite(value) ? value : 0;
      const blocks = Math.max(0, Math.round((safeValue / maxValue) * barWidth));
      const bar = "█".repeat(blocks).padEnd(barWidth, " ");
      const shortLabel = rawLabel.length > labelWidth ? `${rawLabel.slice(0, labelWidth - 1)}…` : rawLabel;
      lines.push(`  ${shortLabel.padEnd(labelWidth, " ")} | ${bar} ${safeValue}`);
    }
    return `${lines.join("\n")}\n`;
  };

  for (const artifactRaw of artifacts) {
    const artifact = artifactRaw as {
      type?: unknown;
      format?: unknown;
      summary?: unknown;
      payload?: unknown;
    };
    if (artifact.type !== "chartjs_config") {
      continue;
    }
    output.write(
      `${infoLabel("[artifact]")} type=chartjs_config format=${String(artifact.format ?? "unknown")} summary=${JSON.stringify(
        artifact.summary ?? {}
      )}\n`
    );
    const ascii = renderAsciiChart(artifact.payload);
    if (ascii) {
      output.write(ascii);
    }
  }
}

const DEFAULT_PROMPTS_ID = "e2e-default-v1";
const DEFAULT_BENCHMARK_PROMPTS_DIR = path.join("benchmark", "prompts");

interface BenchmarkPromptsFile {
  id?: unknown;
  questions?: unknown;
}

interface E2eTurnMetrics {
  plannerAttempts: number;
  totalMs: number | null;
  warehouseQueryOk: number;
  warehouseQueryErrors: number;
  fallback: boolean;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalCost: number;
  llmCalls: number;
}

interface BenchmarkTurnRecord {
  runIndex: number;
  questionIndex: number;
  question: string;
  conversationId: string;
  metrics: E2eTurnMetrics;
  error?: string;
}

interface BenchmarkModelSummary {
  turns: number;
  fallbackTurns: number;
  fallbackRate: number;
  avgPlannerAttempts: number;
  medianPlannerAttempts: number;
  avgTotalMs: number;
  medianTotalMs: number;
  p95TotalMs: number;
  warehouseQueryOk: number;
  warehouseQueryErrors: number;
  toolErrorRate: number;
  noWarehouseCalls: boolean;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  tokensPerTurn: number;
  totalCost: number;
  costPerTurn: number;
  totalLlmCalls: number;
}

interface BenchmarkModelResult {
  model: string;
  turns: BenchmarkTurnRecord[];
  summary: BenchmarkModelSummary;
}

interface BenchmarkRunResult {
  benchmarkVersion: "v1";
  promptsId: string;
  runMeta: {
    runId: string;
    branch?: string;
    commit?: string;
    tenantId: string;
    profileName: string;
    runs: number;
    executedAt: string;
  };
  models: BenchmarkModelResult[];
}

interface BenchmarkModelSnapshot {
  model: string;
  summary: BenchmarkModelSummary;
}

interface BenchmarkInputSnapshot {
  sourcePath: string;
  runId?: string;
  promptsId?: string;
  models: BenchmarkModelSnapshot[];
}

type ComparisonTrend = "better" | "similar" | "worse";

interface ComparisonMetricResult {
  label: string;
  baselineDisplay: string;
  candidateDisplay: string;
  deltaDisplay: string;
  trend: ComparisonTrend;
}

function asFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(Math.max(p, 0), 1) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = rank - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

function safeGitRef(command: string): string | undefined {
  try {
    const value = execSync(command, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}

function runShellCommand(parts: string[]): void {
  const command = parts.map((part) => shellQuote(part)).join(" ");
  execSync(command, { stdio: "inherit" });
}

function toFiniteOrDefault(value: string | boolean | undefined, fallback: number): number {
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function classifyDeltaPct(deltaPct: number, tolerancePct: number): ComparisonTrend {
  if (deltaPct <= -Math.abs(tolerancePct)) {
    return "better";
  }
  if (deltaPct >= Math.abs(tolerancePct)) {
    return "worse";
  }
  return "similar";
}

function classifyDeltaPp(deltaPp: number, tolerancePp: number): ComparisonTrend {
  if (deltaPp <= -Math.abs(tolerancePp)) {
    return "better";
  }
  if (deltaPp >= Math.abs(tolerancePp)) {
    return "worse";
  }
  return "similar";
}

function formatTrend(trend: ComparisonTrend): string {
  if (trend === "better") {
    return successText("better");
  }
  if (trend === "worse") {
    return errorText("worse");
  }
  return warnText("similar");
}

function formatNumber(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function formatSigned(value: number, digits = 2): string {
  const normalized = Number.isFinite(value) ? value : 0;
  const sign = normalized >= 0 ? "+" : "";
  return `${sign}${normalized.toFixed(digits)}`;
}

function parseBenchmarkSnapshot(filePathArg: string): BenchmarkInputSnapshot {
  const resolvedPath = path.isAbsolute(filePathArg) ? filePathArg : path.join(process.cwd(), filePathArg);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Benchmark file not found: ${resolvedPath}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf-8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid benchmark JSON at ${resolvedPath}: ${(error as Error).message}`);
  }

  const rawModels = Array.isArray(parsed.models) ? parsed.models : [];
  const models: BenchmarkModelSnapshot[] = [];
  for (const rawModel of rawModels) {
    const modelEntry = rawModel as Record<string, unknown>;
    const model = typeof modelEntry.model === "string" ? modelEntry.model.trim() : "";
    if (!model) {
      continue;
    }
    const summaryRaw = modelEntry.summary as Record<string, unknown> | undefined;
    const summary: BenchmarkModelSummary = {
      turns: asFiniteNumber(summaryRaw?.turns),
      fallbackTurns: asFiniteNumber(summaryRaw?.fallbackTurns),
      fallbackRate: asFiniteNumber(summaryRaw?.fallbackRate),
      avgPlannerAttempts: asFiniteNumber(summaryRaw?.avgPlannerAttempts),
      medianPlannerAttempts: asFiniteNumber(summaryRaw?.medianPlannerAttempts),
      avgTotalMs: asFiniteNumber(summaryRaw?.avgTotalMs),
      medianTotalMs: asFiniteNumber(summaryRaw?.medianTotalMs),
      p95TotalMs: asFiniteNumber(summaryRaw?.p95TotalMs),
      warehouseQueryOk: asFiniteNumber(summaryRaw?.warehouseQueryOk),
      warehouseQueryErrors: asFiniteNumber(summaryRaw?.warehouseQueryErrors),
      toolErrorRate: asFiniteNumber(summaryRaw?.toolErrorRate),
      noWarehouseCalls: Boolean(summaryRaw?.noWarehouseCalls),
      totalPromptTokens: asFiniteNumber(summaryRaw?.totalPromptTokens),
      totalCompletionTokens: asFiniteNumber(summaryRaw?.totalCompletionTokens),
      totalTokens: asFiniteNumber(summaryRaw?.totalTokens),
      tokensPerTurn: asFiniteNumber(summaryRaw?.tokensPerTurn),
      totalCost: asFiniteNumber(summaryRaw?.totalCost),
      costPerTurn: asFiniteNumber(summaryRaw?.costPerTurn),
      totalLlmCalls: asFiniteNumber(summaryRaw?.totalLlmCalls)
    };
    models.push({ model, summary });
  }

  if (models.length === 0) {
    throw new Error(`Benchmark file ${resolvedPath} has no model summaries.`);
  }

  const runMeta = parsed.runMeta as Record<string, unknown> | undefined;
  const runId = typeof runMeta?.runId === "string" ? runMeta.runId : undefined;
  const promptsId =
    typeof parsed.promptsId === "string"
      ? parsed.promptsId
      : typeof parsed.promptSetId === "string"
        ? parsed.promptSetId
        : undefined;

  return {
    sourcePath: resolvedPath,
    runId,
    promptsId,
    models
  };
}

function parseE2eTurnMetrics(text: string, debug: Record<string, unknown> | undefined): E2eTurnMetrics {
  const plannerAttemptsRaw = debug?.plannerAttempts;
  const plannerAttempts = Array.isArray(plannerAttemptsRaw) ? plannerAttemptsRaw.length : 0;

  const timingsRaw = debug?.timings as Record<string, unknown> | undefined;
  const totalMsValue = timingsRaw?.totalMs;
  const totalMs = typeof totalMsValue === "number" ? totalMsValue : null;

  const toolCallsRaw = debug?.toolCalls;
  const toolCalls = Array.isArray(toolCallsRaw) ? toolCallsRaw : [];
  let warehouseQueryOk = 0;
  let warehouseQueryErrors = 0;
  for (const call of toolCalls) {
    const entry = call as { tool?: unknown; status?: unknown };
    const tool = typeof entry.tool === "string" ? entry.tool : "";
    // Keep legacy compatibility in case older debug payloads still use snowflake.query.
    if (tool !== "warehouse.query" && tool !== "snowflake.query") {
      continue;
    }
    if (entry.status === "ok") {
      warehouseQueryOk += 1;
    } else if (entry.status === "error") {
      warehouseQueryErrors += 1;
    }
  }

  const llmUsageRaw = debug?.llmUsage as { totals?: unknown; calls?: unknown } | undefined;
  const llmTotals = llmUsageRaw?.totals as Record<string, unknown> | undefined;
  const llmCallsRaw = llmUsageRaw?.calls;
  const llmCalls = Array.isArray(llmCallsRaw) ? llmCallsRaw.length : 0;

  return {
    plannerAttempts,
    totalMs,
    warehouseQueryOk,
    warehouseQueryErrors,
    fallback: text.includes("I could not reach a reliable final answer"),
    promptTokens: asFiniteNumber(llmTotals?.promptTokens),
    completionTokens: asFiniteNumber(llmTotals?.completionTokens),
    totalTokens: asFiniteNumber(llmTotals?.totalTokens),
    totalCost: asFiniteNumber(llmTotals?.totalCost),
    llmCalls
  };
}

function parseCsvArg(value: string | boolean | undefined): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function loadBenchmarkPrompts(
  args: Record<string, string | boolean>

): { promptsId: string; questions: string[]; sourcePath: string } {
  const promptsArg =
    typeof args.prompts === "string"
      ? args.prompts.trim()
      : typeof args["prompt-set"] === "string"
        ? args["prompt-set"].trim()
        : "";
  const promptsPathArg =
    typeof args["prompts-path"] === "string"
      ? args["prompts-path"].trim()
      : typeof args["prompt-set-path"] === "string"
        ? args["prompt-set-path"].trim()
        : "";

  const requestedPromptsId = promptsArg.length > 0 ? promptsArg : DEFAULT_PROMPTS_ID;
  const defaultPromptsPath = path.join(DEFAULT_BENCHMARK_PROMPTS_DIR, `${requestedPromptsId}.json`);
  const selectedPath = promptsPathArg.length > 0 ? promptsPathArg : defaultPromptsPath;
  const resolvedPath = path.isAbsolute(selectedPath) ? selectedPath : path.join(process.cwd(), selectedPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Prompts file not found: ${resolvedPath}. Create it or pass --prompts-path <file>.`);
  }

  let parsed: BenchmarkPromptsFile;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf-8")) as BenchmarkPromptsFile;
  } catch (error) {
    throw new Error(`Invalid prompts JSON at ${resolvedPath}: ${(error as Error).message}`);
  }

  const questionsRaw = Array.isArray(parsed.questions) ? parsed.questions : [];
  const questions = questionsRaw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);

  if (questions.length === 0) {
    throw new Error(`Prompts file ${resolvedPath} has no valid questions.`);
  }

  const promptsIdFromFile = typeof parsed.id === "string" ? parsed.id.trim() : "";
  const promptsId =
    promptsIdFromFile.length > 0
      ? promptsIdFromFile
      : path.basename(resolvedPath, path.extname(resolvedPath));

  return {
    promptsId,
    questions,
    sourcePath: resolvedPath
  };
}

function usage(): string {
  return [
    "Usage:",
    "  npm run dev -- init --tenant <id> --repo-url <git@...> [--dbt-subpath models] [--force]",
    "  npm run dev -- sync-dbt --tenant <id>",
    "  npm run dev -- e2e-loop --tenant <id> [--profile default] [--model <provider/model>] [--models <m1,m2>] [--prompts e2e-default-v1] [--prompts-path benchmark/prompts/e2e-default-v1.json] [--runs 1] [--output benchmark/results/run.json] [--verbose]",
    "  npm run dev -- benchmark-local --tenant <id> [--profile default] [--model <provider/model>] [--models <m1,m2>] [--prompts e2e-default-v1] [--prompts-path benchmark/prompts/e2e-default-v1.json] [--runs 5] [--output benchmark/results/run.json] [--verbose]",
    "  npm run dev -- benchmark-compare --baseline benchmark/results/base.json --candidate benchmark/results/candidate.json [--report benchmark/results/compare.md] [--tolerance-pct 5] [--tolerance-pp 1] [--fail-on-worse]",
    "  npm run dev -- benchmark-one-shot --tenant <id> --baseline benchmark/results/base.json [--candidate-output benchmark/results/candidate.json] [--report benchmark/results/compare.md] [--model <provider/model>|--models <m1,m2>] [--prompts e2e-default-v1] [--runs 2] [--tolerance-pct 5] [--tolerance-pp 1] [--fail-on-worse] [--verbose]",
    "  npm run dev -- prod-smoke --tenant <id> [--model <provider/model>]",
    "  npm run dev -- chat --tenant <id> [--profile default] [--conversation <id>] [--message \"...\"] [--verbose] [--model <provider/model>]",
    "  npm run dev -- slack [--tenant <id>] [--profile default] [--port 3000] [--model <provider/model>]",
    "  npm run dev -- slack-map-channel --channel <C...> --tenant <id>",
    "  npm run dev -- slack-map-user --user <U...> --tenant <id>",
    "  npm run dev -- slack-map-shared-team --team <T...> --tenant <id>",
    "  npm run dev -- slack-map-list",
    "  npm run dev -- slack-map-validate",
    "  npm run dev -- set-warehouse --tenant <id> --provider bigquery --project <gcp-project> [--dataset <ds>] [--location US] [--key-file /path/to/sa-key.json]",
    "  npm run dev -- set-warehouse --tenant <id> --provider snowflake --account <acc> --username <user> --warehouse <wh> --database <db> --schema <sch> [--role <role>] [--auth-type password] [--password-env SNOWFLAKE_PASSWORD]",
    "  npm run dev -- telegram [--tenant <id>] [--profile default] [--model <provider/model>]",
    "  npm run dev -- telegram-map-channel --chat <chatId> --tenant <id>",
    "  npm run dev -- telegram-map-list",
    "  npm run dev -- status [--tenant <id>]",
    "  npm run dev -- admin-ui [--port 3100]",
    "  npm run dev -- admin-password-hash --password <value>"
  ].join("\n");
}

async function run(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);
  const store = buildStore();

  if (!command) {
    output.write(`${usage()}\n`);
    process.exit(1);
  }

  if (command === "init") {
    const tenantId = getStringArg(args, "tenant");
    const repoUrl = getStringArg(args, "repo-url");
    const dbtSubpath = getStringArg(args, "dbt-subpath", "models");
    const force = args.force === true;
    const result = initializeTenant(
      { appDataDir: env.appDataDir, tenantId, repoUrl, dbtSubpath, force },
      store
    );
    output.write(`Tenant initialized: ${tenantId}\n`);
    output.write(`dbt repo url: ${repoUrl}\n`);
    output.write(`local clone path: ${result.localRepoPath}\n`);
    output.write(`public key (add as GitHub Deploy Key):\n${result.publicKey}\n`);
    return;
  }

  if (command === "sync-dbt") {
    const tenantId = getStringArg(args, "tenant");
    const dbt = new GitDbtRepositoryService(store);
    await dbt.syncRepo(tenantId);
    const models = await dbt.listModels(tenantId);
    output.write(`Synced dbt repo for tenant "${tenantId}". Models found: ${models.length}\n`);
    return;
  }

  if (command === "set-warehouse") {
    const tenantId = getStringArg(args, "tenant");
    const provider = getStringArg(args, "provider", "snowflake") as "snowflake" | "bigquery";
    if (provider === "bigquery") {
      const projectId = getStringArg(args, "project");
      const dataset = typeof args.dataset === "string" ? args.dataset : undefined;
      const location = typeof args.location === "string" ? args.location : undefined;
      const keyFile = typeof args["key-file"] === "string" ? args["key-file"] : undefined;
      let authType: "adc" | "service-account-key" = "adc";
      let serviceAccountKeyPath: string | undefined;
      if (keyFile) {
        if (!fs.existsSync(keyFile)) {
          output.write(`${errorText("Error:")} key file not found: ${keyFile}\n`);
          process.exit(1);
        }
        const keyContent = fs.readFileSync(keyFile, "utf-8");
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(keyContent) as Record<string, unknown>;
        } catch {
          output.write(`${errorText("Error:")} key file is not valid JSON.\n`);
          process.exit(1);
        }
        if (parsed.type !== "service_account") {
          output.write(`${errorText("Error:")} key file must be a Google Cloud service account key (type: "service_account").\n`);
          process.exit(1);
        }
        const keysDir = `${env.appDataDir}/keys/${tenantId}`;
        fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
        serviceAccountKeyPath = `${keysDir}/bigquery_sa_${Date.now()}.json`;
        fs.copyFileSync(keyFile, serviceAccountKeyPath);
        fs.chmodSync(serviceAccountKeyPath, 0o600);
        const fingerprint = crypto.createHash("sha256").update(keyContent).digest("hex").slice(0, 16);
        store.upsertTenantKeyMetadata({ tenantId, filePath: serviceAccountKeyPath, uploadedAt: new Date().toISOString(), fingerprint });
        authType = "service-account-key";
        output.write(`  SA key: ${serviceAccountKeyPath} (fingerprint: ${fingerprint})\n`);
      }
      store.upsertTenantWarehouseConfig({
        tenantId,
        provider: "bigquery",
        bigquery: { projectId, dataset, location, authType, serviceAccountKeyPath }
      });
      output.write(`${successText("Saved")} BigQuery warehouse config for tenant ${tenantId}\n`);
      output.write(`  project: ${projectId}\n`);
      output.write(`  auth: ${authType}\n`);
      if (dataset) output.write(`  dataset: ${dataset}\n`);
      if (location) output.write(`  location: ${location}\n`);
    } else {
      const account = getStringArg(args, "account");
      const username = getStringArg(args, "username");
      const warehouse = getStringArg(args, "warehouse");
      const database = getStringArg(args, "database");
      const schema = getStringArg(args, "schema");
      const role = typeof args.role === "string" ? args.role : undefined;
      const authType = (typeof args["auth-type"] === "string" ? args["auth-type"] : "password") as "password" | "keypair";
      const passwordEnvVar = typeof args["password-env"] === "string" ? args["password-env"] : "SNOWFLAKE_PASSWORD";
      const privateKeyPath = typeof args["private-key-path"] === "string" ? args["private-key-path"] : undefined;
      store.upsertTenantWarehouseConfig({
        tenantId,
        provider: "snowflake",
        snowflake: { account, username, warehouse, database, schema, role, authType, passwordEnvVar, privateKeyPath }
      });
      output.write(`${successText("Saved")} Snowflake warehouse config for tenant ${tenantId}\n`);
      output.write(`  account: ${account}  database: ${database}  schema: ${schema}\n`);
    }
    return;
  }

  if (command === "chat") {
    const runtime = buildRuntime(store);
    const tenantId = getStringArg(args, "tenant");
    const profileName = getStringArg(args, "profile", "default");
    const conversationId = getStringArg(args, "conversation", createId("conv"));
    const oneShotMessage = typeof args.message === "string" ? args.message : null;
    const llmModel = typeof args.model === "string" ? args.model : env.llmModel;
    const verbose = args.verbose === true || env.verboseMode;

    if (oneShotMessage) {
      const response = await runtime.respond(
        { tenantId, profileName, conversationId, llmModel, origin: { source: "cli" } },
        oneShotMessage
      );
      if (verbose) {
        output.write("\n");
        printVerboseDebug(response.debug);
        output.write("\n");
      }
      output.write(`${successText(response.text)}\n`);
      printArtifacts(response.artifacts);
      return;
    }

    output.write(
      `${infoLabel("Chat started.")} tenant=${tenantId} profile=${profileName} conversation=${conversationId}\n`
    );
    if (verbose) {
      output.write(`${infoLabel("Verbose mode enabled.")}\n`);
    }
    output.write(`${infoLabel('Type "exit" to quit.')}\n`);

    const rl = readline.createInterface({ input, output });
    while (true) {
      const message = (await rl.question("> ")).trim();
      if (!message) {
        continue;
      }
      if (message.toLowerCase() === "exit") {
        break;
      }
      try {
        output.write(`${infoLabel("Thinking...")}\n`);
        const response = await runtime.respond(
          { tenantId, profileName, conversationId, llmModel, origin: { source: "cli" } },
          message
        );
        if (verbose) {
          output.write("\n");
          printVerboseDebug(response.debug);
          output.write("\n");
        }
        output.write(`${successText(response.text)}\n\n`);
        printArtifacts(response.artifacts);
      } catch (error) {
        output.write(`\n${errorText(`Error: ${(error as Error).message}`)}\n\n`);
      }
    }
    rl.close();
    return;
  }

  if (command === "e2e-loop" || command === "benchmark-local") {
    const runtime = buildRuntime(store);
    const benchmarkLocal = command === "benchmark-local";
    const tenantId = getStringArg(args, "tenant");
    const profileName = getStringArg(args, "profile", "default");
    const verbose = args.verbose === true || env.verboseMode;
    const singleModel = typeof args.model === "string" ? args.model.trim() : "";
    const modelsFromCsv = parseCsvArg(args.models);
    const models =
      modelsFromCsv.length > 0
        ? modelsFromCsv
        : singleModel.length > 0
          ? [singleModel]
          : [env.llmModel];

    const defaultRuns = benchmarkLocal ? 5 : 1;
    const runsRaw = typeof args.runs === "string" ? Number.parseInt(args.runs, 10) : defaultRuns;
    const runs = Number.isFinite(runsRaw) && runsRaw > 0 ? runsRaw : defaultRuns;
    const prompts = loadBenchmarkPrompts(args);
    const outputArg = typeof args.output === "string" ? args.output.trim() : "";
    const executedAt = new Date().toISOString();
    const runId = `bench_${executedAt.replace(/[:.]/g, "-")}`;
    const outputPath =
      outputArg.length > 0
        ? outputArg
        : benchmarkLocal
          ? path.join("benchmark", "results", `${runId}.json`)
          : "";

    const benchmarkResult: BenchmarkRunResult = {
      benchmarkVersion: "v1",
      promptsId: prompts.promptsId,
      runMeta: {
        runId,
        branch: safeGitRef("git rev-parse --abbrev-ref HEAD"),
        commit: safeGitRef("git rev-parse --short HEAD"),
        tenantId,
        profileName,
        runs,
        executedAt
      },
      models: []
    };

    output.write(
      `${infoLabel("E2E loop started.")} tenant=${tenantId} profile=${profileName} runs=${runs} models=${models.join(", ")} prompts=${prompts.promptsId}\n`
    );
    output.write(`${infoLabel("Prompts source")} ${prompts.sourcePath}\n`);
    if (outputPath) {
      output.write(`${infoLabel("Benchmark output path")} ${outputPath}\n`);
    }

    for (const llmModel of models) {
      output.write(`\n${paint(`=== Model: ${llmModel} ===`, 35)}\n`);
      const modelMetrics: E2eTurnMetrics[] = [];
      const turnRecords: BenchmarkTurnRecord[] = [];

      for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
        const conversationId = createId("e2e");
        output.write(`${infoLabel(`[run ${runIndex}/${runs}]`)} conversation=${conversationId}\n`);

        for (let questionIndex = 0; questionIndex < prompts.questions.length; questionIndex += 1) {
          const question = prompts.questions[questionIndex];
          output.write(`${warnText(`Q${questionIndex + 1}:`)} ${question}\n`);
          try {
            const response = await runtime.respond(
              { tenantId, profileName, conversationId, llmModel, origin: { source: "cli" } },
              question
            );
            const metrics = parseE2eTurnMetrics(response.text, response.debug);
            modelMetrics.push(metrics);
            turnRecords.push({
              runIndex,
              questionIndex: questionIndex + 1,
              question,
              conversationId,
              metrics
            });

            output.write(`${successText("A:")} ${response.text}\n`);
            printArtifacts(response.artifacts);
            output.write(
              `${infoLabel("[metrics]")} attempts=${metrics.plannerAttempts} totalMs=${
                metrics.totalMs ?? "n/a"
              } warehouse.ok=${metrics.warehouseQueryOk} warehouse.error=${metrics.warehouseQueryErrors} tokens=${metrics.totalTokens} cost=${metrics.totalCost.toFixed(6)} llmCalls=${metrics.llmCalls} fallback=${metrics.fallback}\n`
            );
            if (verbose) {
              printVerboseDebug(response.debug);
            }
            output.write("\n");
          } catch (error) {
            const errorMessage = (error as Error).message;
            output.write(`${errorText(`Error: ${errorMessage}`)}\n\n`);
            const failedMetrics: E2eTurnMetrics = {
              plannerAttempts: 0,
              totalMs: null,
              warehouseQueryOk: 0,
              warehouseQueryErrors: 0,
              fallback: true,
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              totalCost: 0,
              llmCalls: 0
            };
            modelMetrics.push(failedMetrics);
            turnRecords.push({
              runIndex,
              questionIndex: questionIndex + 1,
              question,
              conversationId,
              metrics: failedMetrics,
              error: errorMessage
            });
          }
        }
      }

      const totalTurns = modelMetrics.length;
      const fallbackTurns = modelMetrics.filter((metric) => metric.fallback).length;
      const plannerAttemptsValues = modelMetrics.map((metric) => metric.plannerAttempts);
      const timedMsValues = modelMetrics
        .map((metric) => metric.totalMs)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

      const totalWarehouseQueryOk = modelMetrics.reduce((acc, metric) => acc + metric.warehouseQueryOk, 0);
      const totalWarehouseQueryErrors = modelMetrics.reduce((acc, metric) => acc + metric.warehouseQueryErrors, 0);
      const warehouseCallCount = totalWarehouseQueryOk + totalWarehouseQueryErrors;

      const totalPromptTokens = modelMetrics.reduce((acc, metric) => acc + metric.promptTokens, 0);
      const totalCompletionTokens = modelMetrics.reduce((acc, metric) => acc + metric.completionTokens, 0);
      const totalTokens = modelMetrics.reduce((acc, metric) => acc + metric.totalTokens, 0);
      const totalCost = modelMetrics.reduce((acc, metric) => acc + metric.totalCost, 0);
      const totalLlmCalls = modelMetrics.reduce((acc, metric) => acc + metric.llmCalls, 0);

      const summary: BenchmarkModelSummary = {
        turns: totalTurns,
        fallbackTurns,
        fallbackRate: totalTurns === 0 ? 0 : fallbackTurns / totalTurns,
        avgPlannerAttempts: average(plannerAttemptsValues),
        medianPlannerAttempts: percentile(plannerAttemptsValues, 0.5),
        avgTotalMs: average(timedMsValues),
        medianTotalMs: percentile(timedMsValues, 0.5),
        p95TotalMs: percentile(timedMsValues, 0.95),
        warehouseQueryOk: totalWarehouseQueryOk,
        warehouseQueryErrors: totalWarehouseQueryErrors,
        toolErrorRate: warehouseCallCount === 0 ? 0 : totalWarehouseQueryErrors / warehouseCallCount,
        noWarehouseCalls: warehouseCallCount === 0,
        totalPromptTokens,
        totalCompletionTokens,
        totalTokens,
        tokensPerTurn: totalTurns === 0 ? 0 : totalTokens / totalTurns,
        totalCost,
        costPerTurn: totalTurns === 0 ? 0 : totalCost / totalTurns,
        totalLlmCalls
      };

      output.write(`${paint("Model summary", 36)}\n`);
      output.write(`  - turns=${summary.turns}\n`);
      output.write(`  - fallbackTurns=${summary.fallbackTurns}\n`);
      output.write(`  - fallbackRate=${summary.fallbackRate.toFixed(4)}\n`);
      output.write(`  - avgPlannerAttempts=${summary.avgPlannerAttempts.toFixed(2)}\n`);
      output.write(`  - medianPlannerAttempts=${summary.medianPlannerAttempts.toFixed(2)}\n`);
      output.write(`  - avgTotalMs=${Math.round(summary.avgTotalMs)}\n`);
      output.write(`  - medianTotalMs=${Math.round(summary.medianTotalMs)}\n`);
      output.write(`  - p95TotalMs=${Math.round(summary.p95TotalMs)}\n`);
      output.write(`  - warehouseQueryOk=${summary.warehouseQueryOk}\n`);
      output.write(`  - warehouseQueryErrors=${summary.warehouseQueryErrors}\n`);
      output.write(`  - toolErrorRate=${summary.toolErrorRate.toFixed(4)}\n`);
      output.write(`  - totalPromptTokens=${summary.totalPromptTokens}\n`);
      output.write(`  - totalCompletionTokens=${summary.totalCompletionTokens}\n`);
      output.write(`  - totalTokens=${summary.totalTokens}\n`);
      output.write(`  - tokensPerTurn=${summary.tokensPerTurn.toFixed(2)}\n`);
      output.write(`  - totalCost=${summary.totalCost.toFixed(6)}\n`);
      output.write(`  - costPerTurn=${summary.costPerTurn.toFixed(6)}\n`);
      output.write(`  - totalLlmCalls=${summary.totalLlmCalls}\n`);

      benchmarkResult.models.push({
        model: llmModel,
        turns: turnRecords,
        summary
      });
    }

    if (outputPath) {
      const resolvedOutputPath = path.isAbsolute(outputPath) ? outputPath : path.join(process.cwd(), outputPath);
      fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
      fs.writeFileSync(resolvedOutputPath, `${JSON.stringify(benchmarkResult, null, 2)}\n`, "utf-8");
      output.write(`${successText("Benchmark JSON saved.")} ${resolvedOutputPath}\n`);
    }
    return;
  }

  if (command === "benchmark-compare") {
    const baselinePath = getStringArg(args, "baseline");
    const candidatePath = getStringArg(args, "candidate");
    const reportArg = typeof args.report === "string" ? args.report.trim() : "";
    const tolerancePct = Math.max(0, toFiniteOrDefault(args["tolerance-pct"], 5));
    const tolerancePp = Math.max(0, toFiniteOrDefault(args["tolerance-pp"], 1));
    const failOnWorse = args["fail-on-worse"] === true;

    const baseline = parseBenchmarkSnapshot(baselinePath);
    const candidate = parseBenchmarkSnapshot(candidatePath);

    const baselineByModel = new Map(baseline.models.map((entry) => [entry.model, entry]));
    const candidateByModel = new Map(candidate.models.map((entry) => [entry.model, entry]));

    const commonModels = candidate.models
      .map((entry) => entry.model)
      .filter((modelName) => baselineByModel.has(modelName));

    if (commonModels.length === 0) {
      throw new Error(
        `No overlapping models between baseline (${baseline.sourcePath}) and candidate (${candidate.sourcePath}).`
      );
    }

    const missingInBaseline = candidate.models
      .map((entry) => entry.model)
      .filter((modelName) => !baselineByModel.has(modelName));
    const missingInCandidate = baseline.models
      .map((entry) => entry.model)
      .filter((modelName) => !candidateByModel.has(modelName));

    output.write(`${paint("Benchmark comparison", 36)}\n`);
    output.write(`  baseline:  ${baseline.sourcePath}\n`);
    output.write(`  candidate: ${candidate.sourcePath}\n`);
    output.write(`  tolerance: pct=±${tolerancePct.toFixed(2)} pp=±${tolerancePp.toFixed(2)}\n`);
    if (baseline.promptsId || candidate.promptsId) {
      output.write(`  prompts: baseline=${baseline.promptsId ?? "n/a"} candidate=${candidate.promptsId ?? "n/a"}\n`);
    }
    if (missingInBaseline.length > 0) {
      output.write(`${warnText("  skipped (missing in baseline):")} ${missingInBaseline.join(", ")}\n`);
    }
    if (missingInCandidate.length > 0) {
      output.write(`${warnText("  skipped (missing in candidate):")} ${missingInCandidate.join(", ")}\n`);
    }

    const reportLines: string[] = [];
    reportLines.push("# Benchmark comparison");
    reportLines.push("");
    reportLines.push(`- Baseline: \`${baseline.sourcePath}\``);
    reportLines.push(`- Candidate: \`${candidate.sourcePath}\``);
    reportLines.push(`- Tolerance: pct=±${tolerancePct.toFixed(2)} / pp=±${tolerancePp.toFixed(2)}`);
    if (baseline.promptsId || candidate.promptsId) {
      reportLines.push(`- Prompts: baseline=\`${baseline.promptsId ?? "n/a"}\`, candidate=\`${candidate.promptsId ?? "n/a"}\``);
    }
    reportLines.push("");

    let betterCount = 0;
    let similarCount = 0;
    let worseCount = 0;

    const buildRelativeMetric = (
      label: string,
      baselineValue: number,
      candidateValue: number,
      format: (value: number) => string
    ): ComparisonMetricResult => {
      const deltaPct = baselineValue === 0 ? (candidateValue === 0 ? 0 : 100) : ((candidateValue - baselineValue) / baselineValue) * 100;
      const trend = classifyDeltaPct(deltaPct, tolerancePct);
      return {
        label,
        baselineDisplay: format(baselineValue),
        candidateDisplay: format(candidateValue),
        deltaDisplay: `${formatSigned(deltaPct, 2)}%`,
        trend
      };
    };

    const buildPpMetric = (
      label: string,
      baselinePercentPoints: number,
      candidatePercentPoints: number
    ): ComparisonMetricResult => {
      const deltaPp = candidatePercentPoints - baselinePercentPoints;
      const trend = classifyDeltaPp(deltaPp, tolerancePp);
      return {
        label,
        baselineDisplay: `${formatNumber(baselinePercentPoints, 2)}%`,
        candidateDisplay: `${formatNumber(candidatePercentPoints, 2)}%`,
        deltaDisplay: `${formatSigned(deltaPp, 2)} pp`,
        trend
      };
    };

    for (const modelName of commonModels) {
      const baselineModel = baselineByModel.get(modelName);
      const candidateModel = candidateByModel.get(modelName);
      if (!baselineModel || !candidateModel) {
        continue;
      }

      const rows: ComparisonMetricResult[] = [
        buildRelativeMetric(
          "medianTotalMs",
          baselineModel.summary.medianTotalMs,
          candidateModel.summary.medianTotalMs,
          (value) => `${Math.round(value)} ms`
        ),
        buildRelativeMetric(
          "avgLoops",
          baselineModel.summary.avgPlannerAttempts,
          candidateModel.summary.avgPlannerAttempts,
          (value) => formatNumber(value, 2)
        ),
        buildRelativeMetric(
          "totalTokens",
          baselineModel.summary.totalTokens,
          candidateModel.summary.totalTokens,
          (value) => `${Math.round(value)}`
        ),
        buildRelativeMetric(
          "totalCost",
          baselineModel.summary.totalCost,
          candidateModel.summary.totalCost,
          (value) => `$${formatNumber(value, 6)}`
        ),
        buildPpMetric(
          "fallbackRate",
          baselineModel.summary.fallbackRate * 100,
          candidateModel.summary.fallbackRate * 100
        ),
        buildPpMetric(
          "toolErrorRate",
          baselineModel.summary.toolErrorRate * 100,
          candidateModel.summary.toolErrorRate * 100
        )
      ];

      output.write(`\n${paint(`=== Compare model: ${modelName} ===`, 35)}\n`);
      output.write(
        `  turns: baseline=${baselineModel.summary.turns} candidate=${candidateModel.summary.turns}\n`
      );

      reportLines.push(`## Model: ${modelName}`);
      reportLines.push("");
      reportLines.push(
        `- Turns: baseline=${baselineModel.summary.turns}, candidate=${candidateModel.summary.turns}`
      );
      reportLines.push("");
      reportLines.push("| Metric | Baseline | Candidate | Delta | Trend |");
      reportLines.push("|---|---:|---:|---:|---|");

      for (const row of rows) {
        if (row.trend === "better") {
          betterCount += 1;
        } else if (row.trend === "worse") {
          worseCount += 1;
        } else {
          similarCount += 1;
        }

        output.write(
          `  - ${row.label}: base=${row.baselineDisplay} cand=${row.candidateDisplay} delta=${row.deltaDisplay} -> ${formatTrend(row.trend)}\n`
        );
        reportLines.push(
          `| ${row.label} | ${row.baselineDisplay} | ${row.candidateDisplay} | ${row.deltaDisplay} | ${row.trend} |`
        );
      }
      reportLines.push("");
    }

    output.write(`\n${paint("Comparison summary", 36)}\n`);
    output.write(`  better=${betterCount} similar=${similarCount} worse=${worseCount}\n`);
    reportLines.push("## Summary");
    reportLines.push("");
    reportLines.push(`- better: ${betterCount}`);
    reportLines.push(`- similar: ${similarCount}`);
    reportLines.push(`- worse: ${worseCount}`);
    reportLines.push("");

    if (reportArg.length > 0) {
      const resolvedReportPath = path.isAbsolute(reportArg) ? reportArg : path.join(process.cwd(), reportArg);
      fs.mkdirSync(path.dirname(resolvedReportPath), { recursive: true });
      fs.writeFileSync(resolvedReportPath, `${reportLines.join("\n")}\n`, "utf-8");
      output.write(`${successText("Comparison report saved.")} ${resolvedReportPath}\n`);
    }

    if (failOnWorse && worseCount > 0) {
      output.write(`${errorText("Comparison failed: worse metrics detected.")}\n`);
      process.exitCode = 2;
    }
    return;
  }

  if (command === "benchmark-one-shot") {
    const tenantId = getStringArg(args, "tenant");
    const baselinePath = getStringArg(args, "baseline");
    const candidateOutputArg = typeof args["candidate-output"] === "string" ? args["candidate-output"].trim() : "";
    const reportArg = typeof args.report === "string" ? args.report.trim() : "";
    const generatedStamp = new Date().toISOString().replace(/[:.]/g, "-");
    const candidateOutputPath =
      candidateOutputArg.length > 0
        ? candidateOutputArg
        : path.join("benchmark", "results", `candidate-${generatedStamp}.json`);

    const benchmarkParts: string[] = ["npm", "run", "dev", "--", "benchmark-local", "--tenant", tenantId, "--output", candidateOutputPath];

    const profileArg = typeof args.profile === "string" ? args.profile.trim() : "";
    if (profileArg.length > 0) {
      benchmarkParts.push("--profile", profileArg);
    }
    const modelArg = typeof args.model === "string" ? args.model.trim() : "";
    if (modelArg.length > 0) {
      benchmarkParts.push("--model", modelArg);
    }
    const modelsArg = typeof args.models === "string" ? args.models.trim() : "";
    if (modelsArg.length > 0) {
      benchmarkParts.push("--models", modelsArg);
    }
    const promptsArg = typeof args.prompts === "string" ? args.prompts.trim() : "";
    if (promptsArg.length > 0) {
      benchmarkParts.push("--prompts", promptsArg);
    }
    const promptsPathArg = typeof args["prompts-path"] === "string" ? args["prompts-path"].trim() : "";
    if (promptsPathArg.length > 0) {
      benchmarkParts.push("--prompts-path", promptsPathArg);
    }
    const runsArg = typeof args.runs === "string" ? args.runs.trim() : "";
    if (runsArg.length > 0) {
      benchmarkParts.push("--runs", runsArg);
    }
    if (args.verbose === true) {
      benchmarkParts.push("--verbose");
    }

    output.write(`${paint("One-shot benchmark", 36)}\n`);
    output.write(`  baseline: ${baselinePath}\n`);
    output.write(`  candidate output: ${candidateOutputPath}\n`);

    runShellCommand(benchmarkParts);

    const compareParts: string[] = [
      "npm",
      "run",
      "dev",
      "--",
      "benchmark-compare",
      "--baseline",
      baselinePath,
      "--candidate",
      candidateOutputPath
    ];

    if (reportArg.length > 0) {
      compareParts.push("--report", reportArg);
    }
    const tolerancePctArg = typeof args["tolerance-pct"] === "string" ? args["tolerance-pct"].trim() : "";
    if (tolerancePctArg.length > 0) {
      compareParts.push("--tolerance-pct", tolerancePctArg);
    }
    const tolerancePpArg = typeof args["tolerance-pp"] === "string" ? args["tolerance-pp"].trim() : "";
    if (tolerancePpArg.length > 0) {
      compareParts.push("--tolerance-pp", tolerancePpArg);
    }
    if (args["fail-on-worse"] === true) {
      compareParts.push("--fail-on-worse");
    }

    runShellCommand(compareParts);
    return;
  }

  if (command === "prod-smoke") {
    const tenantId = getStringArg(args, "tenant");
    const llmModel = typeof args.model === "string" ? args.model : env.llmModel;
    const dbt = new GitDbtRepositoryService(store);
    const llm = buildLlmProvider();
    const warehouse = buildSnowflakeWarehouse();

    output.write("Running production smoke checks...\n");

    output.write("1/3 LLM connectivity...\n");
    const llmResult = await llm.generateText({
      model: llmModel,
      temperature: 0,
      messages: [
        { role: "system", content: "Return only the word OK." },
        { role: "user", content: "Health check." }
      ]
    });
    output.write(`   LLM response: ${llmResult.text.slice(0, 200)}\n`);

    output.write("2/3 Snowflake connectivity...\n");
    const sfResult = await warehouse.query(
      "SELECT CURRENT_ACCOUNT() AS account, CURRENT_ROLE() AS role, CURRENT_DATABASE() AS database_name, CURRENT_SCHEMA() AS schema_name LIMIT 1"
    );
    output.write(`   Snowflake rows: ${sfResult.rowCount}\n`);

    output.write("3/3 dbt repo sync + indexing...\n");
    await dbt.syncRepo(tenantId);
    const models = await dbt.listModels(tenantId);
    output.write(`   dbt models indexed: ${models.length}\n`);
    output.write("Smoke checks complete.\n");
    return;
  }

  if (command === "slack-map-channel") {
    const channelId = getStringArg(args, "channel");
    const tenantId = getStringArg(args, "tenant");
    store.upsertSlackChannelTenant(channelId, tenantId, "manual");
    output.write(`${successText("Mapped")} channel ${channelId} -> tenant ${tenantId}\n`);
    return;
  }

  if (command === "slack-map-user") {
    const userId = getStringArg(args, "user");
    const tenantId = getStringArg(args, "tenant");
    store.upsertSlackUserTenant(userId, tenantId);
    output.write(`${successText("Mapped")} user ${userId} -> tenant ${tenantId}\n`);
    return;
  }

  if (command === "slack-map-shared-team") {
    const teamId = getStringArg(args, "team");
    const tenantId = getStringArg(args, "tenant");
    store.upsertSlackSharedTeamTenant(teamId, tenantId);
    output.write(`${successText("Mapped")} shared team ${teamId} -> tenant ${tenantId}\n`);
    return;
  }

  if (command === "slack-map-list") {
    const channels = store.listSlackChannelMappings();
    const users = store.listSlackUserMappings();
    const sharedTeams = store.listSlackSharedTeamMappings();

    output.write(`${infoLabel("Channel mappings")} (${channels.length})\n`);
    for (const m of channels) {
      output.write(`  ${m.channelId} -> ${m.tenantId} (${m.source}) ${m.updatedAt}\n`);
    }
    output.write(`${infoLabel("User mappings")} (${users.length})\n`);
    for (const m of users) {
      output.write(`  ${m.userId} -> ${m.tenantId} ${m.updatedAt}\n`);
    }
    output.write(`${infoLabel("Shared team mappings")} (${sharedTeams.length})\n`);
    for (const m of sharedTeams) {
      output.write(`  ${m.sharedTeamId} -> ${m.tenantId} ${m.updatedAt}\n`);
    }
    return;
  }

  if (command === "slack-map-validate") {
    const channels = store.listSlackChannelMappings();
    const users = store.listSlackUserMappings();
    const sharedTeams = store.listSlackSharedTeamMappings();
    const allTenantIds = [
      ...channels.map((c) => c.tenantId),
      ...users.map((u) => u.tenantId),
      ...sharedTeams.map((s) => s.tenantId)
    ];
    const uniqueTenants = [...new Set(allTenantIds)];

    let ok = true;
    for (const tenantId of uniqueTenants) {
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        output.write(`${warnText("Missing")} tenant ${tenantId}: no dbt repo (run init --tenant ${tenantId})\n`);
        ok = false;
      } else {
        output.write(`${successText("OK")} tenant ${tenantId}: repo configured\n`);
      }
    }
    if (channels.length === 0 && users.length === 0 && sharedTeams.length === 0) {
      output.write(`${warnText("No mappings")} defined. Add channel/user/shared-team mappings before go-live.\n`);
      ok = false;
    }
    if (ok) {
      output.write(`${successText("Validation passed.")}\n`);
    }
    return;
  }

  if (command === "admin-ui") {
    const port = typeof args.port === "string" ? Number.parseInt(args.port, 10) : env.adminPort;
    startAdminServer({
      store,
      port: Number.isFinite(port) ? port : 3100,
      appDataDir: env.appDataDir
    });
    return;
  }

  if (command === "admin-password-hash") {
    const password = getStringArg(args, "password");
    output.write(`${hashAdminPassword(password)}\n`);
    return;
  }

  if (command === "telegram") {
    const runtime = buildRuntime(store);
    const defaultTenantId =
      (typeof args.tenant === "string" ? args.tenant : undefined) ||
      env.telegramDefaultTenantId ||
      undefined;
    const defaultProfileName =
      (typeof args.profile === "string" ? args.profile : undefined) || env.telegramDefaultProfileName || "default";
    const llmModel = typeof args.model === "string" ? args.model : undefined;

    const telegramGlobal = env.telegramBotToken.trim();
    await startTelegramAgentServer({
      runtime,
      store,
      ...(telegramGlobal ? { botToken: telegramGlobal } : {}),
      defaultTenantId,
      defaultProfileName,
      llmModel
    });
    return;
  }

  if (command === "telegram-map-channel") {
    const chatId = getStringArg(args, "chat");
    const tenantId = getStringArg(args, "tenant");
    store.upsertTelegramChatTenant(chatId, tenantId, "manual");
    output.write(`${successText("Mapped")} Telegram chat ${chatId} -> tenant ${tenantId}\n`);
    return;
  }

  if (command === "telegram-map-list") {
    const chats = store.listTelegramChatMappings();
    output.write(`${infoLabel("Telegram chat mappings")} (${chats.length})\n`);
    for (const m of chats) {
      output.write(`  ${m.chatId} -> ${m.tenantId} (${m.source}) ${m.updatedAt}\n`);
    }
    return;
  }

  if (command === "slack") {
    const runtime = buildRuntime(store);
    const guardrails = store.getGuardrails();
    const defaultTenantId =
      (typeof args.tenant === "string" ? args.tenant : undefined) ||
      env.slackDefaultTenantId ||
      guardrails?.defaultTenantId ||
      undefined;
    const defaultProfileName =
      (typeof args.profile === "string" ? args.profile : undefined) || env.slackDefaultProfileName || "default";
    const llmModel = typeof args.model === "string" ? args.model : undefined;
    const port = typeof args.port === "string" ? Number.parseInt(args.port, 10) : env.slackPort;
    const teamTenantMap =
      guardrails?.teamTenantMap && Object.keys(guardrails.teamTenantMap).length > 0
        ? guardrails.teamTenantMap
        : parseSlackTeamTenantMap(env.slackTeamTenantMapRaw);
    const ownerTeamIds =
      guardrails?.ownerTeamIds && guardrails.ownerTeamIds.length > 0
        ? guardrails.ownerTeamIds
        : env.slackOwnerTeamIdsRaw
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    const ownerEnterpriseIds =
      guardrails?.ownerEnterpriseIds && guardrails.ownerEnterpriseIds.length > 0
        ? guardrails.ownerEnterpriseIds
        : env.slackOwnerEnterpriseIdsRaw
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    const strictTenantRouting = guardrails?.strictTenantRouting ?? env.slackStrictTenantRouting;

    await startSlackAgentServer({
      runtime,
      store,
      botToken: env.slackBotToken,
      signingSecret: env.slackSigningSecret,
      port: Number.isFinite(port) ? port : 3000,
      defaultTenantId,
      defaultProfileName,
      llmModel,
      teamTenantMap,
      ownerTeamIds,
      ownerEnterpriseIds,
      strictTenantRouting
    });
    return;
  }

  if (command === "status") {
    const filterTenantId = typeof args.tenant === "string" ? args.tenant : null;
    const tenants = store.listTenants();
    const slackChannels = store.listSlackChannelMappings();
    const slackUsers = store.listSlackUserMappings();
    const slackSharedTeams = store.listSlackSharedTeamMappings();
    const telegramChats = store.listTelegramChatMappings();

    const tenantIds = filterTenantId
      ? [filterTenantId]
      : Array.from(new Set([
          ...tenants.map((t) => t.tenantId),
          ...slackChannels.map((m) => m.tenantId),
          ...slackUsers.map((m) => m.tenantId),
          ...slackSharedTeams.map((m) => m.tenantId),
          ...telegramChats.map((m) => m.tenantId)
        ]));

    if (tenantIds.length === 0) {
      output.write(`${warnText("No tenants found.")} Run init to create one.\n`);
      return;
    }

    for (const tenantId of tenantIds) {
      output.write(`\n${paint(`=== Tenant: ${tenantId} ===`, 35)}\n`);

      const repo = store.getTenantRepo(tenantId);
      if (repo) {
        const repoExists = fs.existsSync(repo.localPath);
        const dbt = new GitDbtRepositoryService(store);
        let modelCount = 0;
        if (repoExists) {
          try {
            const models = await dbt.listModels(tenantId);
            modelCount = models.length;
          } catch {
            modelCount = 0;
          }
        }
        output.write(`  ${infoLabel("dbt repo")}\n`);
        output.write(`    url:    ${repo.repoUrl}\n`);
        output.write(`    subpath: ${repo.dbtSubpath}\n`);
        output.write(`    local:  ${repo.localPath}\n`);
        output.write(`    cloned: ${repoExists ? successText("yes") : warnText("no -- run sync-dbt --tenant " + tenantId)}\n`);
        if (repoExists) {
          output.write(`    models: ${modelCount > 0 ? successText(String(modelCount)) : warnText("0")}\n`);
        }
      } else {
        output.write(`  ${infoLabel("dbt repo")}  ${warnText("not configured")}\n`);
      }

      const whConfig = store.getTenantWarehouseConfig(tenantId);
      if (whConfig) {
        output.write(`  ${infoLabel("warehouse")}  ${successText(whConfig.provider)}\n`);
        if (whConfig.provider === "bigquery" && whConfig.bigquery) {
          output.write(`    project:  ${whConfig.bigquery.projectId}\n`);
          if (whConfig.bigquery.dataset) output.write(`    dataset:  ${whConfig.bigquery.dataset}\n`);
          if (whConfig.bigquery.location) output.write(`    location: ${whConfig.bigquery.location}\n`);
          output.write(`    auth:     ${whConfig.bigquery.authType ?? "adc"}\n`);
        }
        if (whConfig.provider === "snowflake" && whConfig.snowflake) {
          output.write(`    account:   ${whConfig.snowflake.account}\n`);
          output.write(`    database:  ${whConfig.snowflake.database}\n`);
          output.write(`    schema:    ${whConfig.snowflake.schema}\n`);
          output.write(`    warehouse: ${whConfig.snowflake.warehouse}\n`);
          output.write(`    auth:      ${whConfig.snowflake.authType}\n`);
        }
      } else {
        output.write(`  ${infoLabel("warehouse")}  ${warnText("not configured -- run set-warehouse --tenant " + tenantId)}\n`);
      }

      const tSlack = slackChannels.filter((m) => m.tenantId === tenantId);
      const tSlackUsers = slackUsers.filter((m) => m.tenantId === tenantId);
      const tSlackTeams = slackSharedTeams.filter((m) => m.tenantId === tenantId);
      const tTelegram = telegramChats.filter((m) => m.tenantId === tenantId);
      const hasChannels = tSlack.length + tSlackUsers.length + tSlackTeams.length + tTelegram.length > 0;

      output.write(`  ${infoLabel("channels")}\n`);
      if (!hasChannels) {
        output.write(`    ${warnText("none mapped")}\n`);
      }
      for (const m of tSlack) {
        output.write(`    slack channel  ${m.channelId}  (${m.source})\n`);
      }
      for (const m of tSlackUsers) {
        output.write(`    slack user     ${m.userId}\n`);
      }
      for (const m of tSlackTeams) {
        output.write(`    slack team     ${m.sharedTeamId}\n`);
      }
      for (const m of tTelegram) {
        output.write(`    telegram chat  ${m.chatId}  (${m.source})\n`);
      }
    }

    output.write("\n");
    const envSlack = env.slackBotToken ? successText("configured") : warnText("not set");
    const envTelegram = env.telegramBotToken ? successText("configured") : warnText("not set");
    const envLlm = env.llmApiKey ? successText(`${env.llmModel}`) : warnText("not set");
    output.write(`${infoLabel("Environment")}\n`);
    output.write(`  LLM:      ${envLlm}\n`);
    output.write(`  Slack:    SLACK_BOT_TOKEN ${envSlack}\n`);
    output.write(`  Telegram: TELEGRAM_BOT_TOKEN ${envTelegram}\n`);
    output.write("\n");
    return;
  }

  output.write(`${usage()}\n`);
  process.exit(1);
}

run().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
