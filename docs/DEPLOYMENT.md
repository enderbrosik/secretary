# Deployment

The server is a single Node.js process that serves the API and, optionally, the built web app from the same origin (`SERVE_WEB_DIR`). It also runs the job scheduler and worker. PostgreSQL 16 is the production database.

## Option A: Docker Compose (self-hosting)

```bash
cp .env.example .env
```

Edit `.env`:

- `NODE_ENV=production`
- `MASTER_KEY=…`
- `PUBLIC_URL=https://secretary.example.com`, `APP_URL=https://secretary.example.com`, `WEB_ORIGINS=https://secretary.example.com,tauri://localhost,http://tauri.localhost,https://tauri.localhost`
- OAuth client IDs and secrets

Then start it:

```bash
POSTGRES_PASSWORD='a-long-random-password' docker compose up -d --build
```

The app listens on `127.0.0.1:8787`. Put a TLS reverse proxy in front. For example, a Caddy file:

```
secretary.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Compose already sets `TRUST_PROXY=true` and `COOKIE_SECURE=true`. The server refuses to start in production without `COOKIE_SECURE=true`.

## Option B: Any Node host

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm build
```

This produces `apps/server/dist/`, a self-contained bundle with its migrations and the PGlite runtime, and `apps/web/dist/`.

```bash
SERVE_WEB_DIR=/srv/secretary/web node /srv/secretary/server/main.mjs
```

Migrations run automatically at start. They are idempotent, and Drizzle's migrator tracks applied ones. To run them separately:

```bash
DATABASE_URL=… pnpm db:migrate
```

## Environment variables

All of them are documented in [`.env.example`](../.env.example). These are required in production:

| Variable | Notes |
|---|---|
| `MASTER_KEY` | 32 random bytes, base64. Store it in a secret manager and back it up. Without it, stored keys and tokens can't be decrypted (users would need to reconnect). |
| `DATABASE_URL` | `postgres://…`. Use TLS (`?sslmode=require`) for managed databases. |
| `PUBLIC_URL`, `APP_URL`, `WEB_ORIGINS` | must match your HTTPS origin(s). OAuth redirect URIs are derived from `PUBLIC_URL`. |
| `COOKIE_SECURE=true`, `TRUST_PROXY=true` | when behind a proxy |

## Scaling & reliability

- **Multiple instances** are safe. Jobs are claimed with `SKIP LOCKED` and deduplicated by key. You can also run dedicated workers by setting `JOBS_ENABLED=false` on web nodes.
- The scheduler catches up after downtime: today's briefing is generated once, even if the server was down at the scheduled time (until review time).
- Health check: `GET /api/health`. It touches the database.
- Logs are JSON (pino) on stdout, with credentials redacted.
- Backups: back up PostgreSQL as usual, and keep `MASTER_KEY` with them.

## Verified in this repository

- `pnpm build` produces a self-contained bundle. It was started in production mode against PostgreSQL 16 and served the SPA with deep links, CSP, HSTS and `Secure` cookies.
- The Dockerfile and docker-compose file are provided. They could not be built in the authoring environment because Docker Hub rate-limited the base image pull, so build them once in your environment, or let the CI `docker` job do it.
