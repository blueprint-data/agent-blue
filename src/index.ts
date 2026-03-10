import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { buildLlmProvider, buildRuntime, buildSnowflakeWarehouse, buildStore } from "./app.js";
import { initializeTenant } from "./bootstrap/initTenant.js";
import { GitDbtRepositoryService } from "./adapters/dbt/dbtRepoService.js";
import { parseSlackTeamTenantMap, startSlackAgentServer } from "./adapters/channel/slack/slackAgentServer.js";
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

const e2eQuestions = [
  "How many users do we have in total?",
  "How many were created last month?",
  "From those, how many made a transaction since?",
  "Can you provide a bar chart by signup month for the last 6 months and summarize the trend?"
];

interface E2eTurnMetrics {
  plannerAttempts: number;
  totalMs: number | null;
  snowflakeOk: number;
  snowflakeErrors: number;
  fallback: boolean;
}

function parseE2eTurnMetrics(text: string, debug: Record<string, unknown> | undefined): E2eTurnMetrics {
  const plannerAttemptsRaw = debug?.plannerAttempts;
  const plannerAttempts = Array.isArray(plannerAttemptsRaw) ? plannerAttemptsRaw.length : 0;

  const timingsRaw = debug?.timings as Record<string, unknown> | undefined;
  const totalMsValue = timingsRaw?.totalMs;
  const totalMs = typeof totalMsValue === "number" ? totalMsValue : null;

  const toolCallsRaw = debug?.toolCalls;
  const toolCalls = Array.isArray(toolCallsRaw) ? toolCallsRaw : [];
  let snowflakeOk = 0;
  let snowflakeErrors = 0;
  for (const call of toolCalls) {
    const entry = call as { tool?: unknown; status?: unknown };
    if (entry.tool !== "snowflake.query") {
      continue;
    }
    if (entry.status === "ok") {
      snowflakeOk += 1;
    } else if (entry.status === "error") {
      snowflakeErrors += 1;
    }
  }

  return {
    plannerAttempts,
    totalMs,
    snowflakeOk,
    snowflakeErrors,
    fallback: text.includes("I could not reach a reliable final answer")
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

function usage(): string {
  return [
    "Usage:",
    "  npm run dev -- init --tenant <id> --repo-url <git@...> [--dbt-subpath models] [--force]",
    "  npm run dev -- sync-dbt --tenant <id>",
    "  npm run dev -- e2e-loop --tenant <id> [--profile default] [--model <provider/model>] [--models <m1,m2>] [--runs 1] [--verbose]",
    "  npm run dev -- prod-smoke --tenant <id> [--model <provider/model>]",
    "  npm run dev -- chat --tenant <id> [--profile default] [--conversation <id>] [--message \"...\"] [--verbose] [--model <provider/model>]",
    "  npm run dev -- slack [--tenant <id>] [--profile default] [--port 3000] [--model <provider/model>]",
    "  npm run dev -- slack-map-channel --channel <C...> --tenant <id>",
    "  npm run dev -- slack-map-user --user <U...> --tenant <id>",
    "  npm run dev -- slack-map-shared-team --team <T...> --tenant <id>",
    "  npm run dev -- slack-map-list",
    "  npm run dev -- slack-map-validate",
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

  if (command === "e2e-loop") {
    const runtime = buildRuntime(store);
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
    const runsRaw = typeof args.runs === "string" ? Number.parseInt(args.runs, 10) : 1;
    const runs = Number.isFinite(runsRaw) && runsRaw > 0 ? runsRaw : 1;

    output.write(
      `${infoLabel("E2E loop started.")} tenant=${tenantId} profile=${profileName} runs=${runs} models=${models.join(", ")}\n`
    );

    for (const llmModel of models) {
      output.write(`\n${paint(`=== Model: ${llmModel} ===`, 35)}\n`);
      const modelMetrics: E2eTurnMetrics[] = [];
      for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
        const conversationId = createId("e2e");
        output.write(`${infoLabel(`[run ${runIndex}/${runs}]`)} conversation=${conversationId}\n`);

        for (let questionIndex = 0; questionIndex < e2eQuestions.length; questionIndex += 1) {
          const question = e2eQuestions[questionIndex];
          output.write(`${warnText(`Q${questionIndex + 1}:`)} ${question}\n`);
          try {
            const response = await runtime.respond(
              { tenantId, profileName, conversationId, llmModel, origin: { source: "cli" } },
              question
            );
            const metrics = parseE2eTurnMetrics(response.text, response.debug);
            modelMetrics.push(metrics);

            output.write(`${successText("A:")} ${response.text}\n`);
            printArtifacts(response.artifacts);
            output.write(
              `${infoLabel("[metrics]")} attempts=${metrics.plannerAttempts} totalMs=${
                metrics.totalMs ?? "n/a"
              } snowflake.ok=${metrics.snowflakeOk} snowflake.error=${metrics.snowflakeErrors} fallback=${metrics.fallback}\n`
            );
            if (verbose) {
              printVerboseDebug(response.debug);
            }
            output.write("\n");
          } catch (error) {
            output.write(`${errorText(`Error: ${(error as Error).message}`)}\n\n`);
            modelMetrics.push({
              plannerAttempts: 0,
              totalMs: null,
              snowflakeOk: 0,
              snowflakeErrors: 0,
              fallback: true
            });
          }
        }
      }

      const totalTurns = modelMetrics.length;
      const fallbackTurns = modelMetrics.filter((metric) => metric.fallback).length;
      const avgAttempts =
        totalTurns === 0
          ? 0
          : modelMetrics.reduce((acc, metric) => acc + metric.plannerAttempts, 0) / totalTurns;
      const avgTotalMs =
        totalTurns === 0
          ? 0
          : modelMetrics.reduce((acc, metric) => acc + (metric.totalMs ?? 0), 0) / totalTurns;
      const totalSnowflakeOk = modelMetrics.reduce((acc, metric) => acc + metric.snowflakeOk, 0);
      const totalSnowflakeErrors = modelMetrics.reduce((acc, metric) => acc + metric.snowflakeErrors, 0);

      output.write(`${paint("Model summary", 36)}\n`);
      output.write(`  - turns=${totalTurns}\n`);
      output.write(`  - fallbackTurns=${fallbackTurns}\n`);
      output.write(`  - avgPlannerAttempts=${avgAttempts.toFixed(2)}\n`);
      output.write(`  - avgTotalMs=${Math.round(avgTotalMs)}\n`);
      output.write(`  - snowflakeOk=${totalSnowflakeOk}\n`);
      output.write(`  - snowflakeErrors=${totalSnowflakeErrors}\n`);
    }
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
    output.write(`   LLM response: ${llmResult.slice(0, 200)}\n`);

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
    const llmModel = typeof args.model === "string" ? args.model : env.llmModel;
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

  output.write(`${usage()}\n`);
  process.exit(1);
}

run().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
