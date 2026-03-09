# agent-blue

Analytics agent foundation for company questions over Snowflake + dbt metadata, with pluggable model providers and channel adapters.

## Why this structure

This repo is built around interfaces so you can swap:

- **LLM provider** (OpenRouter, Vercel AI Gateway, direct providers)
- **Channel transport** (CLI now, Slack/Web UI later)
- **Warehouse adapter** (Snowflake now, BigQuery next)
- **Memory store** (SQLite now, PostgreSQL later)

Core orchestration lives in one place (`AnalyticsAgentRuntime`) and depends on interfaces, not implementations.

## Current capabilities

- Tenant bootstrap process:
  - Generates and persists an **ed25519 deploy keypair**.
  - Stores tenant repo config in SQLite.
  - Prints the public key so users can add it as a GitHub Deploy Key.
- dbt repo integration:
  - Clone/pull using tenant deploy key.
  - List models and inspect model SQL files.
- Snowflake integration:
  - Executes read-only SQL through an adapter.
  - SQL guard to enforce SELECT/WITH-only and row limits.
  - Agent can inspect warehouse metadata (schemas/tables/columns) when relation names are unclear.
- Chart tool integration:
  - Agent can build Chart.js-compatible JSON configs from query results.
  - Output is channel-agnostic so UI/PNG/ASCII rendering can be added independently.
- Conversation memory:
  - SQLite store for conversations/messages/profiles/repo config.
- Agent profile abstraction (“souls”):
  - Per-tenant profile with system prompt and query row limits.

## Project layout

```txt
src/
  core/                 # interfaces + runtime + sql guard
  adapters/
    chart/              # chart config builder adapters
    llm/                # model provider adapters
    warehouse/          # snowflake/bigquery adapters
    dbt/                # git dbt repo service
    store/              # sqlite persistence
    channel/            # transport adapters
  bootstrap/            # tenant setup / key generation
  config/               # env config
  utils/                # shared helpers
```

## Quick start

1. Install deps

```bash
npm install
```

2. Configure env

```bash
cp .env.example .env
# then fill values
```

Snowflake auth can be either:

- `SNOWFLAKE_AUTH_TYPE=password` + `SNOWFLAKE_PASSWORD`
- `SNOWFLAKE_AUTH_TYPE=keypair` + `SNOWFLAKE_PRIVATE_KEY_PATH` (and optional `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE`)

Slack server requires:

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- one of:
  - `SLACK_DEFAULT_TENANT_ID` (single-tenant workspace), or
  - `SLACK_TEAM_TENANT_MAP` (JSON map for multi-workspace, e.g. `{"T123":"acme"}`)
  - channel/user/shared-team mappings via `slack-map-channel`, `slack-map-user`, `slack-map-shared-team`

For multi-tenant shared channels (one bot across many orgs):

- `SLACK_OWNER_TEAM_IDS` (comma list of workspace IDs for owner org; only owner can use default tenant)
- `SLACK_OWNER_ENTERPRISE_IDS` (comma list of enterprise IDs for org grid)
- `SLACK_STRICT_TENANT_ROUTING=false` (set to `true` to require explicit mappings for non-owner contexts)

3. Initialize tenant + repo (creates keys and stores config)

```bash
npm run dev -- init --tenant acme --repo-url git@github.com:your-org/your-dbt.git --dbt-subpath models
```

4. Add printed public key to GitHub repo as Deploy Key (read-only is enough).

5. Sync dbt repo

```bash
npm run dev -- sync-dbt --tenant acme
```

6. Chat

```bash
npm run dev -- chat --tenant acme
```

Optional model override (instead of `LLM_MODEL` from `.env`):

```bash
npm run dev -- chat --tenant acme --model openai/gpt-4o-mini
```

One-shot chat:

```bash
npm run dev -- chat --tenant acme --message "How many orders did we have yesterday?"
```

Verbose chat/debug mode (prints planner attempts, SQL, tool calls, full tool outputs/errors, and timings):

```bash
npm run dev -- chat --tenant acme --verbose
```

When run in a TTY, chat output uses colors to distinguish answers, debug logs, and errors.

