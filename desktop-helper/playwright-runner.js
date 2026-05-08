/* Playwright runner — the AI's own browser, separate from your main Chrome.
 *
 * Lazy-launches a single Chromium instance the first time a command needs
 * one, keeps it alive across commands, and tracks multiple pages by id so
 * the model can juggle several tabs.
 */

import { chromium } from 'playwright';

let browser = null;
let defaultHeadless = false;
const pages = new Map();   // pageId -> Page
let nextPageId = 1;

export function setDefaults({ headless } = {}) {
  if (typeof headless === 'boolean') defaultHeadless = headless;
}

async function ensureBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: defaultHeadless,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  browser.on('disconnected', () => { browser = null; pages.clear(); });
  return browser;
}

async function getOrCreatePage(pageId) {
  await ensureBrowser();
  if (pageId && pages.has(pageId)) return { pageId, page: pages.get(pageId) };
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = await ctx.newPage();
  const id = `p${nextPageId++}`;
  pages.set(id, page);
  page.on('close', () => pages.delete(id));
  return { pageId: id, page };
}

export async function pwNavigate({ pageId, url }) {
  if (!url || typeof url !== 'string') throw new Error('url required');
  const { pageId: id, page } = await getOrCreatePage(pageId);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return { pageId: id, url: page.url(), title: await page.title() };
}

export async function pwClick({ pageId, selector }) {
  if (!selector) throw new Error('selector required');
  const { pageId: id, page } = await getOrCreatePage(pageId);
  await page.click(selector, { timeout: 10_000 });
  return { pageId: id };
}

export async function pwFill({ pageId, selector, text }) {
  if (!selector) throw new Error('selector required');
  if (typeof text !== 'string') throw new Error('text required');
  const { pageId: id, page } = await getOrCreatePage(pageId);
  await page.fill(selector, text, { timeout: 10_000 });
  return { pageId: id };
}

export async function pwPress({ pageId, selector, key }) {
  if (!key) throw new Error('key required');
  const { pageId: id, page } = await getOrCreatePage(pageId);
  if (selector) await page.press(selector, key, { timeout: 10_000 });
  else await page.keyboard.press(key);
  return { pageId: id };
}

export async function pwGetText({ pageId, selector }) {
  const { pageId: id, page } = await getOrCreatePage(pageId);
  const text = selector
    ? await page.locator(selector).first().innerText({ timeout: 10_000 })
    : await page.locator('body').innerText();
  return { pageId: id, text: String(text).slice(0, 16_000) };
}

export async function pwGetAttribute({ pageId, selector, name }) {
  if (!selector || !name) throw new Error('selector and name required');
  const { pageId: id, page } = await getOrCreatePage(pageId);
  const value = await page.locator(selector).first().getAttribute(name, { timeout: 10_000 });
  return { pageId: id, value };
}

export async function pwWaitFor({ pageId, selector, timeout }) {
  if (!selector) throw new Error('selector required');
  const { pageId: id, page } = await getOrCreatePage(pageId);
  await page.waitForSelector(selector, { timeout: timeout ?? 15_000 });
  return { pageId: id };
}

export async function pwScreenshot({ pageId, fullPage }) {
  const { pageId: id, page } = await getOrCreatePage(pageId);
  const buf = await page.screenshot({ fullPage: !!fullPage, type: 'jpeg', quality: 70 });
  return { pageId: id, dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`, url: page.url(), title: await page.title() };
}

export async function pwEval({ pageId, code }) {
  if (typeof code !== 'string' || !code.trim()) throw new Error('code required');
  const { pageId: id, page } = await getOrCreatePage(pageId);
  const result = await page.evaluate(code);
  return { pageId: id, result };
}

export async function pwListPages() {
  if (!browser) return [];
  const out = [];
  for (const [id, p] of pages) {
    out.push({ pageId: id, url: p.url(), title: await p.title().catch(() => '') });
  }
  return out;
}

export async function pwClosePage({ pageId }) {
  const page = pages.get(pageId);
  if (!page) throw new Error(`page ${pageId} not found`);
  await page.close();
  pages.delete(pageId);
  return { ok: true, pageId };
}

export async function pwShutdown() {
  if (browser) {
    try { await browser.close(); } catch { /* noop */ }
    browser = null;
    pages.clear();
  }
}
