// 渲染级 QA：用最小 React hooks 模拟真实驱动 SupervisorPanel 渲染，
// 复现并守卫升级窗口的混合版本场景（旧服务端 payload 无 update 字段 → 必须不崩溃）。
// 0.5.4 崩溃事故（data.update.updateAvailable 读 undefined）的回归门禁。
const fs = require('node:fs');
const path = require('node:path');
const bundle = fs.readFileSync(path.resolve(__dirname, '../client/client.js'), 'utf8');

// --- 最小 React 模拟：可驱动的 useState + 同步 useEffect ---
let hookStates = [];
let hookIdx = 0;
let pending = [];

const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useCallback: (f) => f,
  useEffect: (fn) => { fn(); },
  useState: (init) => {
    const i = hookIdx++;
    if (!(i in hookStates)) hookStates[i] = typeof init === 'function' ? init() : init;
    return [hookStates[i], (v) => pending.push([i, typeof v === 'function' ? v(hookStates[i]) : v])];
  },
};

function collectText(node, out) {
  if (typeof node === 'string') { out.push(node); return; }
  if (Array.isArray(node)) { node.forEach((n) => collectText(n, out)); return; }
  if (node && typeof node === 'object') {
    if (node.props && typeof node.props === 'object') {
      for (const key of Object.keys(node.props)) {
        const v = node.props[key];
        if (typeof v === 'string') out.push(v);
      }
    }
    collectText(node.children, out);
  }
}

async function drive(Comp, rounds = 12) {
  hookStates = [];
  let tree = null;
  for (let r = 0; r < rounds; r += 1) {
    hookIdx = 0;
    pending = [];
    tree = Comp();
    // 先让 fetch 链的微任务把 setState 排入 pending，再统一落盘（不可提前重置，否则吞更新）
    await new Promise((res) => setImmediate(res));
    const n = pending.length;
    for (const [i, v] of pending) hookStates[i] = v;
    if (n === 0) {
      await new Promise((res) => setImmediate(res));
      if (pending.length === 0) break;
    }
  }
  return tree;
}

const BUNDLE_CJS = bundle;

async function scenario(name, settingsPayload, assertions) {
  let Panel = null;
  const fetchMock = (url) => {
    const u = String(url);
    if (u.includes('settings')) return Promise.resolve({ ok: true, json: () => Promise.resolve(settingsPayload) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  global.window = {
    __ModuleLoader__: {
      load(mod) {
        const requireShim = (name) => (name === 'react' ? react : {});
        const api = mod.factory(requireShim);
        api.apply({
          slots: {
            inject: (slot, cb) => cb(),
            register: (meta, build) => { Panel = build().type; return () => undefined; },
          },
          effect: () => undefined,
        });
        return api;
      },
    },
  };
  global.document = { baseURI: 'http://localhost:1/' };
  global.fetch = fetchMock;
  eval(BUNDLE_CJS);
  if (typeof Panel !== 'function') throw new Error(`${name}: 未取到面板组件`);
  const tree = await drive(Panel);
  const texts = [];
  collectText(tree, texts);
  assertions(texts);
  console.log(`PASS ${name}`);
}

const BASE = {
  router: null,
  workspaces: [{ id: 'ws-1', title: 'alpha', path: 'E:\\a', sessions: [{ id: 's-1', label: '会话一' }] }],
};

(async () => {
  // 场景一（0.5.4 崩溃复现）：旧服务端 payload 无 update 字段 → 渲染不得抛错
  await scenario('payload-without-update', { ...BASE }, (texts) => {
    if (texts.includes('版本')) throw new Error('update 缺失时不应渲染版本行');
    if (!texts.some((t) => t.includes('当前 Router'))) throw new Error('面板主体未渲染');
  });
  // 场景二：已是最新 → 版本行含当前版本
  await scenario('update-latest', { ...BASE, update: { current: '0.5.5', latest: '0.5.4', updateAvailable: false, checkedAt: '2026-11-16T00:00:00.000Z', source: 'npm', error: null, disabled: false } }, (texts) => {
    if (!texts.some((t) => t.includes('0.5.5') && t.includes('已是最新'))) throw new Error(`未显示已是最新: ${JSON.stringify(texts.filter((t) => t.includes('0.5')))}`);
  });
  // 场景三：有新版 → 升级提示
  await scenario('update-available', { ...BASE, update: { current: '0.5.5', latest: '0.9.9', updateAvailable: true, checkedAt: null, source: 'npmmirror', error: null, disabled: false } }, (texts) => {
    if (!texts.some((t) => t.includes('发现新版本') && t.includes('0.9.9'))) throw new Error(`未显示升级提示: ${JSON.stringify(texts.filter((t) => t.includes('0.9')))}`);
  });
  // 场景四：检查失败 → 展示原因
  await scenario('update-error', { ...BASE, update: { current: '0.5.5', latest: null, updateAvailable: false, checkedAt: null, source: null, error: 'offline', disabled: false } }, (texts) => {
    if (!texts.some((t) => t.includes('检查失败') && t.includes('offline'))) throw new Error('未显示检查失败');
  });
  console.log('渲染级 QA 全部通过');
})().catch((e) => {
  console.error(`FAIL ${e.message}`);
  process.exit(1);
});
