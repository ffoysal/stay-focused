# Stay Focused

A Chrome / Edge (Manifest V3) extension that notices when you are reading a page and nudges you if you
leave it too soon.

1. You stay on a page for **60 seconds** (configurable) of active time.
2. The page text is sent to an OpenAI-compatible LLM gateway, which decides whether it is something worth
   focusing on (article, docs, lesson) or not (feed, shop, dashboard).
3. If it is, and you leave before **15 minutes** of reading are up, an in-page overlay on the tab you moved
   to says you are losing focus and offers a button back to the page.

"Leaving" means switching tabs, switching to another app or window, going idle (no input for 60 seconds),
navigating away, or closing the tab.

## Install

1. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → choose the `extension/` folder.
2. Click the toolbar icon to open the options page and fill in:
   - **Gateway base URL**: everything before `/chat/completions`, e.g. `https://your-gateway.example.com/v1`
   - **API key** (sent as `Authorization: Bearer <key>`)
   - **Model** (default `claude-sonnet-4-5`)
   - **Seconds on a page before it counts as reading** (default 60)
   - **Pop-ups per page when you leave** (default 1)
3. Click **Test connection** to check the gateway settings.
4. Refresh any tabs you want tracked. Tabs opened before the extension was loaded or reloaded don't have it.

The key and settings are stored in `chrome.storage.local` in your browser only.

## Reading the toolbar badge

| Badge | Meaning |
|---|---|
| `5`, `10`, … | Counting active seconds toward the reading threshold |
| `ON` | The page was judged worth reading and is being tracked |
| `OFF` | The page was judged not worth tracking |
| `SHORT` | Under 300 characters of text, skipped |
| `SKIP` | Denylisted site |
| `ERR` | The gateway call failed (hover the icon for the message) |
| `HID` / `NOFOC` / `IDLE` | Counting is paused: tab hidden / page not focused / no input for 60 s |

Debug logs are prefixed `[stay-focused]` in the page console and the service worker console.

## Privacy

- Page text is sent **only** to the gateway you configure, and only after the reading threshold is reached.
- At most the first 6,000 characters of the main content are sent. Navigation, sidebars, headers and footers are skipped.
- Built-in denylist: hosts matching mail, Outlook, banking, PayPal, Google accounts, `login.`, `intranet`,
  `internal`, `.local` and `localhost` are never sent. See `DENY_HOST_PATTERNS` in `extension/background.js`.
- Your own **Excluded sites** (options page, one domain per line, subdomains included) are never sent either.
  They are added to the built-in list; they can't switch it off.

## Development

```sh
npm install
npx playwright install chromium   # once
npm test                          # end-to-end test with a mock gateway
npm run icons                     # re-render PNG icons from extension/icons/*.svg
```

The test loads the extension in Chromium, runs a mock OpenAI-style gateway, and checks that reading is
detected, the overlay appears when you switch tabs, and the pop-up limit is respected. It shortens the
reading threshold through the extension's own setting; set `FULL_TIMING=1` to run at the real 60 seconds,
`MAX_NUDGES=n` to change the pop-up limit, and `CHROMIUM_PATH` to use a specific browser binary.

### Layout

```
extension/   the unpacked extension (load this folder in Chrome)
  background.js   service worker: classifier call, session state, leave detection, overlay delivery
  content.js      per-page timer, text extraction, overlay UI
  options.*       settings page
test/        Playwright end-to-end test
scripts/     icon renderer
```

## Limitations

- The overlay can't be shown on `chrome://` pages or the Web Store. It waits and shows on the next page where it can.
- Idle detection uses the system-wide 60-second timer, so reading without touching mouse or keyboard for a
  minute counts as leaving.
- Excluded pages are skipped when the reading threshold is reached, so they show `SKIP` after that point, not from the start.
