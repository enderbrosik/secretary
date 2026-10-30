# Publishing Secretary: built-in sign-in for every user

People who install Secretary should only ever click **Connect** and sign in with Google,
Microsoft, Slack or Todoist. For that, the publisher registers **one** OAuth app per service,
once, and the release build carries its credentials. Users never see a client ID.

How it fits together:

- The desktop build reads `SECRETARY_<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET` at compile time
  (GitHub Actions secrets → `option_env!` in `apps/desktop/src-tauri/src/sidecar.rs`) and hands
  them to the bundled local server.
- Google and Microsoft redirect straight back to the app's local server
  (`http://127.0.0.1:<port>/api/integrations/callback/<provider>`).
- Slack and Todoist only redirect to HTTPS, so they return to
  `https://enderbrosik.github.io/secretary/oauth/`, a static page (built with the legal site) that
  forwards the result to `127.0.0.1`. It forwards only to loopback, and the app accepts each
  sign-in state once, within 10 minutes.
- A service without credentials shows **Coming soon** in the app.
- Developer option: `CUSTOM_OAUTH_APPS=true` in the app's `server.env` brings back "Set up" and
  token pasting for testing. It's off in releases.

Desktop apps can't keep a client secret truly secret (anyone can extract it from the binary).
Google documents this for installed apps; the protections are the single-use `state`, PKCE
(Google, Microsoft) and redirect URLs that only reach the user's own computer.

## 1. Add the GitHub secrets

GitHub → the repository → **Settings → Secrets and variables → Actions → New repository secret**.
Add whichever services you have registered (the rest show "Coming soon"):

| Secret | From |
| --- | --- |
| `SECRETARY_GOOGLE_CLIENT_ID`, `SECRETARY_GOOGLE_CLIENT_SECRET` | Google Cloud → Clients |
| `SECRETARY_MICROSOFT_CLIENT_ID` | Entra → App registrations → Application (client) ID. No secret needed. |
| `SECRETARY_SLACK_CLIENT_ID`, `SECRETARY_SLACK_CLIENT_SECRET` | api.slack.com/apps → Basic Information |
| `SECRETARY_TODOIST_CLIENT_ID`, `SECRETARY_TODOIST_CLIENT_SECRET` | developer.todoist.com/appconsole |

Then run the **Desktop builds** workflow. GitHub Pages must be on (Settings → Pages → Source:
GitHub Actions) for the privacy policy, terms and Slack/Todoist relay.

## 2. Google

1. Google Cloud Console → your project → enable **Gmail API** and **Google Calendar API**.
2. Google Auth Platform → **Branding**: app name, support email, home page
   `https://enderbrosik.github.io/secretary/`, privacy policy `…/secretary/privacy/`, terms
   `…/secretary/terms/`.
3. **Clients → Create client → Desktop app.** A desktop client accepts any loopback port, so
   sign-in keeps working even if port 47821 is taken. (A *Web application* client with the
   redirect URI `http://127.0.0.1:47821/api/integrations/callback/google` also works, but only
   while the app gets port 47821.)
4. **Audience → Publish app.**

**Verification — read this before inviting people.** Until Google verifies the app, every user
sees an "unverified app" warning, and at most 100 people can ever sign in. Gmail read access
(`gmail.readonly`) is a *restricted* scope: verification needs a verified domain for the home
page and policy, a demo video, and a yearly third-party security assessment (CASA) by a
Google-approved lab, which costs money. Calendar read access is *sensitive*: it needs
verification but no assessment. For a small group of people, the unverified app is fine.

## 3. Microsoft 365 / Outlook

1. Entra admin center → **App registrations → New registration**. Supported accounts:
   **any Entra ID tenant + personal Microsoft accounts**.
2. **Authentication → Add a platform → Mobile and desktop applications**, custom redirect URI
   `http://127.0.0.1/api/integrations/callback/microsoft` (Microsoft ignores the port on
   loopback addresses).
3. **API permissions → Microsoft Graph → Delegated:** `User.Read`, `offline_access`,
   `Calendars.Read`, `Mail.Read` (add `Mail.ReadWrite`, `Mail.Send` and
   `Calendars.ReadWrite` for the draft and send levels).
4. No client secret: it's a public client and uses PKCE.

Without **publisher verification** (needs a Microsoft AI Cloud Partner Program account),
users see "unverified", and some work or school accounts need an administrator's approval.

## 4. Slack

1. api.slack.com/apps → **Create New App → From a manifest**, using the manifest in
   `apps/web/src/components/settings/ProviderSetup.tsx`, plus under `oauth_config`:
   `redirect_urls: [https://enderbrosik.github.io/secretary/oauth/]`.
2. **Manage Distribution → Activate Public Distribution**, so people outside your workspace
   can install it.
3. Copy the Client ID and Client Secret from **Basic Information**.

## 5. Todoist

1. developer.todoist.com/appconsole → **Create a new app**.
2. **OAuth redirect URL:** `https://enderbrosik.github.io/secretary/oauth/`.
3. Copy the Client ID and Client secret.
