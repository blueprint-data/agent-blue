# Slack integration plan and SDK choice

## Recommendation

For your current stage, use **Slack Bolt** now, keep your runtime/channel abstractions, and optionally evaluate `chat-sdk.dev` in a parallel branch once you add a web channel.

Why:

- Bolt is the official Slack SDK with mature event semantics and production guidance.
- Your current code already has a transport abstraction (`ChannelAdapter`) and central runtime; Bolt plugs in cleanly.
- You need predictable control over multi-tenant routing, auth, and guardrails for analytics queries.

## Is chat-sdk.dev a good alternative?

`chat-sdk.dev` is a credible option, especially if you want a **single framework for many chat platforms** (Slack, GitHub, etc.) and streaming UX out of the box.

### Quick decision matrix

| Criteria | Slack Bolt | chat-sdk.dev |
|---|---|---|
| Slack reliability/maturity | Strong (official) | Good, but extra abstraction layer |
| Multi-platform adapters | Limited (Slack-first) | Strong |
| Control over internals | Maximum | Medium |
| Time-to-first Slack bot | Fast | Fast |
| Vendor/framework lock-in risk | Lower | Higher |
| Fit for current repo architecture | Excellent | Good |

## Proposed phased rollout

### Phase 1 (now): Slack MVP on Bolt

- Event handlers:
  - `app_mention` in channels
  - DM `message` events
- Thread-aware memory:
  - map `team_id + channel_id + thread_ts -> conversation_id`
- Tenant routing:
  - `SLACK_DEFAULT_TENANT_ID` for single workspace
  - `SLACK_TEAM_TENANT_MAP` for multi-workspace
- Response behavior:
  - immediate “working…” message
  - post final answer in same thread

### Phase 2: Production hardening

- Add async queue worker for long-running queries.
- Add request signature + replay-protection tests.
- Add robust retries and user-friendly transient-failure messages.
- Add structured logs and trace IDs for Slack events and SQL runs.

### Phase 3: Multi-channel strategy checkpoint

When you add web + another chat platform, re-evaluate:

- If you want one unified chat framework quickly, pilot `chat-sdk.dev`.
- If you need strict platform-level control and long-lived stability, keep Bolt (and add web API separately).

## Docker/cloud deployment notes for Slack

- Expose HTTP endpoint for Slack events (default: `/slack/events`).
- Use a public HTTPS URL (ALB/API gateway/ingress).
- Store secrets in cloud secret manager, not `.env`.
- Keep app stateless; use Postgres + queue for durability.
