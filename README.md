# Secretary — your AI personal secretary

Secretary prepares a calm, grounded picture of your day and helps you close it out:

- **Morning briefing**: today's overview, ranked priorities with reasons, email & Slack triage, meeting preparation, data-backed tips and a proposed daily plan.
- **End-of-day review**: confirmed accomplishments versus inferred progress, what carries over, productivity insights that explain how they were calculated, and tomorrow's priorities. You can correct any of it.
- **Unified tasks** from the app and from Todoist, with AI-detected tasks held for your review.
- **Inbox** across Gmail / Outlook / Slack sorted by what needs you, with AI reply drafts.
- **Assistant chat** that cites the records behind every answer.
- **BYOK AI**: OpenAI or Anthropic with your own API key. Model lists come from your account. You can set a spending limit, and every call's estimated cost is tracked.
- **You approve every external action.** Drafts, sends, calendar changes and task completions in other apps each wait for your explicit approval.

Runs as a **web app**, and as a **desktop app for macOS, Windows and Linux** (Tauri). The desktop app can run fully local or connect to a server.

---

## Quick start (development)

Requirements: Node 22+, pnpm 10, PostgreSQL 16 (or nothing at all: see "No Postgres?" below).

```bash
pnpm install
cp .env.example .env
```

Generate the server key and paste it into `MASTER_KEY` in `.env`:

```bash
pnpm --filter @secretary/server exec tsx src/genkey.ts
```

```bash
pnpm dev
```

- Web app: http://localhost:5173. The API runs on :8787, and Vite proxies `/api` to it.
- Sign up, then in onboarding choose **Load sample data** to try the clearly labelled **demo workspace**. No credentials are needed.
- Add an OpenAI or Anthropic API key in onboarding or **Settings → AI** for AI summaries. Without a key, Secretary shows rule-based briefings and says so.

**No Postgres?** Set `DATABASE_URL=pglite:///absolute/path/to/data` to use embedded PostgreSQL (PGlite). This is fine for a single user. Use real PostgreSQL in production.

Migrations run automatically on server start, or manually with `pnpm db:migrate`.

## Connecting real accounts

Each integration needs an OAuth app registered with that provider, and its client ID and secret in `.env`. Step-by-step instructions are in [docs/SETUP-INTEGRATIONS.md](docs/SETUP-INTEGRATIONS.md). An integration that isn't configured shows as "Not available on this server yet" in the UI. It is never shown as available when it isn't.

| Integration | What it does | Status |
|---|---|---|
| Google Calendar & Gmail | read events and inbox threads; drafts, send and calendar events with approval | Implemented. Tested against mocked Google APIs. Needs your OAuth app to verify live |
| Microsoft 365 (Outlook, Calendar) | the same via Microsoft Graph | Implemented. Tested against mocked Graph APIs. Needs your Entra app to verify live |
| Slack | DMs and mentions, read-only (no write scopes) | Implemented. Tested against mocked Slack APIs. Needs your Slack app to verify live |
| Todoist | tasks sync; completing a task there with approval | Implemented. Tested against mocked Todoist APIs. Needs your Todoist app to verify live |
| OpenAI / Anthropic | AI provider (BYOK) | Implemented with the official SDKs. Tested against mocked APIs. Run `pnpm test:live` with your keys to verify |
| Demo workspace | sample data, cannot send | Works out of the box |

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | API and web app with hot reload |
| `pnpm test` | unit and integration tests (embedded PGlite; no services needed) |
| `pnpm e2e` | Playwright end-to-end tests at desktop, tablet and mobile sizes (demo mode) |
| `pnpm test:live` | real-API tests, opt-in (`LIVE_TESTS=1 ANTHROPIC_API_KEY_LIVE=… OPENAI_API_KEY_LIVE=…`) |
| `pnpm typecheck` | TypeScript across the monorepo |
| `pnpm build` | production web build and self-contained server bundle (`apps/server/dist`) |
| `pnpm desktop:dev` | desktop app against the dev server |
| `pnpm desktop:build` | desktop installers for the current OS |

## Repository layout

```
apps/web        React + Vite + Tailwind UI (shared by web and desktop)
apps/server     Fastify API, job scheduler/worker, OAuth, approvals
apps/desktop    Tauri 2 shell: tray, quick view, keychain, local-mode sidecar
packages/core   domain logic: timezones, conflicts, prioritization, briefing & review engines, prompts
packages/ai     provider abstraction + OpenAI / Anthropic adapters, structured output, pricing
packages/integrations  Google, Microsoft Graph, Slack, Todoist, demo connectors
packages/db     Drizzle schema + SQL migrations (PostgreSQL / PGlite)
docs/           architecture, setup, security, deployment, desktop, user guide
```

## Documentation

- [Architecture & decisions](docs/ARCHITECTURE.md)
- [Integration setup](docs/SETUP-INTEGRATIONS.md)
- [Security & privacy](docs/SECURITY.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Desktop app](docs/DESKTOP.md)
- [User guide](docs/USER-GUIDE.md)
