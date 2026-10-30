// Builds the public Privacy Policy / Terms website (GitHub Pages) from src/legal/content.ts.
// Usage: node scripts/build-legal-site.mjs <outDir> [basePath]   e.g. basePath "/secretary"
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { legalDocs, parseInline, REPO_URL } = await import('../src/legal/content.ts');

const out = resolve(process.argv[2] ?? 'legal-site');
const base = (process.argv[3] ?? '').replace(/\/$/, '');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (text) =>
  parseInline(text)
    .map((p) => {
      if ('text' in p) return esc(p.text);
      const href = p.href.startsWith('/') ? `${base}${p.href}/` : p.href;
      return `<a href="${esc(href)}"${p.href.startsWith('/') ? '' : ' rel="noopener"'}>${esc(p.label)}</a>`;
    })
    .join('');

const CSS = `:root{color-scheme:light dark;--bg:#f7f6f3;--ink:#1d1c1a;--ink2:#3a3833;--muted:#77726a;--line:#e7e4dd;--accent:#2a43a6}
@media (prefers-color-scheme:dark){:root{--bg:#131211;--ink:#edebe7;--ink2:#cfccc6;--muted:#9c978e;--line:#2d2b27;--accent:#a9bbff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink2);font:15px/1.65 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:42rem;margin:0 auto;padding:40px 16px 56px}nav{display:flex;justify-content:space-between;gap:16px;margin-bottom:40px;font-size:13px}
nav a,footer a{color:var(--muted);text-decoration:none}nav a:hover,footer a:hover{color:var(--ink)}
.brand{display:inline-flex;align-items:center;gap:8px;color:var(--ink)!important;font:20px Newsreader,Georgia,serif}.brand img{width:24px;height:24px;border-radius:6px}
h1,h2{font-family:Newsreader,ui-serif,Georgia,serif;font-weight:500;color:var(--ink);letter-spacing:-.01em}h1{font-size:32px;margin:0}h2{font-size:20px;margin:36px 0 10px}
.updated{margin:4px 0 24px;font-size:13px;color:var(--muted)}a{color:var(--accent)}ul{padding-left:20px}li{margin:6px 0}li::marker{color:var(--muted)}
footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted)}
.cards{display:grid;gap:12px;margin-top:24px}.card{display:block;padding:16px 18px;border:1px solid var(--line);border-radius:12px;text-decoration:none;color:var(--ink)}.card:hover{border-color:var(--muted)}.card span{display:block;color:var(--muted);font-size:13.5px}`;

