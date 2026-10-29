const TEXT_FIELDS = ['baseUrl', 'apiKey', 'model', 'excludedSites'];
const NUMBER_DEFAULTS = { readingThresholdSeconds: 60, maxNudges: 1 };
const FIELDS = [...TEXT_FIELDS, ...Object.keys(NUMBER_DEFAULTS)];
const $ = (id) => document.getElementById(id);

chrome.storage.local.get(FIELDS).then((saved) => {
  for (const f of FIELDS) $(f).value = saved[f] ?? NUMBER_DEFAULTS[f] ?? '';
});

function readValues() {
  const values = Object.fromEntries(TEXT_FIELDS.map((f) => [f, $(f).value.trim()]));
  for (const [f, fallback] of Object.entries(NUMBER_DEFAULTS)) {
    values[f] = Math.max(1, Math.floor(Number($(f).value)) || fallback);
    $(f).value = values[f];
  }
  return values;
}

$('save').addEventListener('click', async () => {
  const values = readValues();
  await chrome.storage.local.set(values);
  chrome.action.setBadgeText({ text: '' });
  chrome.action.setTitle({ title: 'Stay Focused settings' });
  $('status').textContent = 'Saved';
  setTimeout(() => ($('status').textContent = ''), 2000);
});

$('test').addEventListener('click', async () => {
  const values = readValues();
  await chrome.storage.local.set(values);
  $('result').textContent = 'Testing…';
  const res = await chrome.runtime.sendMessage({ type: 'testGateway' });
  $('result').textContent = res.ok
    ? `Connected. Gateway replied: ${JSON.stringify(res.result)}`
    : `Failed: ${res.error}`;
});
