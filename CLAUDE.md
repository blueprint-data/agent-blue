# agent-blue — CLAUDE.md

## Project

Analytics agent platform. Connects AI (LLM) with data warehouses (BigQuery, Snowflake) and dbt repositories. Exposes the agent through multiple channels (Slack, Telegram, Admin UI). The admin UI is a Vite + React 19 SPA for managing conversations, tenants, and configuration.

## Architecture

### Backend (`src/`)

Hexagonal Architecture — strict port/adapter separation:

```
src/
├── core/           ← Domain: agentRuntime, interfaces (ports), types, schedulerService, sqlGuard
├── adapters/       ← Infrastructure: implementations of core ports
│   ├── api/        ← Express admin API
│   ├── channel/    ← Slack, Telegram, Console
│   ├── llm/        ← OpenAI-compatible providers
│   ├── store/      ← SQLite conversation store (via litestream)
│   └── warehouse/  ← BigQuery, Snowflake
├── config/         ← Env config and auth policies
├── bootstrap/      ← Tenant initialization
└── utils/          ← Shared utilities
```

**Direction rule**: `adapters/` → `core/`. The `core/` directory NEVER imports from `adapters/`. Ports live in `core/interfaces.ts`. Adapters implement those ports.

Adding a new warehouse? → implement in `adapters/warehouse/`, add port to `core/interfaces.ts`.
Adding a new channel? → implement in `adapters/channel/`, add port to `core/interfaces.ts`.

### Frontend (`admin-ui/`)

Vite + React 19 SPA with shadcn/ui and Tailwind v4:

```
admin-ui/src/
├── components/     ← Shared components (shadcn in components/ui/)
├── landing/        ← Landing and onboarding flow
├── lib/            ← Utilities (cn, etc.)
├── api.ts          ← API client
└── App.tsx         ← Root component
```

## Commands

| Task | Command |
|------|---------|
| Backend dev | `npm run dev` |
| Frontend dev | `npm run admin:web:dev` |
| Both (API + Web + tunnel) | `npm run admin:dev` |
| Type check | `npm run check` |
| Tests | `npm test` |
| Build | `npm run build` |

## Testing — TDD Strict Mode

**Tests first, ALWAYS.** No implementation without a test. Test files are co-located: `foo.ts` → `foo.test.ts`. Test runner: **Vitest**.

Before writing any implementation:
1. Write the failing test
2. Implement the minimum to make it pass
3. Refactor

Do NOT write implementation first and "add tests later". Push back if the user asks for it.

## Local Testing — Slack Channel

### Node version

The project requires **Node 22**. CI and Docker both use `node:22`. The `.nvmrc` is pinned to `22`.

If `better-sqlite3` fails with a NODE_MODULE_VERSION mismatch, the user must switch Node versions:

```bash
nvm use 22        # switch to Node 22
npm rebuild better-sqlite3   # recompile native binary
```

Do NOT suggest upgrading Node or changing `.nvmrc` — the project is pinned to 22 intentionally.

### Running the Slack server locally

The SQLite DB lives at `data/agent.db` (not `data/agent-blue.db`). It is created automatically on first run.

```bash
# Terminal 1 — Slack server (tenant depends on the .env and channel mapping)
npm run dev -- slack --tenant <tenantId>

# Terminal 2 — public tunnel via ngrok (cloudflared needs credentials not always available locally)
ngrok http 3000
```

The ngrok URL changes on every restart. Update the Slack app's **Event Subscriptions → Request URL** each time:

```
https://<ngrok-url>/slack/events
```

Use the **global endpoint** (`/slack/events`) for local testing — the per-tenant endpoint (`/slack/events/tenants/:tenantId`) requires Slack credentials to be seeded in the local SQLite DB, which is not set up locally.

### Slack app configuration

Managed at **https://api.slack.com/apps** → select the app → configure the sections below.

#### OAuth & Permissions — Bot Token Scopes

| Scope | Required? | Purpose |
|-------|-----------|---------|
| `app_mentions:read` | Yes | Receive @mention events |
| `chat:write` | Yes | Post messages |
| `reactions:write` | Yes | Bot seeds 👍👎 on its own messages |
| `reactions:read` | Yes | Receive `reaction_added` events |
| `channels:history` | Recommended | Read public channel thread context |
| `groups:history` | Recommended | Read private channel thread context |
| `im:history` | Recommended | Read DM thread context |