const page = ({ title, description, body }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="google-site-verification" content="qp3jJ7CWbBIWPUD3RbLWCkW6IrKKnFZhPODiFTqVDvU">
<link rel="icon" href="${base}/favicon.svg" type="image/svg+xml">
<style>${CSS}</style>
</head>
<body>
<main>
${body}
<footer><a href="${base}/privacy/">Privacy Policy</a> · <a href="${base}/terms/">Terms of Service</a> · <a href="${REPO_URL}">Source code</a></footer>
</main>
</body>
</html>
`;

const brand = `<a class="brand" href="${base}/"><img src="${base}/favicon.svg" alt="">Secretary</a>`;

await mkdir(out, { recursive: true });
await copyFile(join(here, '../public/favicon.svg'), join(out, 'favicon.svg'));
await copyFile(join(here, '../../../brand/secretary-logo-512.png'), join(out, 'logo.png'));

for (const doc of Object.values(legalDocs)) {
  const other = doc.slug === 'privacy' ? legalDocs.terms : legalDocs.privacy;
  const sections = doc.sections
    .map((s) => `<h2>${esc(s.heading)}</h2>\n` + s.body.map((b) => (typeof b === 'string' ? `<p>${inline(b)}</p>` : `<ul>${b.list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`)).join('\n'))
    .join('\n');
  const body = `<nav>${brand}<a href="${base}/${other.slug}/">${esc(other.title)}</a></nav>
<article>
<h1>${esc(doc.title)}</h1>
<p class="updated">Last updated ${esc(doc.updated)}</p>
${doc.intro.map((p) => `<p>${inline(p)}</p>`).join('\n')}
${sections}
</article>`;
  await mkdir(join(out, doc.slug), { recursive: true });
  await writeFile(join(out, doc.slug, 'index.html'), page({ title: `${doc.title} · Secretary`, description: `Secretary ${doc.title}`, body }));
}

// Homepage: what the app does and how it uses data (Google's consent screen links here).
const HOME_CSS = `.home main{max-width:60rem}.hero{display:grid;gap:28px;align-items:center;margin:8px 0 56px}
@media (min-width:760px){.hero{grid-template-columns:1.2fr 1fr}.logo{max-width:260px}}
.hero h1{font-size:44px;line-height:1.1}.lede{font-size:17px;margin:16px 0 24px}
.btns{display:flex;flex-wrap:wrap;gap:10px}.btn{display:inline-block;padding:10px 16px;border-radius:10px;font-weight:600;font-size:14px;text-decoration:none;border:1px solid var(--line);color:var(--ink)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--bg)}
.logo{width:100%;max-width:160px;justify-self:center;border-radius:22%;box-shadow:0 20px 60px -20px rgba(47,75,184,.55)}
.grid{display:grid;gap:12px}@media (min-width:640px){.grid{grid-template-columns:1fr 1fr}}@media (min-width:900px){.grid.three{grid-template-columns:1fr 1fr 1fr}}
.feat{padding:18px;border:1px solid var(--line);border-radius:14px}.feat h3{margin:0 0 6px;font-size:15px;color:var(--ink)}.feat p{margin:0;font-size:14px}
section{margin-top:52px}.kicker+h2{margin-top:0}.kicker{font-size:12.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 4px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.chip{padding:6px 12px;border:1px solid var(--line);border-radius:999px;font-size:13.5px;color:var(--ink)}`;
const feat = (t, d) => `<div class="feat"><h3>${t}</h3><p>${d}</p></div>`;
await writeFile(
  join(out, 'index.html'),
  page({
    title: 'Secretary — your AI personal secretary',
    description: 'Secretary prepares a calm morning briefing, finds what needs a reply, preps your meetings and writes an honest end-of-day review. It runs on your own computer.',
    body: `<nav>${brand}<span><a href="${base}/privacy/">Privacy</a> · <a href="${base}/terms/">Terms</a> · <a href="${REPO_URL}">GitHub</a></span></nav>
<div class="hero">
<div>
<h1>Start every day knowing exactly what matters.</h1>
<p class="lede">Secretary is a personal assistant for your calendar, email, messages and tasks. It prepares a calm morning briefing, tells you which emails need a reply, preps your meetings and writes an honest end-of-day review — and it never sends or changes anything without your approval.</p>
<div class="btns"><a class="btn primary" href="${REPO_URL}">Get Secretary</a><a class="btn" href="${base}/privacy/">How your data is handled</a></div>
</div>
<img class="logo" src="${base}/logo.png" alt="Secretary logo" width="260" height="260">
</div>

<section>
<p class="kicker">What it does</p>
<h2>Your day, organized before you sit down</h2>
<div class="grid three">
${feat('Morning briefing', 'Your meetings, deadlines and the few things that matter most today, with a suggested plan you can review before anything goes on your calendar.')}
${feat('Inbox that knows what needs you', 'Finds emails and Slack messages waiting for your reply, and drafts answers you can edit and approve.')}
${feat('Meeting prep', 'Who’s attending, the related emails and open tasks — gathered for each meeting.')}
${feat('One task list', 'Tasks from Todoist and your own, plus tasks suggested from your email — added only when you confirm them.')}
${feat('End-of-day review', 'What got done, what moved, and what to prepare for tomorrow. Clearly separates facts from guesses, and you can correct it.')}
${feat('Ask anything', 'Chat with an assistant that answers from your own calendar, email and tasks, with links to the sources.')}
</div>
</section>

<section>
<p class="kicker">Works with</p>
<h2>The accounts you already use</h2>
<div class="chips"><span class="chip">Gmail</span><span class="chip">Google Calendar</span><span class="chip">Outlook &amp; Microsoft 365</span><span class="chip">Slack</span><span class="chip">Todoist</span></div>
<p>You connect each account with the provider’s own sign-in and choose what Secretary can access. Read-only is the default.</p>
</section>

<section>
<p class="kicker">Privacy</p>
<h2>Your data stays yours</h2>
<div class="grid">
${feat('Runs on your computer', 'Your emails, calendar and tasks are stored on your own device, encrypted. There are no Secretary servers holding your data.')}
${feat('You choose the AI', 'Use free local AI that never leaves your computer, or your own OpenAI or Anthropic account.')}
${feat('Nothing happens without you', 'Every email sent, draft saved or event created needs your approval first.')}
${feat('No ads, no tracking', 'Your data is never sold, never used for ads and never used to train AI models. Delete it any time.')}
</div>
<p>Read the full <a href="${base}/privacy/">Privacy Policy</a>, including how Secretary uses Google user data, and the <a href="${base}/terms/">Terms of Service</a>.</p>
</section>`,
  }).replace('<body>', '<body class="home">').replace('</style>', `${HOME_CSS}</style>`),
);
// OAuth relay for the desktop app: Slack and Todoist only redirect to HTTPS, so their
// consent screens return here and this page forwards the result to the app's loopback
// server. The state ("<port>.<provider>.<random>") is checked again, single-use, by the app.
await mkdir(join(out, 'oauth'), { recursive: true });
await writeFile(
  join(out, 'oauth', 'index.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Returning to Secretary…</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>Returning to Secretary…</h1>
<p id="msg">If nothing happens, make sure the Secretary app is open, then try connecting again.</p>
</main>
<script>
(function () {
  var q = new URLSearchParams(location.search);
  var m = /^(\\d{2,5})\\.(slack|todoist)\\.[\\w-]+$/.exec(q.get('state') || '');
  var port = m ? Number(m[1]) : 0;
  if (!m || port < 1024 || port > 65535) {
    document.getElementById('msg').textContent = 'This sign-in link is invalid. Open Secretary and try connecting again.';
    return;
  }
  location.replace('http://127.0.0.1:' + port + '/api/integrations/callback/' + m[2] + location.search);
})();
</script>
</body>
</html>
`,
);
console.log(`Legal site written to ${out}`);
