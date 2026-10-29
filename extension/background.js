const IDLE_SECONDS = 60;
const READ_TARGET_SECONDS = 15 * 60;
const MAX_TEXT_CHARS = 6000;
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const DEFAULT_MAX_NUDGES = 1;

// Pages whose content must never be read or sent to the gateway.
const DENY_HOST_PATTERNS = [
  /(^|\.)mail\./,
  /(^|\.)outlook\./,
  /(^|\.)office\.com$/,
  /(^|\.)bank/,
  /banking/,
  /(^|\.)paypal\./,
  /(^|\.)accounts\.google\.com$/,
  /(^|\.)login\./,
  /(^|\.)intranet/,
  /(^|\.)internal\./,
  /\.internal$/,
  /\.local$/,
  /^localhost$/,
];

chrome.idle.setDetectionInterval(IDLE_SECONDS);

// Reading-session state lives in storage.session so it survives service-worker restarts.
// Shape: { tabId, windowId, url, title, summary, pending, reason, nudgeCount, away, nudged, navigatedAway, closed }
// `nudged` means the final allowed nudge was shown; `away` means a nudge was shown and you haven't returned yet.
async function getState() {
  return (await chrome.storage.session.get('state')).state || null;
}
const setState = (state) => chrome.storage.session.set({ state });
const clearState = () => chrome.storage.session.remove('state');