After adding or removing scopes, Slack requires **reinstalling the app** to the workspace. The button appears at the top of the OAuth & Permissions page.

#### Event Subscriptions

Enable **Event Subscriptions** and set the Request URL:

| Environment | Request URL |
|-------------|-------------|
| Production | `https://agent.blueprintdata.xyz/slack/events` |
| Local (ngrok) | `https://<ngrok-url>/slack/events` |

Always use the **global endpoint** (`/slack/events`). The per-tenant endpoint (`/slack/events/tenants/:tenantId`) requires Slack credentials seeded in the local SQLite DB.

Under **Subscribe to bot events**, add:

| Event | Purpose |
|-------|---------|
| `app_mention` | Trigger agent on @mention |
| `reaction_added` | Capture 👍👎 user feedback |

After changing events, save and verify the URL — Slack sends a `challenge` request to validate.

#### What breaks without each scope

| Missing | Effect |
|---------|--------|
| `reactions:write` | Bot can't seed 👍👎 — warning logged, no crash, feedback capture impossible |
| `reactions:read` / `reaction_added` event | Events never arrive — `message_feedback` table stays empty silently |
| `channels:history` | Bot can't read thread context — still responds but without conversation history |

### Verifying message_feedback

```bash
# Must run with Node 22 active (nvm use 22)
node -e "const db = require('better-sqlite3')('data/agent.db'); console.log(JSON.stringify(db.prepare('SELECT * FROM message_feedback LIMIT 10').all(), null, 2));"
```

### Tenant context in local testing

The local DB starts empty. The global Bolt app (`/slack/events`) resolves the tenant via `SLACK_TEAM_TENANT_MAP` env var or the `--tenant` flag. The warehouse is NOT connected locally — queries will fail with connection errors, which correctly triggers `cannot_answer`.

### Testing cannot_answer

Ask the bot something analytical that requires pre-modeled data not available locally:

> "Dame un análisis de cohorts de los últimos 3 meses"

Expected: bot responds with `cannot_answer` + clear reason. It must NOT burn all 35 tool steps.

## Restrictions — NEVER Without Explicit Approval

- **Schema changes**: Do not modify SQLite schema (migrations, column additions, index changes) without explicit user confirmation
- **Dependencies**: Do not run `npm install` or add packages to `package.json` without user approval — propose the dependency and wait
- **Layer separation**: Do not import `adapters/` from `core/`. Dependency direction is non-negotiable
- **Git push**: Do not push directly to `main`. Always PR

## Skills — Auto-Load by File Context

Read the corresponding skill file BEFORE writing code when you detect any of these contexts. Multiple skills can apply simultaneously.

| Context | Skill file(s) to read |
|---------|----------------------|
| `admin-ui/**/*.tsx`, `admin-ui/**/*.ts` | `skills/blueprint-ui/SKILL.md` |
| `admin-ui/**/components/ui/**` or shadcn components | `skills/shadcn/SKILL.md` + `skills/tailwind-v4-shadcn/SKILL.md` |
| Any Tailwind class usage | `skills/tailwind-css-patterns/SKILL.md` |
| Animations, transitions | `skills/animejs/SKILL.md` |
| Accessibility concerns | `skills/accessibility/SKILL.md` |
| UI layout, visual design decisions | `skills/frontend-design/SKILL.md` |
| React patterns, hooks, component design | `skills/vercel-react-best-practices/SKILL.md` |
| `src/adapters/**`, `src/core/**` | `skills/nodejs-backend-patterns/SKILL.md` + `skills/nodejs-best-practices/SKILL.md` |
| TypeScript types, generics, utility types | `skills/typescript-advanced-types/SKILL.md` |
| Brainstorming, architecture exploration | `skills/brainstorming/SKILL.md` |

Read skills BEFORE writing code. Apply ALL matching patterns.

## Enforcement

Push back hard when:
- Someone asks for code without understanding the architectural layer it belongs to
- A change would cross the `core/` ↔ `adapters/` boundary in the wrong direction
- Implementation starts before tests exist
- A new dependency is introduced without discussion

Explain WHY the architectural constraint exists, not just what it is.
