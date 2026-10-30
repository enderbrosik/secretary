/**
 * Privacy Policy and Terms of Service. Single source for the in-app pages
 * (/privacy, /terms) and the public website (scripts/build-legal-site.mjs).
 * Keep this file free of imports and non-erasable TypeScript so Node can load it directly.
 *
 * Inline links use [text](https://url).
 */

export type LegalBlock = string | { list: string[] };
export interface LegalSection {
  heading: string;
  body: LegalBlock[];
}
export interface LegalDoc {
  slug: 'privacy' | 'terms';
  title: string;
  updated: string;
  intro: string[];
  sections: LegalSection[];
}

export const REPO_URL = 'https://github.com/enderbrosik/secretary';
export const PUBLIC_SITE = 'https://getsecretary.vercel.app';
const CONTACT = `[open an issue on GitHub](${REPO_URL}/issues)`;

export const privacyPolicy: LegalDoc = {
  slug: 'privacy',
  title: 'Privacy Policy',
  updated: 'October 30, 2026',
  intro: [
    'Secretary is a personal assistant app that prepares a morning briefing, an end-of-day review, and a unified task list from the accounts you choose to connect. This policy explains what data Secretary handles, where it is kept, and who it is shared with.',
    'In short: Secretary runs on your own computer (or on a server you or your organization run). The people who publish Secretary do not operate a service that receives your data. There are no ads, no analytics or tracking, and your data is never sold.',
  ],
  sections: [
    {
      heading: 'Who is responsible for your data',
      body: [
        `Secretary is software published at [github.com/enderbrosik/secretary](${REPO_URL}). When you use the desktop app in local mode, your data is stored only on your computer and you control it. When you use Secretary on a server, the person or organization that runs that server is responsible for the data stored there; this policy describes how the software itself handles data.`,
      ],
    },
    {
      heading: 'Data Secretary stores',
      body: [
        {
          list: [
            'Your account: name, email address and a password hash (Argon2id). Your password itself is never stored.',
            'Your settings: timezone, working hours, briefing and review times, notification and privacy preferences.',
            'Data synced from accounts you connect: calendar events, recent email (sender, recipients, subject, snippet and — unless you turn it off — message text), Slack direct messages and messages that mention you, and Todoist tasks.',
            'What you create in Secretary: tasks, projects, notes, corrections, briefings, reviews and assistant chat history.',
            'Credentials: OAuth tokens for connected accounts and any AI provider API key you enter. These are encrypted (AES-256-GCM with a per-user key) and are never shown back to you in full, written to logs, or sent to an AI model.',
            'Records for your protection: an audit log of sign-ins, connections and approved actions, and an AI usage log (token counts and estimated cost) used to enforce your spending limits.',
          ],
        },
        'In the desktop app this data lives in a database in the app’s data folder on your computer, and the encryption key is kept in your operating system’s keychain (macOS Keychain, Windows Credential Manager or Linux Secret Service).',
      ],
    },
    {
      heading: 'How Secretary uses your data',
      body: [
        'Only to provide the features you see: building your briefing and daily plan, finding emails and messages that need a reply, preparing for meetings, suggesting tasks, writing your end-of-day review, and answering your questions in the assistant.',
        'Secretary does not use your data for advertising, does not build profiles for anyone else, and does not use your data to develop, improve or train generalized AI or machine-learning models.',
        'Secretary never sends an email, creates a calendar event or changes anything in another service without your explicit approval of that specific action.',
      ],
    },
    {
      heading: 'Google user data',
      body: [
        'If you connect a Google account, Secretary requests only the permissions needed for the features you turn on:',
        {
          list: [
            'Your basic profile and email address (openid, email, profile) — to show which account is connected.',
            'Read-only access to Google Calendar (calendar.readonly) — to plan your day and prepare meetings.',
            'Read-only access to Gmail (gmail.readonly) — to find messages that need your attention.',
            'Optional, only if you choose a higher permission level: create calendar events (calendar.events) and save email drafts (gmail.compose). Each event or draft is created only after you approve it.',
          ],
        },
        'Secretary’s use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.',
        'Specifically: Google user data is used only to provide the user-facing features described above; it is transferred to a third party only when you choose an AI provider (see below) and only as needed to provide those features; it is not used for advertising; it is not used to train generalized AI models; and no person reads it unless you ask for help with your own data, it is needed for security, or the law requires it.',
      ],
    },
    {
      heading: 'Microsoft, Slack and Todoist data',
      body: [
        {
          list: [
            'Microsoft 365 / Outlook: your profile (User.Read), offline access so syncing continues, read access to your calendar (Calendars.Read) and mail (Mail.Read). Drafts (Mail.ReadWrite), sending (Mail.Send) and calendar writes (Calendars.ReadWrite) are requested only if you choose a higher permission level, and each action requires your approval.',
            'Slack: read-only access to conversations you are already a member of, and to user names. Secretary cannot post, react or change anything in Slack.',
            'Todoist: your tasks, due dates and priorities. If you complete a Todoist task in Secretary, it is completed in Todoist after you confirm.',
          ],
        },
        'This data is used the same way as Google data: only to provide Secretary’s features, never for ads or AI training.',
      ],
    },
    {
      heading: 'AI providers',
      body: [
        'You choose which AI Secretary uses:',
        {
          list: [
            'Local AI (Ollama): the model runs on your computer. Nothing is sent to an AI company.',
            'OpenAI or Anthropic, with your own API key: when Secretary needs AI, it sends the relevant data directly from your computer (or your server) to that provider’s API. That data is processed under the provider’s API terms and privacy policy, and usage is billed by the provider to your account.',
          ],
        },
        'What may be sent, when relevant to a request: titles, times and attendee names of calendar events near today and their descriptions (shortened); sender, subject and the newest text of recent important email threads (shortened; full text can be turned off); text of Slack direct messages and mentions from the last two days; your tasks; and your name, timezone and assistant preferences.',
        'Never sent: passwords, API keys or OAuth tokens; attachments; messages outside the sync window; data from accounts you disconnected.',
        'Settings → Privacy & data in the app shows this list at any time.',
      ],
    },
    {
      heading: 'Other network connections',
      body: [
        'Besides the services you connect and the AI provider you choose, Secretary may contact: the Ollama model library, when you download a local model; and GitHub, if automatic update checks are enabled in your build. These requests reveal your IP address to those services but contain none of your Secretary data.',
      ],
    },
    {
      heading: 'Retention and deletion',
      body: [
        {
          list: [
            'Synced emails, events and messages, chat history, briefings and reviews are deleted automatically after the retention period you choose (7 to 365 days; 90 days by default).',
            'Disconnecting an account revokes Secretary’s access with that provider where the provider supports it and deletes the data synced from it.',
            'Settings → Privacy & data lets you export all your data, delete synced data, or delete your account. Deleting your account permanently removes everything stored for you.',
            'Uninstalling the desktop app and removing its data folder removes all local data. You can also revoke access at any time from your Google, Microsoft, Slack or Todoist account settings.',
          ],
        },
      ],
    },
    {
      heading: 'Security',
      body: [
        'Credentials are encrypted at rest; sessions use secure, HTTP-only cookies or a token kept in your operating system’s keychain; the local server listens only on your own computer (127.0.0.1); external writes need your approval; and content from emails and messages is treated as untrusted data so instructions hidden inside it cannot make Secretary act. No system is perfectly secure; please report security issues privately through GitHub.',
      ],
    },
    {
      heading: 'Children',
      body: ['Secretary is not directed to children under 16 and should not be used by them.'],
    },
    {
      heading: 'Changes to this policy',
      body: ['If this policy changes, the updated version will be published at this address with a new “last updated” date. Significant changes will be noted in the release notes.'],
    },
    {
      heading: 'Contact',
      body: [`Questions or requests about this policy: ${CONTACT}. If you use Secretary on a server run by someone else, contact them about data stored on that server.`],
    },
  ],
};

