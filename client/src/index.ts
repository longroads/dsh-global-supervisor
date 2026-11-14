/**
 * dsh-global-supervisor client：设置面板（Router 身份管理唯一动态入口）。
 * 契约见 docs/UI_PANEL_PLAN.md：apply(ctx) → slots.register('settings.section') → React 元素。
 * 第一版零 UI 库依赖（原生元素 + 内联样式），react 经 host 模块表注入（构建 external）。
 */
import { createElement as h, useCallback, useEffect, useState } from 'react';

/** client ctx 的最小服务面（slots 注入，见 package.json client.inject）。 */
interface ClientContext {
  slots?: {
    register(meta: Record<string, unknown>, build: (props?: Record<string, unknown>) => unknown): (() => void) | unknown;
    inject(slot: string, ready: () => void): void;
  };
  effect?(fn: () => unknown, label?: string): unknown;
}

/** GET /global-supervisor/settings 响应。 */
interface SettingsPayload {
  router: { mode: string; sessionId: string; workspaceId?: string; claimedAt: string } | null;
  workspaces: Array<{ id: string; title: string; path: string; sessionIds: readonly string[] }>;
}

function api(path: string): string {
  const relative = path.replace(/^\/+/, '');
  if (typeof document === 'undefined') return `/${relative}`;
  return new URL(relative, document.baseURI).pathname;
}

const style = {
  card: { display: 'grid', gap: '12px', padding: '16px', fontSize: '14px' } as Record<string, string>,
  row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } as Record<string, string>,
  label: { minWidth: '72px', opacity: '0.8' } as Record<string, string>,
  select: { padding: '4px 8px', minWidth: '220px' } as Record<string, string>,
  button: { padding: '6px 16px', cursor: 'pointer' } as Record<string, string>,
  hint: { opacity: 0.7, fontSize: '12px' } as Record<string, string>,
};

/** 面板组件：加载状态 → 选择模式/工作区/会话 → 提交指派。 */
function SupervisorPanel(): unknown {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'session' | 'workspace'>('session');
  const [workspaceId, setWorkspaceId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');

  const reload = useCallback(() => {
    setError('');
    fetch(api('global-supervisor/settings'))
      .then((r) => r.json() as Promise<SettingsPayload>)
      .then((payload) => {
        setData(payload);
        if (payload.router) {
          setMode(payload.router.mode === 'workspace' ? 'workspace' : 'session');
          setSessionId(payload.router.sessionId);
          setWorkspaceId(payload.router.workspaceId ?? '');
        }
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const submit = useCallback(() => {
    setBusy(true);
    setResult('');
    const body = mode === 'workspace' ? { mode, sessionId, workspaceId } : { mode, sessionId };
    fetch(api('global-supervisor/claim'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (r) => ({ ok: r.ok, payload: await r.json() as Record<string, unknown> }))
      .then(({ ok, payload }) => {
        setResult(ok ? '已保存（即时生效）' : `失败：${String(payload['error'] ?? payload['reason'] ?? 'unknown')}`);
        if (ok) reload();
      })
      .catch((e: unknown) => setResult(`失败：${String(e)}`))
      .finally(() => { setBusy(false); });
  }, [mode, sessionId, workspaceId, reload]);

  if (error !== '') return h('div', { style: style.card }, `加载失败：${error}`);
  if (data === null) return h('div', { style: style.card }, '加载中…');

  const selectedWorkspace = data.workspaces.find((w) => w.id === workspaceId);

  return h('div', { style: style.card },
    h('div', { style: style.row },
      h('span', { style: style.label }, '当前 Router'),
      h('strong', null, data.router
        ? `${data.router.mode === 'workspace' ? '工作区模式' : '会话模式'} · ${data.router.sessionId.slice(0, 18)}…（${data.router.claimedAt.slice(0, 10)} 设置）`
        : '未设置（无预置且未指派）')),
    h('div', { style: style.row },
      h('span', { style: style.label }, '模式'),
      h('label', null, h('input', { type: 'radio', checked: mode === 'session', onChange: () => setMode('session') }), ' 仅指定会话'),
      h('label', null, h('input', { type: 'radio', checked: mode === 'workspace', onChange: () => setMode('workspace') }), ' 整个工作区')),
    mode === 'workspace'
      ? h('div', { style: style.row },
          h('span', { style: style.label }, '工作区'),
          h('select', { style: style.select, value: workspaceId, onChange: (e: Event) => { setWorkspaceId((e.target as HTMLSelectElement).value); setSessionId(''); } },
            h('option', { value: '' }, '— 选择工作区 —'),
            ...data.workspaces.map((w) => h('option', { key: w.id, value: w.id }, `${w.title}（${w.sessionIds.length} 会话）`))))
      : null,
    h('div', { style: style.row },
      h('span', { style: style.label }, 'Router 会话'),
      h('select', { style: style.select, value: sessionId, onChange: (e: Event) => setSessionId((e.target as HTMLSelectElement).value) },
        h('option', { value: '' }, '— 选择会话 —'),
        ...(mode === 'workspace' ? (selectedWorkspace?.sessionIds ?? []) : data.workspaces.flatMap((w) => w.sessionIds))
          .map((s) => h('option', { key: s, value: s }, s))),
      h('span', { style: style.hint }, mode === 'workspace' ? '该工作区下全部会话均为 Router（认领发起者记录）' : '仅该会话可调用 supervisor 工具')),
    h('div', { style: style.row },
      h('button', { style: style.button, disabled: busy || sessionId === '' || (mode === 'workspace' && workspaceId === ''), onClick: submit }, busy ? '保存中…' : '保存'),
      result !== '' ? h('span', null, result) : null),
    h('div', { style: style.hint }, '保存后即时生效（无需重启）；此前创建的定时巡检投递目标不自动迁移，请重设调度。'));
}

/** client 入口：注册全局监督设置面板（slots 服务缺失时降级为不注册）。 */
export function apply(ctx: ClientContext): void {
  if (!ctx.slots || typeof ctx.slots.register !== 'function') {
    console.warn('[global-supervisor] host slots 服务不可用——设置面板未注册');
    return;
  }
  const dispose = ctx.slots.register(
    {
      name: 'settings.section',
      id: 'global-supervisor',
      order: 60,
      label: () => '全局监督',
    },
    () => h(SupervisorPanel),
  );
  ctx.slots.inject('settings.section', () => undefined);
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => (typeof dispose === 'function' ? dispose() : undefined), 'global-supervisor: settings section');
  }
}
