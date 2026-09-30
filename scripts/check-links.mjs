// Builds the site into _site/, checking every external link on the way.
// Broken links are kept on the page but dimmed and made unclickable.
// Writes a markdown report to _site-report.md when anything is broken.
//
//   node scripts/check-links.mjs [--out _site]

import { readdir, readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const outArg = process.argv.indexOf('--out');
const out = join(root, outArg > -1 ? process.argv[outArg + 1] : '_site');
const reportPath = join(root, '_site-report.md');

const EXCLUDE = new Set(['.git', '.github', '.claude', '.vercel', '.gitignore', 'scripts', '_site', '_site-report.md', 'node_modules']);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const TIMEOUT_MS = 15000;
const ATTEMPTS = 3;

const LINK_RE = /<a\b[^>]*?\bhref="(https?:\/\/[^"]+)"[^>]*>/g;

const BROKEN_STYLE = `
  <style>
    a.broken, a.broken:hover { opacity: 0.35; cursor: default; border-color: transparent !important; color: inherit; }
  </style>
</head>`;

// Sites like LinkedIn answer bots with 999/403/429 even when the page is fine,
// so only treat hard failures as broken.
const isBroken = (status) => status === 404 || status === 410 || status >= 500;

async function check(url) {
  let last;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': UA, accept: 'text/html,*/*' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      res.body?.cancel();
      last = { status: res.status, broken: isBroken(res.status) };
      if (!last.broken) return last;
    } catch (err) {
      last = { status: err.cause?.code || err.name || 'error', broken: true };
    }
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  return last;
}

function disable(tag) {
  let t = tag.replace(/\bhref="/, 'data-href="');
  t = /\bclass="/.test(t) ? t.replace(/\bclass="/, 'class="broken ') : t.replace(/^<a\b/, '<a class="broken"');
  t = /\bdata-tip="/.test(t) ? t.replace(/\bdata-tip="[^"]*"/, 'data-tip="temporarily unavailable"') : t;
  return t.replace(/>$/, ' aria-disabled="true">');
}

await rm(out, { recursive: true, force: true });
await rm(reportPath, { force: true });
await mkdir(out, { recursive: true });

const entries = (await readdir(root)).filter((f) => !EXCLUDE.has(f));
for (const f of entries) await cp(join(root, f), join(out, f), { recursive: true });

const pages = entries.filter((f) => f.endsWith('.html'));
const htmlByPage = Object.fromEntries(await Promise.all(pages.map(async (p) => [p, await readFile(join(out, p), 'utf8')])));

const urls = [...new Set(Object.values(htmlByPage).flatMap((h) => [...h.matchAll(LINK_RE)].map((m) => m[1])))];
const results = Object.fromEntries(await Promise.all(urls.map(async (u) => [u, await check(u)])));

for (const u of urls) console.log(`${results[u].broken ? 'BROKEN' : 'ok    '} ${results[u].status}  ${u}`);

const broken = urls.filter((u) => results[u].broken);
for (const [page, html] of Object.entries(htmlByPage)) {
  let touched = false;
  const next = html.replace(LINK_RE, (tag, url) => {
    if (!results[url].broken) return tag;
    touched = true;
    return disable(tag);
  });
  if (touched) await writeFile(join(out, page), next.replace('</head>', BROKEN_STYLE));
}

if (broken.length) {
  const lines = broken.map((u) => {
    const on = pages.filter((p) => htmlByPage[p].includes(`"${u}"`)).join(', ');
    return `- ${u} — \`${results[u].status}\` (on ${on})`;
  });
  await writeFile(reportPath, `These links failed the pre-deploy check and were dimmed and disabled on the live site:\n\n${lines.join('\n')}\n`);
  console.log(`\n${broken.length} broken link(s) disabled; report in _site-report.md`);
} else {
  console.log(`\nall ${urls.length} external links ok`);
}
