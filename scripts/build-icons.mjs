// Renders extension/icons/*.svg into the PNG sizes Chrome needs.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '../extension/icons');
const jobs = [
  { svg: 'icon-small.svg', sizes: [16, 32] },
  { svg: 'icon.svg', sizes: [48, 128] },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
for (const { svg, sizes } of jobs) {
  const markup = fs.readFileSync(path.join(dir, svg), 'utf8').replace(/ width="128" height="128"/, ' width="100%" height="100%"');
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<body style="margin:0;background:transparent">${markup}</body>`);
    await page.screenshot({ path: path.join(dir, `icon-${size}.png`), omitBackground: true });
    console.log(`icon-${size}.png`);
  }
}
await browser.close();