You can also enable verbosity by default with:

```bash
AGENT_VERBOSE=true
```

7. Run E2E loop scenario (for agent-loop debugging + model comparison)

Runs these 3 prompts in sequence in the same conversation:

1) "How many users do we have in total?"  
2) "How many were created last month?"  
3) "From those, how many made a transaction since?"

```bash
npm run dev -- e2e-loop --tenant acme
```

Run against multiple models in one go:

```bash
npm run dev -- e2e-loop --tenant acme --models "openai/gpt-4o-mini,openai/gpt-4.1-mini" --runs 2
```

8. Run Slack server (Events API)

```bash
npm run dev -- slack --tenant acme --profile default --port 3000
```

Then point your Slack app Event Subscriptions URL to:

`https://<your-host>/slack/events`

## Commands

- `init`
  - `--tenant <id>`
  - `--repo-url <git@github.com:...>`
  - `--dbt-subpath <path>` (default: `models`)
  - `--force` (regenerate keypair)
- `sync-dbt`
  - `--tenant <id>`
- `prod-smoke`
  - `--tenant <id>`
  - `--model <provider/model>` (optional; defaults to `LLM_MODEL`)
- `e2e-loop`
  - `--tenant <id>`
  - `--profile <name>` (default: `default`)
  - `--model <provider/model>` (optional; single model override)
  - `--models <m1,m2,...>` (optional; run the scenario for multiple models)
  - `--runs <n>` (optional; default `1`)
  - `--verbose` (optional; also prints full debug payload per turn)
- `chat`
  - `--tenant <id>`
  - `--profile <name>` (default: `default`)
  - `--conversation <id>` (optional)
  - `--message "<text>"` (optional, non-interactive)
  - `--verbose` (optional; prints debug payload and timings)
  - `--model <provider/model>` (optional; defaults to `LLM_MODEL`)
- `slack`
  - `--tenant <id>` (optional if `SLACK_DEFAULT_TENANT_ID` is set)
  - `--profile <name>` (default: `default`)
  - `--port <number>` (default: `SLACK_PORT` or `3000`)
  - `--model <provider/model>` (optional; defaults to `LLM_MODEL`)
- `slack-map-channel` (map shared channel to tenant)
  - `--channel <C...>` (Slack channel ID)
  - `--tenant <id>`
- `slack-map-user` (map user to tenant for DMs)
  - `--user <U...>` (Slack user ID)
  - `--tenant <id>`
- `slack-map-shared-team` (map shared workspace/org to tenant)
  - `--team <T...>` (Slack team ID from shared channel)
  - `--tenant <id>`
- `slack-map-list` (list all channel/user/shared-team mappings)
- `slack-map-validate` (check that all mapped tenants have dbt repos configured)
- `admin-ui` (admin-only web UI for tenants, Slack mappings, guardrails, credential refs)
  - `--port <number>` (default: `ADMIN_PORT` or `3100`)

## Admin UI

An admin-only web UI lets you manage tenants, Slack mappings, guardrails, and credential references without using the CLI.

1. Start the admin server:

```bash
npm run admin:ui
# or: npm run dev -- admin-ui --port 3100
```

2. Open `http://localhost:3100/admin` in a browser.
3. Use the tabs to:
   - **New Tenant Wizard**: Step-by-step onboarding for a new tenant. Complete each step in order: (1) tenant basics + init, (2) verify repo access, (3) configure per-tenant warehouse (Snowflake), (4) test warehouse connectivity, (5) add Slack mappings, (6) final validation. Per-tenant warehouse config overrides env when present.
   - **Tenants**: Create, edit, delete tenants and their dbt repo config. Per tenant: "Upload .p8" for Snowflake keypair auth, "Refresh repo" for `git pull --ff-only`.
   - **Slack Mappings**: Add/remove channel, user, and shared-team mappings to tenants.
   - **Guardrails**: Configure owner team/enterprise IDs, strict tenant routing, default tenant, and team→tenant map. Persisted guardrails override env vars when the Slack server starts.
   - **Credentials**: View credential reference metadata (paths and warehouse metadata only; no raw secrets).