// One domain per line; tolerate pasted URLs ("https://docs.example.com/page") and "*." prefixes.
function parseExcludedSites(text) {
  return String(text || '')
    .split(/[\n,]+/)
    .map((line) =>
      line
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
        .replace(/^\*\./, '')
        .replace(/[/:?#].*$/, ''),
    )
    .filter(Boolean);
}

// A listed domain also covers its subdomains.
const matchesDomain = (hostname, domain) => hostname === domain || hostname.endsWith(`.${domain}`);

async function isDenied(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return true;
    if (DENY_HOST_PATTERNS.some((p) => p.test(hostname))) return true;
    const { excludedSites } = await chrome.storage.local.get('excludedSites');
    return parseExcludedSites(excludedSites).some((d) => matchesDomain(hostname, d));
  } catch {
    return true;
  }
}

const stripHash = (url) => url.split('#')[0];

async function classify(url, title, text) {
  const { baseUrl, apiKey, model } = await chrome.storage.local.get(['baseUrl', 'apiKey', 'model']);
  if (!baseUrl || !apiKey) throw new Error('Gateway not configured (open the extension options)');

  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      temperature: 0,
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content:
            'You decide whether a web page is something a person would sit down and focus on reading ' +
            '(articles, documentation, long-form posts, papers, tutorials, course lessons). Feeds, shopping, dashboards, ' +
            'search results, video pages and app UIs are NOT. The text may include leftover menu or sidebar ' +
            'links; ignore those and judge the main content, using the title and URL as hints. Reply with only JSON: ' +
            '{"reading": boolean, "summary": "<one short sentence on what the page is about>"}',
        },
        { role: 'user', content: `URL: ${url}\nTitle: ${title}\n\n${text.slice(0, MAX_TEXT_CHARS)}` },
      ],
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Gateway returned ${res.status} ${detail}`.trim());
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  const json = content.match(/\{[\s\S]*\}/);
  if (!json) throw new Error('Unparseable classifier reply');
  const parsed = JSON.parse(json[0]);
  return { reading: parsed.reading === true, summary: String(parsed.summary || '') };
}

function setBadge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
}

async function onCandidate(sender, { url, title, text }) {
  if (await isDenied(url)) {
    console.log('[stay-focused] denylisted, not sending:', url);
    setBadge(sender.tab.id, 'SKIP', '#6b7280');
    return { reading: false };
  }
  try {
    console.log('[stay-focused] calling gateway for', url);
    const { reading, summary } = await classify(url, title, text);
    console.log('[stay-focused] classified:', { reading, summary });
    if (!reading) {
      setBadge(sender.tab.id, 'OFF', '#6b7280');
      return { reading: false };
    }
    setBadge(sender.tab.id, 'ON', '#059669');
    await setState({
      tabId: sender.tab.id,
      windowId: sender.tab.windowId,
      url,
      title,
      summary,
      pending: false,
      nudgeCount: 0,
      away: false,
      nudged: false,
    });
    return { reading: true };
  } catch (err) {
    console.warn('[stay-focused]', err.message);
    setBadge(sender.tab.id, 'ERR', '#dc2626');
    chrome.action.setTitle({ title: `Stay Focused: ${err.message}` });
    return { reading: false };
  }
}

async function onProgress(sender, { activeSeconds }) {
  const s = await getState();
  if (!s || s.nudged || s.tabId !== sender.tab.id) return { continue: false };
  if (activeSeconds >= READ_TARGET_SECONDS) {
    await clearState(); // read long enough; leaving is fine now
    return { continue: false };
  }
  return { continue: true };
}

async function onAction(action) {
  const s = await getState();
  if (!s) return;
  if (action === 'return' && !s.closed) {
    await chrome.tabs.update(s.tabId, { active: true });
    await chrome.windows.update(s.windowId, { focused: true });
  } else if (action === 'goBack') {
    await chrome.tabs.goBack(s.tabId).catch(() => {});
  }
  if (s.nudged) await clearState(); // the final nudge for this page has been acted on
}

async function onTestGateway() {
  try {
    const result = await classify('https://example.com/article', 'Test article', 'This is a connection test. '.repeat(20));
    return { ok: true, result };
  } catch (err) {
    // fetch() failures (DNS, VPN, TLS, CORS) surface as a bare TypeError.
    return { ok: false, error: err.name === 'TypeError' ? `Network error reaching the gateway (${err.message}). Check the URL and VPN.` : err.message };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    candidate: () => onCandidate(sender, msg),
    progress: () => onProgress(sender, msg),
    badge: async () => setBadge(sender.tab.id, msg.text, msg.color),
    action: () => onAction(msg.action),
    testGateway: onTestGateway,
  };
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler().then(sendResponse);
  return true;
});

// Flag that the reader left; the overlay is shown by deliver() once there is a tab to show it on.
async function markLeft(reason, extra = {}) {
  const s = await getState();
  if (!s || s.pending || s.nudged || s.away) return;
  await setState({ ...s, pending: true, reason, ...extra });
}

async function deliver() {
  const s = await getState();
  if (!s || !s.pending || s.nudged) return;

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;

  const onReadingTab = tab.id === s.tabId && !s.navigatedAway;
  // Switched away and straight back before anything was shown: nothing to nudge about.
  // (Leaving the browser or going idle is still nudged, on the reading tab itself.)
  if (onReadingTab && s.reason === 'tab') {
    await setState({ ...s, pending: false, reason: null });
    return;
  }

  const { maxNudges } = await chrome.storage.local.get('maxNudges');
  const allowed = Math.max(1, Math.floor(Number(maxNudges)) || DEFAULT_MAX_NUDGES);
  const nudgeCount = (s.nudgeCount || 0) + 1;
  // A closed or navigated-away page can't be read again, so its nudge is always the last.
  const final = nudgeCount >= allowed || !!s.closed || !!s.navigatedAway;

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'nudge',
      title: s.title,
      summary: s.summary,
      reason: s.reason,
      canReturn: !s.closed && !s.navigatedAway && !onReadingTab,
      canGoBack: !!s.navigatedAway,
    });
    await setState({ ...s, nudgeCount, pending: false, reason: null, nudged: final, away: !onReadingTab });
  } catch {
    // Restricted page or content script not ready; stays pending and retries on the next event.
  }
}

// After a nudge, the next one only arms once you have been back on the reading tab.
async function clearAwayIfBack() {
  const s = await getState();
  if (!s || !s.away) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && tab.id === s.tabId) await setState({ ...s, away: false });
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const s = await getState();
  if (s && tabId !== s.tabId) await markLeft('tab');
  else await clearAwayIfBack();
  await deliver();
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await markLeft('app');
  } else {
    await clearAwayIfBack();
    await deliver();
  }
});

chrome.idle.onStateChanged.addListener(async (idleState) => {
  if (idleState === 'active') await deliver();
  else await markLeft('idle');
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getState();
  if (s && s.tabId === tabId) {
    await markLeft('closed', { closed: true });
    await deliver();
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  const s = await getState();
  if (!s) return;
  if (s.tabId === tabId && changeInfo.url && stripHash(changeInfo.url) !== stripHash(s.url)) {
    await markLeft('navigated', { navigatedAway: true });
  }
  // A pending nudge may be waiting for the tab you moved to (not just the reading tab) to finish loading.
  if (changeInfo.status === 'complete') await deliver();
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
