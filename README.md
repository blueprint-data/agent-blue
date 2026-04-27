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
- `admin-ui` (admin API + built admin SPA)
  - `--port <number>` (default: `ADMIN_PORT` or `3100`)
- `admin-password-hash`
  - `--password <value>` (prints a `scrypt$...` hash for `ADMIN_PASSWORD_HASH`)

## Admin UI

The admin panel is now a **Vite + React** application backed by the Express admin API. It is designed around the main operator flows:

- **Overview**: tenant count, routing health, recent conversations, Slack bot status/events
- **New Tenant**: guided onboarding wizard
- **Tenants**: create/edit/delete tenants, refresh repo, upload Snowflake `.p8`, inspect credential refs
- **Conversations**: browse raw message history and per-turn execution traces (prompt text, SQL/tool-call debug, timings, errors)
- **Slack Bot**: start/stop/restart the embedded Slack bot for local or single-process runs, and inspect persisted bot events
- **Settings**: Slack guardrails plus explicit channel/user/shared-team mappings

### Local development

Run the admin API and Vite frontend together:

```bash
npm run admin:dev
```

- Admin API / session auth: `http://localhost:3100`
- Vite dev home page: `http://localhost:5173/`
- Vite dev admin UI: `http://localhost:5173/admin/`

Landing entry shortcuts:

- `http://localhost:5173/login` → redirects to `/admin/`
- `http://localhost:5173/register` → redirects to `/admin/`

Vite proxies `/api/*` to the admin API, so browser sessions still work with `credentials: include`.

### Production-style local run

Build the frontend and backend assets first:

```bash
npm run build
```

Then start the admin server:

```bash
npm run admin:ui
# or: npm run dev -- admin-ui --port 3100
```

2. Open `http://localhost:3100/` for the public home page.
3. Use the landing CTAs (Book demo / Login), or open `http://localhost:3100/admin` directly, and sign in with configured credentials.

### Single-VPS deployment (Hetzner + Docker Compose)

This repo now includes a direct VPS deployment path without Cloudflare Tunnel.

The production topology is:

- `proxy`: Caddy on ports `80/443`, terminates TLS for `agent.blueprintdata.xyz`
- `admin`: Express admin API + built admin SPA on internal port `3100`
- `slack`: always-on Slack Events API service on internal port `3000`
- `data/`: local persistent filesystem storage shared by `admin` and `slack`

Routing is path-based on the same hostname:

- `/slack/events` and `/slack/events/tenants/*` -> `slack`
- all other paths (`/`, `/login`, `/register`, `/admin`, `/api/admin/*`, etc.) -> `admin`

Before starting the stack:

1. Point the DNS `A`/`AAAA` record for `agent.blueprintdata.xyz` to the VPS.
2. Copy the deployment env template:

```bash
cp .env.deploy.example .env.deploy
```

3. Generate a browser-login password hash:

```bash
npm run dev -- admin-password-hash --password "choose-a-strong-password"
```

4. Set at least these values in `.env.deploy`:

- `LLM_API_KEY`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH`
- `ADMIN_SESSION_SECRET`

`ADMIN_SESSION_SECRET` must stay stable across restarts or browser sessions will be invalidated.
If `ADMIN_PASSWORD_HASH` contains `$` characters, wrap the value in single quotes inside `.env.deploy`.

Start the stack:

```bash
docker compose build
docker compose up -d
```

Open the home page at:

`https://agent.blueprintdata.xyz/`

Public entry shortcuts:

- `https://agent.blueprintdata.xyz/login` → `/admin/`
- `https://agent.blueprintdata.xyz/register` → `/admin/`

Open the admin UI at:

`https://agent.blueprintdata.xyz/admin`

Point Slack Event Subscriptions to:

- Global Slack app: `https://agent.blueprintdata.xyz/slack/events`
- Per-tenant Slack apps: `https://agent.blueprintdata.xyz/slack/events/tenants/<tenantId>`

Persistence is filesystem-backed through `./data` on the VPS. This directory stores:

- `agent.db`
- generated deploy keys
- uploaded Snowflake keys
- cloned tenant dbt repositories

Notes for this deployment mode:

- `admin` and `slack` intentionally share the same `APP_DATA_DIR`, so keep it on the VPS local filesystem and do not move it to a network filesystem.
- In this compose setup, Slack runs as its own always-on service. The Admin UI Slack Bot controls are still useful for embedded/local mode, but normal VPS lifecycle should be managed with `docker compose`, not the UI bot buttons.
- The legacy `cloudflared-agent-blue.yml` file is not used by this deployment path.

