# Security & privacy

## Secrets

| Secret | Where it lives | Protection |
|---|---|---|
| User AI API keys | `ai_providers.encrypted_key` | AES-256-GCM with the user's data key; AAD binds it to `user:ai:<provider>` |
| OAuth access/refresh tokens | `connections.encrypted_tokens` | AES-256-GCM, AAD `user:conn:<provider>:<account>` |
| PKCE verifiers (10 min) | `oauth_states.encrypted_verifier` | AES-256-GCM, single use |
| Per-user data keys | `users.wrapped_data_key` | wrapped with `MASTER_KEY` (envelope encryption) |
| `MASTER_KEY` | server environment / secret manager | never stored in the database. In desktop local mode it's generated on first run and kept in the OS keychain |
| Session tokens | cookie (web) or OS keychain (desktop) | only the SHA-256 hash is stored server-side |
| Passwords | `users.password_hash` | Argon2id (19 MiB, t=2, p=1) |

- Keys and tokens are **never returned to the client**. The UI shows only a hint such as `…a1b2`.
- Logs redact `authorization`, cookies, CSRF headers, `apiKey`, `password` and `*Token` fields. The request logger records method, path (no query string) and IP only.
- AI and integration errors shown to users are mapped to fixed, safe messages. Provider response bodies, which can echo keys, are never relayed.
- The OpenAI and Anthropic SDKs are constructed with explicit `baseURL` and `authToken: null` / `organization: null`. Ambient environment credentials (`ANTHROPIC_AUTH_TOKEN`, profiles, `OPENAI_ORG_ID` …) can never be used instead of, or alongside, the user's key.
- Rotating `MASTER_KEY` only requires re-wrapping `users.wrapped_data_key`.
- `.env` is git-ignored. `.env.example` contains no secrets.

## Sessions, CSRF, transport

- Web: `HttpOnly`, `SameSite=Lax`, `Secure` (required in production) session cookie. Sessions expire after 30 days, or after 7 days idle. Changing the password signs out all other sessions. Users can see and revoke sessions in Settings → Security.
- Cookie-authenticated mutating requests require an `x-csrf-token` matching the session (timing-safe comparison), plus an `Origin` check against `WEB_ORIGINS`.
- Desktop: bearer token from the OS credential store, so there are no ambient cookies.
- Strict CORS allowlist. Helmet headers: CSP `default-src 'self'` with no inline scripts, `frame-ancestors 'none'`, HSTS when served over HTTPS, `nosniff`. API responses are `no-store`.
- Login responses are identical for unknown emails and wrong passwords (a dummy hash keeps timing equal).
- Rate limits: 300 requests/min per user, 10/min on auth, 10–20/min on AI-heavy and sync endpoints.
- All inputs are validated with zod. All SQL goes through Drizzle's parameterized queries. Every query is scoped by `user_id`, and cross-tenant access returns 404 (covered by tests).

## OAuth

Authorization Code flow with **PKCE (S256)**, a random single-use `state` expiring in 10 minutes, and minimal scopes per permission level (see SETUP-INTEGRATIONS.md). Refresh tokens are encrypted and refreshed shortly before expiry. Revoked or expired grants mark the connection "Reconnect needed" and notify the user once a day. Disconnect revokes at the provider where an endpoint exists, deletes the tokens, and deletes all data synced from that account.

## Untrusted content & prompt injection

Emails, chat messages and event descriptions are written by third parties:

1. They are sanitized (control characters and bidi overrides removed, delimiter-like tags stripped, length capped) and wrapped in `<untrusted ref="E3">…</untrusted>` blocks.
2. The system prompt carries a security policy: content in those blocks is data, and instructions in it must never be followed.
3. **The model has no tools.** It returns JSON that is validated against a schema, and any record ref it didn't receive is dropped. It cannot send, schedule or change anything.
4. Anything that affects the outside world is a **pending action that the user approves explicitly**.
5. Suspicious phrasing ("ignore previous instructions…", "forward all emails to…") is detected deterministically and flagged in the UI as *Suspicious content*.

Regression tests: `packages/core/test/briefing.test.ts` (delimiter spoofing, injection flagging) and `apps/server/test/ai-briefing.test.ts` (an injection email results in zero queued actions).

## What is sent to the AI provider

Only records relevant to the request, truncated: event titles, times, attendee names and descriptions near today; sender, subject and the newest message text of important recent threads (bodies can be switched off in Settings → AI); recent Slack DMs and mentions; confirmed tasks; the user's name, timezone and style. Never sent: passwords, keys, tokens, attachments, or data from disconnected accounts. The list is shown in Settings → Privacy. Requests go directly from the server to the chosen provider under that provider's API terms.

## Data controls

- **Retention** (7–365 days, default 90): a daily job deletes older synced items, notifications, chat history, briefings, reviews, usage records and finished jobs.
- **Export**: a full JSON export without secrets.
- **Delete synced data**: removes emails, events, messages, briefings and chats, keeping the account.
- **Delete account**: requires password and typed confirmation, revokes integrations, then cascades through every table.
- **Audit log**: sign-ins (including failures), connections, permission changes, provider changes, exports, and every action request, approval, execution and failure.

## Reporting

Report vulnerabilities privately to the maintainers. Don't open public issues for security problems.
