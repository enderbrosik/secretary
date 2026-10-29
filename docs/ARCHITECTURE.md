# Architecture

## Overview

```
 ┌──────────── apps/web (React SPA) ────────────┐       ┌─ apps/desktop (Tauri 2) ─────────────┐
 │ Today · Tasks · Calendar · Inbox · Reviews … │◀─────▶│ same SPA in a native webview          │
 └───────────────┬──────────────────────────────┘       │ tray / quick view / global shortcut   │
                 │ HTTPS (cookie+CSRF, or bearer)       │ OS keychain for session + master key  │
                 ▼                                      │ local mode: spawns bundled server ───┐│
 ┌──────────── apps/server (Fastify) ───────────┐       └──────────────────────────────────────┘│
 │ auth · settings · AI (BYOK) · integrations   │◀──────────────────────────────────────────────┘
 │ sync · briefing · review · assistant         │
 │ approvals (pending actions) · notifications  │──▶ OpenAI / Anthropic (user's key)
 │ job scheduler + worker (durable, idempotent) │──▶ Google / Microsoft Graph / Slack / Todoist
 └───────────────┬──────────────────────────────┘
                 ▼
     PostgreSQL 16  (or PGlite embedded Postgres for local/single-user)
```

Core business logic lives in `packages/core`, which is pure TypeScript with no I/O. The desktop shell knows nothing about the domain. It only hosts the UI, stores secrets and optionally runs the server.

## Key decisions and trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| **One React SPA for web and desktop** | One UI codebase. The desktop app is a thin native shell. | Desktop-only affordances go through a small bridge (`apps/web/src/lib/platform.ts`). |
| **Tauri 2 over Electron** | Small native shell, OS webview, Rust-side keychain access, a strict capability-based permission model. | Uses each OS's webview, so rendering differs slightly by platform. Installers must be built on each OS (CI matrix). |
| **Fastify + Drizzle** | Fast and typed. Drizzle runs on both PostgreSQL and **PGlite**, so the same schema and migrations serve hosted and fully local modes. | PGlite is single-connection. It's fine for one user, not for multi-tenant hosting. |
| **Own durable job queue in Postgres** instead of Redis/pg-boss | Works on Postgres and PGlite alike. `FOR UPDATE SKIP LOCKED` allows multiple workers. Idempotency keys stop duplicates. | Fewer features than a dedicated queue (no priorities or cron UI), which aren't needed here. |
| **Deterministic layer first, AI second** | Deadlines, conflicts, free time, ranking and unanswered threads are computed in code, so they are always correct and always available. The AI adds interpretation. | The AI can't "notice" things outside the selected context. That's intended. |
| **Official SDKs for AI** (`openai`, `@anthropic-ai/sdk`) | Supported APIs, typed errors, retries. | SDK credential auto-discovery is explicitly disabled so the server only ever uses the user's own key. |
| **Raw `fetch` for Google/Graph/Slack/Todoist** | Small surface, easy to mock, no heavyweight client libraries. | We maintain request/response mappings ourselves (covered by tests). |

## Data flow: morning briefing

1. **Sync** (`services/sync.ts`): each connector reads only within narrow windows: events from yesterday to 8 days ahead, inbox threads from the last 7 days, Slack DMs and mentions from the last 2 days, active and recently completed tasks. Records are normalized into the `items` table and upserted on `(user, connection, kind, external_id)`. That makes re-syncs idempotent. Calendar windows are re-read in full, so deleted events disappear. A content hash tracks changes. Schedule changes for today raise deduplicated notifications.
2. **Deterministic context** (`core/briefing.ts → buildBriefingContext`): conflicts, free work slots, back-to-back runs, meetings with little prep time, overdue and due-today tasks, dependency-aware ranking (`core/priority.ts`), email triage signals (`core/email.ts`), related records for meetings (`core/related.ts`), a proposed plan (`core/plan.ts`) and prompt-injection detection. All time math uses IANA zones via Luxon and is tested across DST transitions.
3. **Selection**: only top-ranked records get short reference ids (`T1`, `E3`, `C2`, `M1`). Bodies are truncated and wrapped as `<untrusted>` data.
4. **AI call** (`services/ai.ts → runJSON`): a structured JSON schema is sent (OpenAI `json_schema` strict / Anthropic `output_config.format`). The monthly budget is checked first, and usage plus estimated cost is recorded afterwards.
5. **Validation & merge** (`composeBriefing`): unknown refs are dropped, tips without evidence are dropped, AI deadlines are never accepted (deadlines always come from the source record), consequences of delay are kept only when backed by a deadline or a dependency, and every field is labelled `fact`, `inference` or `suggestion`. If the provider fails, the deterministic briefing is shown with an explicit banner.
6. **Storage**: one briefing per user per local date (upsert). AI-suggested tasks are stored **unconfirmed**, one per source item (unique index), and wait in a review tray.

The end-of-day review (`core/review.ts`) follows the same pattern. Meeting attendance is never assumed: the review shows "Accepted (unverified)" until the user corrects it.

## Scheduling

`services/jobs.ts`:

- **Scheduler tick** (every 30 s): for each user, it computes from settings and timezone whether the briefing, review, reminders, sync and retention jobs are due. Each job is inserted with a **dedupe key** such as `briefing:<user>:2026-10-29`. A second insert is a no-op, so restarts, multiple instances and catch-up after downtime never duplicate work. Briefings are skipped on non-work days and after review time.
- **Worker**: claims due jobs with `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`. Failures retry with exponential backoff (30 s, 60 s, 120 s, or the provider's `Retry-After`), and the job is marked `dead` after `max_attempts`. Every attempt is logged in `job_runs` and visible in Settings → Activity. Jobs abandoned by a crashed worker are re-queued after 10 minutes.
- **Notifications** are rows with a unique `(user, dedupe_key)`, so the same reminder is never delivered twice. The UI polls them and forwards new ones to the OS (desktop) or the browser, respecting quiet hours and the "show previews" setting.

## Permission model

Each connection has a tier: `read`, `draft` or `write`. External writes (`create_draft`, `send_email`, `create_events`, `complete_task`) are created as **pending actions**. They are permission-checked when created and **again at execution**, and they run only when the user approves that specific action. The `pending → executing` transition is atomic, so a double click cannot send twice. Demo connections can never write. Request, approval, execution and failure are all written to the audit log.

## Extending

- **New AI provider**: implement `AIProvider` in `packages/ai` (list models, structured JSON, streaming chat) and register it in `createProvider`.
- **New integration**: implement `Connector` in `packages/integrations` (scopes per tier, auth URL, code exchange, refresh/revoke, `sync` → normalized items/tasks, optional write methods) and add it to `CONNECTORS`. Add its credentials to `config.ts → oauthCredentials`.
