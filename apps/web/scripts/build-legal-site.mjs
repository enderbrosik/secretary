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

await writeFile(
  join(out, 'index.html'),
  page({
    title: 'Secretary',
    description: 'Secretary — an AI personal secretary that runs on your own computer.',
    body: `<nav>${brand}<a href="${REPO_URL}">GitHub</a></nav>
<h1>Secretary</h1>
<p>A personal assistant that prepares a calm morning briefing, finds what needs a reply, prepares your meetings and writes an honest end-of-day review — using only the accounts you connect, and nothing sent or changed without your approval.</p>
<div class="cards">
<a class="card" href="${base}/privacy/">Privacy Policy<span>What Secretary stores, where, and who it is shared with.</span></a>
<a class="card" href="${base}/terms/">Terms of Service<span>The terms for using the app.</span></a>
<a class="card" href="${REPO_URL}">Source code &amp; downloads<span>github.com/enderbrosik/secretary</span></a>
</div>`,
  }),
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
