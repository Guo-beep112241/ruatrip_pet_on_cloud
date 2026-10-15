#!/usr/bin/env node
/**
 * 界面截图脚本（无头 Chrome + DevTools 协议）。
 *
 * 为什么用无头而不是直接截屏：
 *   - 不需要「辅助功能」权限，也不用打开用户的浏览器
 *   - 能精确控制视口尺寸，移动端 / 电脑端各出一套
 *   - 产物干净（没有地址栏、书签栏、桌面背景）
 *
 * 用法：
 *   node scripts/screenshots.mjs                        # 默认连 localhost:8787
 *   node scripts/screenshots.mjs --base http://localhost:8787 \
 *        --email demo@ruatrip.app --password ruatrip2026 \
 *        --out docs/screenshots --only cabin,hut
 *
 * 依赖：本机安装的 Chrome（macOS 默认路径）。零 npm 依赖 ——
 * 用 Node 内置的 WebSocket 直连 CDP。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = arg('base', 'http://localhost:8787');
const EMAIL = arg('email', 'demo@ruatrip.app');
const PASSWORD = arg('password', 'ruatrip2026');
const OUT = resolve(arg('out', 'docs/screenshots'));
const PORT = Number(arg('port', '9333'));
const ONLY = arg('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** 视口预设：移动端与电脑端各一套（断点是 768px） */
const VIEWPORTS = {
  mobile: { width: 390, height: 844, dsf: 2, mobile: true },
  desktop: { width: 1440, height: 900, dsf: 1, mobile: false },
};

/** 要截的页面。key 会出现在文件名里，hash 是前端路由 */
const PAGES = [
  /**
   * pre：截图前执行的 JS。用于「需要点一下才能看到」的界面
   * （例如问卷表单藏在欢迎页的按钮后面）。
   * 用 .click() 而不是模拟鼠标坐标，更稳定也更好读。
   */
  {
    key: 'onboarding',
    hash: '#/welcome',
    label: '首次使用引导',
  },
  {
    key: 'survey',
    hash: '#/welcome',
    label: '偏好问卷',
    pre: `(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /开始偏好问卷/.test(b.textContent || ''));
      if (btn) btn.click();
      return Boolean(btn);
    })()`,
  },
  { key: 'cabin', hash: '#/cabin', label: '宠物舱' },
  { key: 'hut', hash: '#/hut', label: '真心话小屋' },
  { key: 'travel', hash: '#/travel', label: '旅途与手账' },
  { key: 'checkin', hash: '#/checkin', label: '打卡探索' },
  { key: 'capsule', hash: '#/capsule', label: '时光胶囊' },
  { key: 'profile', hash: '#/profile', label: '我的' },
];

/* ------------------------------------------------------------------ */
/* CDP 客户端                                                          */
/* ------------------------------------------------------------------ */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else res(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((res, reject) => {
      this.pending.set(id, { resolve: res, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  }

  once(method, timeoutMs = 30000) {
    return new Promise((res, reject) => {
      const fn = (params) => {
        this.listeners.get(method).delete(fn);
        res(params);
      };
      if (!this.listeners.has(method)) this.listeners.set(method, new Set());
      this.listeners.get(method).add(fn);
      setTimeout(() => reject(new Error(`等待 ${method} 超时`)), timeoutMs);
    });
  }

  close() {
    this.ws.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForEndpoint(url, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  throw new Error(`等待 ${url} 超时`);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/** 用 fetch 探测（避免 require 在 ESM 里不可用） */
async function resolveChrome() {
  const { access } = await import('node:fs/promises');
  for (const p of CHROME_CANDIDATES) {
    try {
      await access(p);
      return p;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

const chromePath = await resolveChrome();
if (!chromePath) {
  console.error('找不到 Chrome。请用 --chrome 指定，或安装 Google Chrome。');
  process.exit(1);
}

// 1) 取会话 token（登录，失败则注册）
let token = '';
try {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const json = await res.json();
  if (json?.ok) token = json.data.token;
} catch (error) {
  console.error('登录失败：', error.message);
}

if (!token) {
  console.error(`无法登录 ${EMAIL}。请先在服务端注册该账号，或用 --email/--password 指定已有账号。`);
  process.exit(1);
}
console.log(`✓ 已登录 ${EMAIL}`);

// 2) 起无头 Chrome
const profile = join(tmpdir(), `ruatrip-shots-${Date.now()}`);
mkdirSync(profile, { recursive: true });
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=1',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let cdp;
try {
  await waitForEndpoint(`http://127.0.0.1:${PORT}/json/version`);
  console.log('✓ 无头 Chrome 已就绪');

  // 3) 开一个标签页并接上 CDP
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
  });
  cdp = new Cdp(ws);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  /**
   * 先访问一次源，才能写 localStorage；写完必须**整页重载**。
   *
   * 踩过的坑：只改 hash 的话 SPA 不会重新加载，
   * 内存里仍是「未登录」状态（首屏 bootstrap 已经拿到 401 了），
   * 结果截出来全是登录页。
   */
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await sleep(1500);
  await cdp.send('Runtime.evaluate', {
    expression: `localStorage.setItem('ruatrip.token', ${JSON.stringify(token)})`,
  });

  // 整页重载，让应用以已登录状态重新 bootstrap
  const reloaded = cdp.once('Page.loadEventFired').catch(() => null);
  await cdp.send('Page.reload', { ignoreCache: false });
  await reloaded;
  await sleep(2000);

  // 自检：如果仍然停在登录页，说明 token 没生效，早点报错而不是产出一堆登录页截图
  const check = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({ hasToken: Boolean(localStorage.getItem('ruatrip.token')), authPage: /登录后回到你的毛绒搭子身边/.test(document.body.innerText) })`,
    returnByValue: true,
  });
  const state = JSON.parse(check.result.value);
  if (!state.hasToken || state.authPage) {
    throw new Error(`token 未生效（hasToken=${state.hasToken}, authPage=${state.authPage}），截图会全是登录页`);
  }
  console.log('✓ 已登录状态确认');

  mkdirSync(OUT, { recursive: true });

  // 4) 逐页 × 逐视口截图
  const shots = [];
  for (const viewportName of ['mobile', 'desktop']) {
    const vp = VIEWPORTS[viewportName];
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.dsf,
      mobile: vp.mobile,
    });

    for (const page of PAGES) {
      if (ONLY.length && !ONLY.includes(page.key)) continue;

      /**
       * 每页都带一个查询参数强制「新文档加载」。
       * 只改 hash 不会重新 bootstrap，页面数据可能是上一页的。
       */
      // 注意：必须保留 '#'，否则没有 hash 片段，路由会落到默认的宠物舱
      const loaded = cdp.once('Page.loadEventFired').catch(() => null);
      await cdp.send('Page.navigate', { url: `${BASE}/?s=${page.key}${page.hash}` });
      await loaded;
      // 等动画与数据请求落定（呼吸动画、首屏聚合请求）
      await sleep(vp.mobile ? 2400 : 2000);

      if (page.pre) {
        await cdp.send('Runtime.evaluate', { expression: page.pre, returnByValue: true });
        await sleep(1200);
      }

      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });
      const file = join(OUT, `${page.key}-${viewportName}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      shots.push(file);
      console.log(`  ✓ ${page.key}-${viewportName}.png  (${page.label} · ${vp.width}×${vp.height})`);
    }
  }

  console.log(`\n✓ 共输出 ${shots.length} 张到 ${OUT}`);
} finally {
  cdp?.close();
  chrome.kill('SIGKILL');
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
