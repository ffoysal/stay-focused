(() => {
  const IDLE_SECONDS = 60;
  const DEFAULT_THRESHOLD_SECONDS = 60;
  const PROGRESS_EVERY_SECONDS = 5;
  const MIN_TEXT_CHARS = 300;

  let activeSeconds = 0;
  let started = false;
  let done = false;
  let lastInput = Date.now();
  let readingThreshold = DEFAULT_THRESHOLD_SECONDS;

  const applyThreshold = (value) => {
    const n = Number(value);
    readingThreshold = n >= 1 ? n : DEFAULT_THRESHOLD_SECONDS;
  };
  chrome.storage.local.get('readingThresholdSeconds').then((c) => applyThreshold(c.readingThresholdSeconds));
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.readingThresholdSeconds) applyThreshold(changes.readingThresholdSeconds.newValue);
  });

  for (const evt of ['mousemove', 'keydown', 'scroll', 'wheel', 'click', 'touchstart']) {
    addEventListener(evt, () => (lastInput = Date.now()), { passive: true, capture: true });
  }

  const isActive = () =>
    document.visibilityState === 'visible' &&
    document.hasFocus() &&
    Date.now() - lastInput < IDLE_SECONDS * 1000;

  const CHROME_SELECTOR = 'nav, aside, header, footer, [role="navigation"], [role="banner"], [role="complementary"]';

  // Collect prose (paragraphs, headings, list items, code) and skip site chrome such as sidebars and menus,
  // so the classifier sees the article instead of a wall of navigation links.
  function extractText() {
    const root = document.querySelector('article, main, [role="main"]') || document.body;
    const prose = [...root.querySelectorAll('h1, h2, h3, h4, p, li, pre, blockquote')]
      .filter((el) => !el.closest(CHROME_SELECTOR))
      .map((el) => (el.innerText || '').trim())
      .filter(Boolean)
      .join('\n');
    const text = prose.replace(/\s+/g, ' ').trim();
    if (text.length >= MIN_TEXT_CHARS) return text;
    return (root.innerText || '').replace(/\s+/g, ' ').trim();
  }

  // The background worker can be gone (extension reloaded); treat that as "stop tracking".
  // After the extension is reloaded, this orphaned script keeps running and chrome.runtime is gone.
  const contextAlive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  const send = async (msg) => {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch {
      return null;
    }
  };

  async function reportCandidate() {
    const text = extractText();
    if (text.length < MIN_TEXT_CHARS) {
      send({ type: 'badge', text: 'SHORT', color: '#6b7280' });
      console.log(`[stay-focused] skipped: only ${text.length} chars of text (need ${MIN_TEXT_CHARS})`);
      done = true;
      return;
    }
    const res = await send({ type: 'candidate', url: location.href, title: document.title, text });
    console.log('[stay-focused] classifier result:', res);
    if (!res?.reading) done = true;
  }

  async function reportProgress() {
    const res = await send({ type: 'progress', activeSeconds });
    if (!res?.continue) done = true;
  }

  // Why the timer is paused, shown on the badge so a stalled count can be diagnosed without DevTools.
  const pausedReason = () => {
    if (document.visibilityState !== 'visible') return 'HID';
    if (!document.hasFocus()) return 'NOFOC';
    return 'IDLE';
  };
  let pausedTicks = 0;

  const timer = setInterval(() => {
    if (!contextAlive()) {
      clearInterval(timer); // stale copy left in an open tab after an extension reload
      return;
    }
    if (done) return;
    if (!isActive()) {
      if (!started && ++pausedTicks % 2 === 0) send({ type: 'badge', text: pausedReason(), color: '#d97706' });
      return;
    }
    activeSeconds++;
    if (!started && activeSeconds % 5 === 0) send({ type: 'badge', text: String(activeSeconds), color: '#6b7280' });
    if (!started && activeSeconds >= readingThreshold) {
      started = true;
      console.log(`[stay-focused] ${readingThreshold}s of active reading reached, asking background to classify`);
      reportCandidate();
    } else if (started && activeSeconds % PROGRESS_EVERY_SECONDS === 0) {
      reportProgress();
    }
  }, 1000);

  function showNudge({ title, summary, reason, canReturn, canGoBack }) {
    document.getElementById('stay-focused-host')?.remove();

    const host = document.createElement('div');
    host.id = 'stay-focused-host';
    host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });

    const reasons = {
      tab: 'You switched tabs.',
      app: 'You switched to another app.',
      idle: 'You went idle.',
      navigated: 'You navigated away.',
      closed: 'You closed the page.',
    };

    shadow.innerHTML = `
      <style>
        .card { font: 14px/1.45 system-ui, sans-serif; width: 320px; padding: 16px; border-radius: 12px;
                background: #1f2937; color: #f9fafb; box-shadow: 0 10px 30px rgba(0,0,0,.35); }
        h2 { margin: 0 0 6px; font-size: 16px; }
        p { margin: 0 0 8px; }
        .muted { color: #9ca3af; }
        .row { display: flex; gap: 8px; margin-top: 12px; }
        button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 0; cursor: pointer; }
        .primary { background: #f59e0b; color: #111827; font-weight: 600; }
        .secondary { background: #374151; color: #f9fafb; }
      </style>
      <div class="card" role="alertdialog" aria-label="Losing focus">
        <h2>You're losing focus</h2>
        <p class="muted" data-reason></p>
        <p>You were reading: <strong data-title></strong></p>
        <p class="muted" data-summary></p>
        <div class="row"></div>
      </div>`;

    shadow.querySelector('[data-reason]').textContent = reasons[reason] || '';
    shadow.querySelector('[data-title]').textContent = title;
    shadow.querySelector('[data-summary]').textContent = summary;

    const row = shadow.querySelector('.row');
    const addButton = (label, cls, action) => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      b.addEventListener('click', () => {
        host.remove();
        send({ type: 'action', action });
      });
      row.append(b);
    };
    if (canReturn) addButton('Back to reading', 'primary', 'return');
    if (canGoBack) addButton('Go back', 'primary', 'goBack');
    addButton('Dismiss', 'secondary', 'dismiss');

    document.documentElement.append(host);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'nudge') {
      showNudge(msg);
      sendResponse(true);
    }
  });
})();
