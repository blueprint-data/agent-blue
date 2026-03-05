import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { buildLlmProvider, buildRuntime, buildSnowflakeWarehouse, buildStore } from "./app.js";
import { initializeTenant } from "./bootstrap/initTenant.js";
import { GitDbtRepositoryService } from "./adapters/dbt/dbtRepoService.js";
import { createId } from "./utils/id.js";
import { getStringArg, parseArgs } from "./utils/args.js";
import { env } from "./config/env.js";

function usage(): string {
  return [
    "Usage:",
    "  npm run dev -- init --tenant <id> --repo-url <git@...> [--dbt-subpath models] [--force]",
    "  npm run dev -- sync-dbt --tenant <id>",
    "  npm run dev -- prod-smoke --tenant <id>",
    "  npm run dev -- chat --tenant <id> [--profile default] [--conversation <id>] [--message \"...\"]"
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

    if (oneShotMessage) {
      const response = await runtime.respond({ tenantId, profileName, conversationId }, oneShotMessage);
      output.write(`${response.text}\n`);
      return;
    }

    output.write(`Chat started. tenant=${tenantId} profile=${profileName} conversation=${conversationId}\n`);
    output.write('Type "exit" to quit.\n');

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
        const response = await runtime.respond({ tenantId, profileName, conversationId }, message);
        output.write(`\n${response.text}\n\n`);
      } catch (error) {
        output.write(`\nError: ${(error as Error).message}\n\n`);
      }
    }
    rl.close();
    return;
  }

  if (command === "prod-smoke") {
    const tenantId = getStringArg(args, "tenant");
    const dbt = new GitDbtRepositoryService(store);
    const llm = buildLlmProvider();
    const warehouse = buildSnowflakeWarehouse();

    output.write("Running production smoke checks...\n");

    output.write("1/3 LLM connectivity...\n");
    const llmResult = await llm.generateText({
      model: env.llmModel,
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

  output.write(`${usage()}\n`);
  process.exit(1);
}

run().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
