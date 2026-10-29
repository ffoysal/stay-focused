import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '../extension');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-focused-'));
const EXT = path.join(tmp, 'ext');
fs.cpSync(SRC, EXT, { recursive: true });
const FULL = process.env.FULL_TIMING === '1';
const MAX_NUDGES = Number(process.env.MAX_NUDGES || 2);

const article = '<article>' + '<p>Lorem ipsum dolor sit amet consectetur adipiscing elit.</p>'.repeat(30) + '</article>';
const gatewayCalls = [];

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      gatewayCalls.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"reading": true, "summary": "Lorem ipsum filler."}' } }] }));
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    // Only /a is long enough to count as reading; the other pages are just somewhere to switch to.
    res.end(`<title>Test ${req.url}</title><body>${req.url.startsWith('/a') ? article : 'short page'}</body>`);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

try {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker');
  sw.on('console', (m) => console.log('  [sw]', m.text()));
  check('service worker started', true);

  await sw.evaluate(
    (cfg) => chrome.storage.local.set(cfg),
    { baseUrl: `${base}/v1`, apiKey: 'test-key', model: 'claude-sonnet-4-5', readingThresholdSeconds: FULL ? 60 : 3, maxNudges: MAX_NUDGES },
  );

  const pageA = await ctx.newPage();
  pageA.on('console', (m) => console.log('  [pageA]', m.text()));
  await pageA.goto(`${base}/a`);
  await pageA.bringToFront();

  const diag = await pageA.evaluate(() => ({ vis: document.visibilityState, focus: document.hasFocus() }));
  console.log('  page state:', JSON.stringify(diag));

  // Keep generating input so the page counts as active.
  for (let i = 0; i < (FULL ? 65 : 8); i++) {
    await pageA.mouse.move(10 + i * 5, 10 + i * 5);
    await pageA.waitForTimeout(1000);
  }

  check('gateway called after threshold', gatewayCalls.length === 1, `calls=${gatewayCalls.length}`);
  if (gatewayCalls[0]) {
    check('gateway got bearer key', gatewayCalls[0].auth === 'Bearer test-key');
    check('gateway got model', gatewayCalls[0].body.model === 'claude-sonnet-4-5');
  }
  const state = await sw.evaluate(() => chrome.storage.session.get('state'));
  check('reading session stored', !!state.state, JSON.stringify(state.state));

  // Switch to another tab: overlay should appear there.
  const pageB = await ctx.newPage();
  await pageB.goto(`${base}/b`);
  await pageB.bringToFront();
  await pageB.waitForTimeout(1500);
  console.log('  state after switch:', JSON.stringify((await sw.evaluate(() => chrome.storage.session.get('state'))).state));
  const overlay = await pageB.evaluate(() => !!document.getElementById('stay-focused-host'));
  check('overlay shown on new tab', overlay);

  // Return to the reading tab, then leave again: a second pop-up only if more than one is allowed.
  await pageA.bringToFront();
  await pageA.waitForTimeout(500);
  const pageC = await ctx.newPage();
  await pageC.goto(`${base}/c`);
  await pageC.bringToFront();
  await pageC.waitForTimeout(1500);
  const second = await pageC.evaluate(() => !!document.getElementById('stay-focused-host'));
  check(MAX_NUDGES > 1 ? 'second pop-up after returning and leaving' : 'no second pop-up when limit is 1', second === MAX_NUDGES > 1);

  // Leaving a second time without returning to the reading tab must not nudge again.
  const pageD = await ctx.newPage();
  await pageD.goto(`${base}/d`);
  await pageD.bringToFront();
  await pageD.waitForTimeout(1500);
  console.log('  state at D:', JSON.stringify((await sw.evaluate(() => chrome.storage.session.get('state'))).state));
  console.log('  D overlays:', await pageD.evaluate(() => document.querySelectorAll('#stay-focused-host').length), 'C overlays:', await pageC.evaluate(() => document.querySelectorAll('#stay-focused-host').length));
  check('no extra pop-up without returning', !(await pageD.evaluate(() => !!document.getElementById('stay-focused-host'))));

  // A user-excluded domain (entered as a pasted URL) must never reach the gateway.
  await sw.evaluate(() => chrome.storage.local.set({ excludedSites: 'https://127.0.0.1:1234/some/path' }));
  const callsBefore = gatewayCalls.length;
  const pageE = await ctx.newPage();
  await pageE.goto(`${base}/a2`);
  await pageE.bringToFront();
  for (let i = 0; i < 8; i++) {
    await pageE.mouse.move(10 + i * 5, 10 + i * 5);
    await pageE.waitForTimeout(1000);
  }
  check('excluded site is not sent to gateway', gatewayCalls.length === callsBefore, `calls ${callsBefore} -> ${gatewayCalls.length}`);
} catch (e) {
  check('test run', false, e.stack);
} finally {
  await ctx.close();
  server.close();
}
process.exit(results.every(Boolean) ? 0 : 1);
