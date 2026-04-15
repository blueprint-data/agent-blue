import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { SqliteConversationStore } from "../adapters/store/sqliteConversationStore.js";
import { GitDbtRepositoryService } from "../adapters/dbt/dbtRepoService.js";
import {
  LlmProvider,
  TenantWarehouseProvider,
  WarehouseAdapter,
} from "../core/interfaces.js";
import { env } from "../config/env.js";
import { createReadline, log, logStep, ui } from "./prompt.js";
import { generateSystemPrompt } from "./systemPrompt.js";
import {
  collectTenantSummaryInput,
  generateTenantSummary,
} from "./tenantSummary.js";
import { selectModels } from "./modelSelection.js";
import { generateModelContextFiles } from "./modelContext.js";
import {
  collectMetrics,
  generateMetricsContextFiles,
} from "./metricsContext.js";

export interface ContextInitDeps {
  store: SqliteConversationStore;
  llm: LlmProvider;
  warehouseResolver: (tenantId: string) => WarehouseAdapter;
}

function resolveWarehouseInfo(
  store: SqliteConversationStore,
  tenantId: string,
  warehouse: WarehouseAdapter
): { database: string; schema: string; provider: TenantWarehouseProvider } {
  const config = store.getTenantWarehouseConfig(tenantId);
  const provider: TenantWarehouseProvider =
    warehouse.provider ?? config?.provider ?? "snowflake";
  const isBigQuery = provider === "bigquery";

  const database = isBigQuery
    ? (config?.bigquery?.projectId?.trim() ?? env.bigqueryProjectId ?? "")
    : (config?.snowflake?.database?.trim() ?? env.snowflakeDatabase ?? "");

  const schema = isBigQuery
    ? (config?.bigquery?.dataset?.trim() ?? env.bigqueryDataset ?? "")
    : (config?.snowflake?.schema?.trim() ?? env.snowflakeSchema ?? "");

  return { database, schema, provider };
}

export async function runContextInit(
  tenantId: string,
  deps: ContextInitDeps
): Promise<void> {
  const { store, llm, warehouseResolver } = deps;
  const llmModel = env.llmModel;
  const totalSteps = 5;

  const contextDir = path.join(env.appDataDir, "context", tenantId);

  log(`\n${ui.bold("Context Initialization")} for tenant ${ui.magenta(tenantId)}`);
  log(`${ui.dim(`Output: ${contextDir}/`)}\n`);

  const repo = store.getTenantRepo(tenantId);
  if (!repo) {
    log(
      ui.error(
        `Tenant "${tenantId}" not found. Run: npm run dev -- init --tenant ${tenantId} --repo-url <url>`
      )
    );
    process.exit(1);
  }

  fs.mkdirSync(contextDir, { recursive: true });

  const rl = createReadline();

  try {
    // Step 1: System prompt
    logStep(1, totalSteps, "System Prompt");
    generateSystemPrompt(contextDir);

    // Step 2: Tenant summary
    logStep(2, totalSteps, "Tenant Summary");
    const summaryInput = await collectTenantSummaryInput(rl);
    await generateTenantSummary(
      contextDir,
      summaryInput,
      tenantId,
      llm,
      llmModel
    );

    // Step 3: Model selection
    logStep(3, totalSteps, "Model Selection");
    const dbt = new GitDbtRepositoryService(store);
    const selectedModels = await selectModels(rl, dbt, tenantId);

    if (selectedModels.length > 0) {
      // Step 4: Model context generation
      logStep(4, totalSteps, "Model Context Generation");
      let warehouse: WarehouseAdapter;
      try {
        warehouse = warehouseResolver(tenantId);
      } catch (error) {
        log(
          ui.error(
            `Cannot connect to warehouse: ${(error as Error).message}`
          )
        );
        log(
          ui.warn(
            "Skipping model profiling. Run set-warehouse first and re-run context."
          )
        );
        logStep(5, totalSteps, "Metrics");
        log(`  ${ui.warn("Skipped — no warehouse connection.")}`);
        return;
      }

      const { database, schema, provider } = resolveWarehouseInfo(
        store,
        tenantId,
        warehouse
      );

      await generateModelContextFiles(
        contextDir,
        selectedModels,
        dbt,
        tenantId,
        warehouse,
        database,
        schema,
        provider,
        llm,
        llmModel
      );

      // Step 5: Metrics
      logStep(5, totalSteps, "Metrics");
      const metrics = await collectMetrics(rl);
      await generateMetricsContextFiles(
        contextDir,
        metrics,
        selectedModels,
        database,
        schema,
        provider,
        warehouse,
        llm,
        llmModel
      );
    } else {
      logStep(4, totalSteps, "Model Context Generation");
      log(`  ${ui.dim("Skipped — no models selected.")}`);
      logStep(5, totalSteps, "Metrics");
      log(`  ${ui.dim("Skipped — no models for metric context.")}`);
    }

    log(`\n${ui.success("Context initialization complete!")}`);
    log(`${ui.dim(`Files written to: ${contextDir}/`)}`);
    log(
      `${ui.dim("  system_prompt.md, tenant_summary.md, models/*.md, metrics/*.md")}`
    );
  } finally {
    rl.close();
  }
}
