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