The admin server runs on a separate port from the Slack server. **Authentication:** When any of `ADMIN_UI_TOKEN`, `ADMIN_BEARER_TOKEN`, or `ADMIN_BASIC_USER`+`ADMIN_BASIC_PASSWORD` are set, all admin API routes require auth. The UI fetches `/admin/config` on load and auto-attaches the Bearer token when `ADMIN_UI_TOKEN` (or `ADMIN_BEARER_TOKEN`) is set. Use Basic Auth or Bearer for programmatic access. Do not expose the admin server publicly without TLS and proper access control (e.g. firewall, VPN).

### Operator validation (auth, upload, repo refresh)

After deploying, verify:

1. **Auth**: Set `ADMIN_UI_TOKEN` (or `ADMIN_BEARER_TOKEN`) in `.env`. Start admin server, open `/admin`. Header should show "Authenticated". Unauthenticated requests to `/admin/tenants` should return 401.
2. **.p8 upload**: In Tenants tab, click "Upload .p8" for a tenant. Select a valid Snowflake `.p8` key file. Expect success message; Credentials tab should show the key path. No raw key content in API response or SQLite.
3. **Repo refresh**: In Tenants tab, click "Refresh repo" for a tenant with a configured dbt repo. Expect "Repo refreshed. N dbt models found." or a clear error (e.g. deploy key not added).

### New Tenant Wizard flow

1. **Tenant basics**: Enter tenant ID, repo URL, dbt subpath, warehouse provider. Click "Initialize tenant" to create keys and repo config. Copy the public key and add it as a GitHub Deploy Key (read-only).
2. **Verify repo**: Click "Verify repo" to run `sync-dbt` and confirm access.
3. **Configure warehouse**: Enter Snowflake connection fields (account, username, warehouse, database, schema, role). For keypair auth, set private key path. For password auth, set the env var name (e.g. `SNOWFLAKE_PASSWORD` or a tenant-specific var like `TENANT_ACME_SNOWFLAKE_PASSWORD`).
4. **Test warehouse**: Click "Test connectivity" to run a lightweight query.
5. **Slack mappings**: Add channel IDs, user IDs, and/or shared team IDs. Click "Save Slack mappings".
6. **Final validation**: Click "Run final checks" to verify repo, warehouse, and Slack mappings. Copy the launch command when ready.

## What you were missing (important for production)

1. **Authorization model**
   - Per-tenant isolation for keys, repo paths, warehouse credentials.
   - Per-agent profile ACLs (allowed dbt folders/models + max query scope).
2. **Guardrails beyond SQL read-only**
   - PII policies (masking/redaction rules).
   - Query cost/time budgets and cancellation.
   - Denylist/allowlist for schemas/tables.
3. **Prompt-injection defenses**
   - Treat dbt docs/SQL as untrusted input.
   - System-level tool rules must not be overridable by user/dbt content.
4. **Observability**
   - Structured logs for prompts/tool calls/query durations/errors.
   - Trace IDs per conversation turn.
5. **Evaluation harness**
   - Golden analytics questions + expected SQL/result characteristics.
   - Regression tests for planner decisions and SQL safety.
6. **Async execution model**
   - Some analytical queries are long-running; use job polling and partial updates in Slack/Web UI.
7. **Secrets and key management**
   - Move from local env vars/files to managed secrets/KMS for production.
8. **Schema/semantic abstraction**
   - Add semantic layer or curated metrics catalog so answers are stable and business-safe.
9. **Transport contracts**
   - Normalize message/thread semantics across Slack/Web to avoid agent logic leaks into channels.
10. **Versioned prompts (“souls”)**
   - Keep profile prompts versioned and auditable; allow safe rollout/rollback.

## Next recommended implementation steps

1. Add Slack adapter implementing `ChannelAdapter`.
2. Add HTTP API for web UI using the same runtime.
3. Add BigQuery adapter.
4. Add PostgreSQL store adapter.
5. Add policy engine:
   - table/schema allowlists
   - profile-specific model visibility
   - PII redaction pipeline
