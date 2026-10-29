# Setting up integrations

Each integration uses that provider's **official OAuth flow**. You register an app once per Secretary server and put its credentials in `.env`. Users then connect their own accounts from **Settings → Integrations**.

Every redirect URI has this form (shown in the app for unconfigured providers):

```
${PUBLIC_URL}/api/integrations/callback/<provider>
```

For local development that is `http://localhost:8787/api/integrations/callback/google`, and so on. Restart the server after changing `.env`.

Users choose a **permission level** per connection, and Secretary requests only the scopes that level needs:

| Level | Meaning |
|---|---|
| Read only | sync and summarize, no writes |
| Read + drafts | can also save reply drafts (each one approved) |
| Send & make changes | can also send email, create calendar events and complete tasks (each one approved) |

Raising the level later sends the user back through the provider's consent screen for the extra scopes only.

---

## Google

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project, then go to **APIs & Services → Library** and enable **Gmail API** and **Google Calendar API**.
2. Go to **OAuth consent screen**: User type *External* (or *Internal* for Workspace), and add the scopes listed below.
3. Go to **Credentials → Create credentials → OAuth client ID → Web application** and add the redirect URI `…/api/integrations/callback/google`.
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

Scopes requested: `openid email profile` always; `calendar.readonly` (read) or `calendar.events` (send & change); `gmail.readonly`; `gmail.compose` for drafts. Google has no drafts-only scope. `gmail.compose` technically allows sending, so Secretary enforces the "drafts" level itself and never sends below the "send" level.

Gmail scopes are classed as *restricted*. Up to 100 test users work without verification. Public distribution requires Google's OAuth verification and a security assessment.

## Microsoft 365

1. In [Microsoft Entra admin center](https://entra.microsoft.com/), go to **App registrations → New registration**. Supported account types: choose as needed (`MICROSOFT_TENANT=common` allows work, school and personal accounts).
2. Under Redirect URI, choose **Web**: `…/api/integrations/callback/microsoft`.
3. Go to **Certificates & secrets → New client secret**.
4. Under **API permissions → Microsoft Graph → Delegated**, add `User.Read`, `offline_access`, `Calendars.Read`, `Mail.Read`, plus `Calendars.ReadWrite`, `Mail.ReadWrite` and `Mail.Send` if users may choose higher levels.
5. Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` and `MICROSOFT_TENANT`.

Microsoft has no programmatic token revocation for this flow. Disconnecting deletes the tokens and synced data, and the UI tells the user to remove the app at https://myapps.microsoft.com.

## Slack

1. At [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App → From scratch**.
2. Under **OAuth & Permissions → Redirect URLs**, add `…/api/integrations/callback/slack`. Slack requires HTTPS, so for local testing use a tunnel and set `PUBLIC_URL` to it.
3. Under **User Token Scopes** (not bot scopes), add `channels:history groups:history im:history mpim:history channels:read groups:read im:read mpim:read users:read`.
4. Under **Basic Information**, copy the Client ID and Client Secret into `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`.

Secretary has **no Slack write scopes**. It only sees conversations the user is already a member of: DMs, group DMs, and messages that mention the user in the 25 most recently active channels, from the last 2 days. Token rotation is supported if you enable it.

## Todoist

1. At the [Todoist App Management Console](https://developer.todoist.com/appconsole.html), create an app.
2. Set the **OAuth redirect URL** to `…/api/integrations/callback/todoist`.
3. Set `TODOIST_CLIENT_ID` and `TODOIST_CLIENT_SECRET`.

Scopes: `data:read` (read only) or `data:read_write` (so completing a task in Secretary can also complete it in Todoist, after a click). Secretary uses Todoist's unified API v1.

## AI providers (per user, no server setup)

Each user adds their own key in **Settings → AI**:

- **Anthropic**: create a key in the Claude Console at https://console.anthropic.com/settings/keys.
- **OpenAI**: create a key at https://platform.openai.com/api-keys.

API usage is billed by the provider and is **separate from ChatGPT or Claude consumer subscriptions**, which do not include API access. Secretary never asks for ChatGPT or Claude passwords. Keys are verified against the provider before saving, then encrypted.

## Verifying a connection

Integration code is covered by tests against mocked provider APIs (`pnpm test`). After configuring real credentials:

1. Connect the account in Settings → Integrations at the **Read only** level.
2. Click **Sync now** and confirm the item counts. Inbox and Calendar should show your real data, and each record's **Open** link should go to the original.
3. Check **Settings → Activity**: `integration.connected` should appear, and the sync job should show as succeeded.
4. To test writes, raise the level, draft a reply from the Inbox, and approve it in the Approvals dialog. The draft should appear in your mailbox.

For AI keys: `LIVE_TESTS=1 ANTHROPIC_API_KEY_LIVE=… OPENAI_API_KEY_LIVE=… pnpm test:live`.
