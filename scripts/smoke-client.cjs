// 本地执行 client bundle：验证 factory 结构、exports（含 inject）、apply 行为
const fs = require('node:fs');
const path = require('node:path');
const bundle = fs.readFileSync(path.resolve(__dirname, '../client/client.js'), 'utf8');

const calls = [];
global.window = {
  __ModuleLoader__: {
    load(mod) {
      calls.push(['load', mod.id]);
      const requireShim = (name) => {
        calls.push(['require', name]);
        if (name === 'react') {
          return { createElement: (...a) => ({ type: a[0] }), useCallback: (f) => f, useEffect: () => undefined, useState: (v) => [typeof v === 'function' ? v() : v, () => undefined] };
        }
        return {};
      };
      const api = mod.factory(requireShim);
      calls.push(['exports', Object.keys(api).join(',')]);
      if (typeof api.apply === 'function') {
        const fakeSlots = {
          inject: (slot, cb) => { calls.push(['slots.inject', slot]); cb(); },
          register: (meta, build) => { calls.push(['slots.register', meta.name, meta.id]); calls.push(['element', String(build && build() && build().type)]); return () => undefined; },
        };
        api.apply({ slots: fakeSlots, effect: (f) => { calls.push(['effect']); return f(); } });
      } else {
        calls.push(['NO apply export']);
      }
    },
  },
};
global.fetch = (url, opts) => { calls.push(['fetch', String(url), (opts && opts.body) || '']); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); };
global.document = { baseURI: 'http://localhost:1/' };

eval(bundle);
console.log(calls.map((c) => c.join(' | ')).join('\n'));
