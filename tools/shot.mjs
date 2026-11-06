// Screenshots of Jisste at four sizes, light and dark, through the main screens, with any console errors.
// npm run dev (in another terminal), then: node tools/shot.mjs [outdir]   BASE=http://localhost:8310 MODE=demo|live|both
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE || 'http://localhost:8310', OUT = process.argv[2] || '/tmp/jisst-shots', MODE = process.env.MODE || 'both';
const SIZES = { desk: { width: 1440, height: 900 }, lap: { width: 1280, height: 800 }, port: { width: 390, height: 844, mobile: true }, land: { width: 844, height: 390, mobile: true } };
const pick = (process.env.SIZES || Object.keys(SIZES).join(',')).split(',');
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

async function run(browser, sizeName, scheme, mode) {
  const sz = SIZES[sizeName];
  const ctx = await browser.newContext({ viewport: { width: sz.width, height: sz.height }, isMobile: !!sz.mobile, hasTouch: !!sz.mobile, deviceScaleFactor: sz.mobile ? 2 : 1, colorScheme: scheme });
  const page = await ctx.newPage();
  const tag = `${mode}-${sizeName}-${scheme}`;
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  const shot = async (name) => { await wait(350); await page.screenshot({ path: `${OUT}/${tag}-${name}.png` }); };
  const mobile = sz.width < 900;
  const tap = async (sel) => { await page.locator(sel).first().click(); await wait(250); };
  const backToList = async () => { if (mobile) await tap('#chathead [data-act="close-chat"]'); };

  await page.goto(BASE + (mode === 'demo' ? '/?demo' : '/'));
  await wait(700);
  await shot('1-welcome');
  if (mode === 'demo') { await page.fill('#dn', 'Ada'); await tap('form[data-form="demo"] .btn'); }
  else { await page.fill('#dv', 'Ada Obi ' + sizeName + scheme); await tap('form[data-form="dev"] .btn'); }
  await wait(mode === 'demo' ? 900 : 2500);
  await shot('2-chats');
  // a new account opens straight into the helper's chat
  if (mobile && await page.locator('#chathead [data-act="close-chat"]').isVisible()) await backToList();
  // the helper agent's chat
  const nav = mobile ? '#tabbar' : '#railtabs';
  if (mode === 'live') { await tap(`${nav} [data-tab="agents"]`); await tap('[data-agent="@jisst:jisste.com"]'); await wait(2500); }
  else await tap('.row[data-room]');
  await shot('3-chat');
  if (await page.locator('.btns button[data-say]').count()) { await tap('.btns button[data-say]'); await wait(mode === 'demo' ? 1600 : 3000); await shot('4-reply'); }
  await page.fill('#msg', 'Hello there, this is a test message'); await wait(150); await page.keyboard.press(mobile ? 'Tab' : 'Enter');
  if (mobile) await tap('#sendbtn');
  await wait(mode === 'demo' ? 1600 : 2500);
  await shot('5-sent');
  await backToList();
  if (mode === 'live') { await tap(`${nav} [data-tab="agents"]`); await tap('[data-agent="@grandprix:jisste.com"]'); await wait(2500); await shot('5b-grandprix'); await backToList(); }
  for (const t of ['feed', 'agents', 'calls', 'you']) { await tap(`${nav} [data-tab="${t}"]`); await wait(t === 'feed' ? 900 : 200); await shot('6-' + t); }
  await tap(`${nav} [data-tab="chats"]`);
  await tap('.top [data-act="new"]'); await shot('7-new');
  await tap('[data-act="group"]'); await shot('8-group');
  await ctx.close();
}

const browser = await chromium.launch();
for (const mode of MODE === 'both' ? ['demo', 'live'] : [MODE]) for (const s of pick) for (const scheme of ['light', 'dark']) {
  try { await run(browser, s, scheme, mode); } catch (e) { errors.push(`${mode}-${s}-${scheme}: FAILED ${e.message.split('\n').slice(0, 3).join(' | ')}`); }
}
await browser.close();
console.log(errors.length ? 'Problems:\n' + errors.join('\n') : 'no console errors');
console.log('shots in', OUT);