Post-deploy verification checklist:

1. Open `https://agent.blueprintdata.xyz/` and confirm the home page loads, then go to `/admin` and confirm the login page loads.
2. Log in and confirm `GET /api/admin/auth/session` reports an authenticated session through the UI.
3. Create or load a tenant, then verify repo refresh and warehouse test succeed.
4. Confirm the VPS `data/` directory now contains `agent.db`, tenant keys, and repo clones as you use the app.
5. Trigger a Slack event and confirm the request reaches `/slack/events`, the response shows up in Slack, and the conversation appears in the Admin UI.

### Sandbox / lower environment

For a dedicated lower environment, use the sandbox stack files included in this repo:

- `docker-compose.sandbox.yml`
- `Caddyfile.sandbox`
- `.env.sandbox.example`
- `.github/workflows/deploy-sandbox.yml` (manual deploy)

Quick start:

```bash
cp .env.sandbox.example .env.sandbox
docker compose --env-file .env.sandbox -f docker-compose.sandbox.yml up -d --build
```

Fast local shortcut (reuse your existing `.env` values):

```bash
AGENT_BLUE_ENV_FILE=.env SANDBOX_DOMAIN=localhost SANDBOX_HTTP_PORT=8080 SANDBOX_HTTPS_PORT=8443 \
docker compose --env-file .env -f docker-compose.sandbox.yml up -d --build proxy admin slack
```

Then open `https://localhost:8443/admin/`.
Add `telegram` to the service list only if `TELEGRAM_BOT_TOKEN` is configured.

Recommended: run sandbox on a separate VPS with a dedicated subdomain (for example `sandbox.agent.blueprintdata.xyz`).
If you must share host with production, set `SANDBOX_HTTP_PORT` / `SANDBOX_HTTPS_PORT` to non-conflicting ports and front it with an upstream proxy.

Full setup guide:

- [`docs/SANDBOX_ENVIRONMENT.md`](docs/SANDBOX_ENVIRONMENT.md)
- [`docs/ENVIRONMENTS.md`](docs/ENVIRONMENTS.md)

### Authentication

Browser login uses **server-managed sessions**:

- `POST /api/admin/auth/login`
- `GET /api/admin/auth/session`
- `POST /api/admin/auth/logout`

Recommended env configuration:

```bash
npm run dev -- admin-password-hash --password "choose-a-strong-password"
```

Then set:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH`
- `ADMIN_SESSION_SECRET`

Optional API-only auth remains available for scripts/non-browser clients:

- `ADMIN_BEARER_TOKEN` / `ADMIN_UI_TOKEN`
- `ADMIN_BASIC_USER` + `ADMIN_BASIC_PASSWORD`

The browser UI no longer fetches or stores a bearer token. Do not expose the admin server publicly without TLS and proper access control (VPN, firewall, private ingress, etc.).

### Integration tokens (tenant-scoped repo refresh automation)

Use tenant-scoped integration tokens (generated in Admin UI) to trigger refresh from external CI/CD pipelines.

📘 Full guide (generation, GitHub Action setup, status handling, security, troubleshooting):

- [`docs/REPO_REFRESH_INTEGRATION.md`](docs/REPO_REFRESH_INTEGRATION.md)

### Operator validation (auth, upload, repo refresh)

After deploying, verify:

1. **Auth**: Start the admin server, open `/admin`, and confirm that unauthenticated API requests to `/api/admin/tenants` return `401`. Log in through the UI and confirm the session unlocks the app.
2. **.p8 upload**: In the Tenants page, click "Upload .p8" for a tenant. Select a valid Snowflake `.p8` key file. Expect success message; tenant metadata should show the uploaded key path. No raw key content in API responses or SQLite.
3. **Repo refresh**: In the Tenants page, click "Refresh selected tenant repo" for a tenant with a configured dbt repo. Expect `Repo refreshed. N dbt models found.` or a clear error (for example, deploy key not added).
4. **Conversations**: Seed or trigger a conversation and confirm the Conversations page shows the raw user text plus stored execution trace details.
5. **Slack delivery**: Confirm the `slack` compose service is up, trigger a Slack event against `https://agent.blueprintdata.xyz/slack/events`, and verify the conversation and any bot activity appear in the Admin UI.

If you are running the embedded/local admin-supervised bot instead of the compose `slack` service, you can still use the Slack Bot page to test start/stop/restart behavior.

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
