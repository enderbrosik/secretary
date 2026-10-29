# User guide

## Getting started

1. **Create an account** and follow the 8-step setup. Every integration is optional.
2. **Choose an AI provider** (Anthropic or OpenAI) and paste an API key from that provider's developer console. API usage is billed by the provider, separately from ChatGPT or Claude subscriptions. You can skip this. Secretary then uses rule-based briefings and tells you so.
3. **Connect accounts** (Google, Microsoft 365, Slack, Todoist) or **load the demo workspace** to explore with sample data.
4. Set your **timezone, work hours, briefing and review times**, and the assistant's **style**.
5. Your first briefing is prepared immediately. After that it arrives every work day at your briefing time.

## Reading the briefing

- **Labels** tell you where each statement comes from:
  - *From your data*: taken directly from a connected source or your input.
  - *AI summary*: your AI provider's interpretation of the linked records.
  - *Suggestion*: a recommendation, never a deadline or commitment.
- **Deadlines** shown on priorities always come from your task source. The AI's "when" is only a suggestion.
- **Open** links go to the original email, event, message or task.
- **Your day** shows your real meetings, plus dashed suggested focus blocks and breaks. Use **Review plan** to choose which blocks to add to your calendar. They're added only after you approve, and existing meetings are never moved.
- **Detected tasks**: requests found in emails and messages. Click **Add task** to keep one or **Dismiss** to discard it. Dismissed suggestions don't come back.

## Taking action safely

Nothing is sent or changed in your accounts without your approval. Drafting a reply, sending, adding calendar blocks and completing tasks in Todoist each open an approval card that shows exactly what will happen. What's possible depends on the permission level you chose for each account (Settings → Integrations): *Read only*, *Read + drafts*, or *Send & make changes*.

Text in emails that tries to instruct an AI is labelled **Suspicious content** and treated as plain text.

## End-of-day review

Shows what you **completed** (confirmed), what was **in progress** (inferred), the meetings on your calendar (attendance isn't assumed; mark *Attended* or *Missed*), what's still open, and insights. Each insight explains how it was calculated. For each open task choose **Done**, **Tomorrow**, **Blocked** or **Cancel**. Your choices update the task. Add notes if the review missed something.

## Assistant

Ask things like "What should I focus on right now?", "Which people am I waiting on?" or "Help me plan tomorrow." Answers cite records as `[T1]` or `[E2]`, with links underneath. The assistant only knows what's in your connected accounts and tasks, and tells you when it doesn't have access to something. It can't send or change anything.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| ⌘K / Ctrl+K or / | command palette |
| N | new task |
| G then T, K, C, I, R, P, A, S | Today, Tasks, Calendar, Inbox, Reviews, Projects, Assistant, Settings |
| ⌘⇧Space / Ctrl+Shift+Space | desktop quick view (anywhere) |

## Notifications & automations

In **Settings → Automations & alerts** you can turn each automation on or off: morning briefing, review, deadline reminders, meeting alerts, follow-ups, schedule-change alerts, background sync. You can also pause everything at once and set quiet hours. Notification previews are off by default, so subjects and names don't show on your lock screen.

## Privacy

**Settings → Privacy & data** shows exactly what's sent to your AI provider. It also lets you set data retention, export everything, delete synced data, or delete your account. **Activity log** lists sign-ins, connections, permission changes and every approved action.