export const termsOfService: LegalDoc = {
  slug: 'terms',
  title: 'Terms of Service',
  updated: 'October 30, 2026',
  intro: [
    'These terms apply to your use of the Secretary app (desktop and web). By using Secretary you agree to them. If you don’t agree, please don’t use the app.',
  ],
  sections: [
    {
      heading: 'What Secretary is',
      body: [
        'Secretary is a personal assistant tool that reads the accounts you connect and helps you plan your day. It runs on your own computer or on a server you choose. Its handling of your data is described in the [Privacy Policy](/privacy).',
      ],
    },
    {
      heading: 'Your accounts and third-party services',
      body: [
        {
          list: [
            'You may connect only accounts you are authorized to use. If you connect a work account, make sure your organization allows it.',
            'Your use of Google, Microsoft, Slack, Todoist, OpenAI, Anthropic, Ollama and any AI model remains subject to their own terms and policies. Secretary is not affiliated with or endorsed by any of them.',
            'You are responsible for keeping your Secretary password, your computer and any API keys secure.',
          ],
        },
      ],
    },
    {
      heading: 'AI output',
      body: [
        'Briefings, plans, suggested tasks, draft replies and reviews are generated automatically and can be incomplete or wrong. Secretary labels what is a fact from your data, what is an inference and what is a suggestion, but you should check anything important before relying on it. Secretary is not a substitute for professional legal, medical, financial or other advice.',
      ],
    },
    {
      heading: 'Actions you approve',
      body: [
        'Secretary never sends email, creates calendar events or changes data in another service without your approval. When you approve an action, you are responsible for it as if you had done it yourself, so review drafts and events before approving.',
      ],
    },
    {
      heading: 'Costs',
      body: [
        'Secretary itself has no fee. If you use OpenAI or Anthropic, those providers bill you directly for API usage. Spending limits and cost figures in Secretary are estimates based on published prices; your provider’s bill is authoritative. Local AI through Ollama has no usage charges.',
      ],
    },
    {
      heading: 'Acceptable use',
      body: [
        'Don’t use Secretary to break the law, to access accounts or data you are not allowed to access, to send spam, or to interfere with the services it connects to.',
      ],
    },
    {
      heading: 'No warranty',
      body: [
        'Secretary is provided “as is” and “as available”, without warranties of any kind, express or implied, including fitness for a particular purpose and non-infringement. It may contain bugs, and connected services may change or stop working with it at any time. Keep your own records of anything important.',
      ],
    },
    {
      heading: 'Limitation of liability',
      body: [
        'To the fullest extent permitted by law, the authors and publishers of Secretary are not liable for any indirect, incidental, special, consequential or punitive damages, or for lost data, profits or opportunities, arising from your use of the app. Nothing in these terms limits liability that cannot be limited under applicable law.',
      ],
    },
    {
      heading: 'Stopping use',
      body: [
        'You can stop using Secretary at any time: delete your account in Settings → Privacy & data, disconnect your accounts, and uninstall the app. If you use a server run by someone else, its operator may suspend access that violates these terms.',
      ],
    },
    {
      heading: 'Changes',
      body: ['These terms may be updated. The current version is always published at this address with its “last updated” date. Continuing to use Secretary after a change means you accept the updated terms.'],
    },
    {
      heading: 'Contact',
      body: [`Questions about these terms: ${CONTACT}.`],
    },
  ],
};

export const legalDocs = { privacy: privacyPolicy, terms: termsOfService } as const;

/** Splits text into plain strings and [label](href) links. */
export function parseInline(text: string): ({ text: string } | { label: string; href: string })[] {
  const out: ({ text: string } | { label: string; href: string })[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ label: m[1]!, href: m[2]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
