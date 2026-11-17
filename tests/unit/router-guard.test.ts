import { describe, expect, it } from 'vitest';
import { RouterGuard } from '../../src/services/router-guard.js';
import type { RouterGuardDeps } from '../../src/services/router-guard.js';
import type { ProjectRow, RoutingRuleRow } from '../../src/types/index.js';

/** 构造最小 ProjectRow 替身（守卫只消费 workspace_id）。 */
function makeProjectRow(workspaceId: string): ProjectRow {
  return {
    id: `proj-${workspaceId}`,
    workspace_id: workspaceId,
    name: workspaceId,
    description: '',
    priority: 0,
    status: 'active',
    worker_session_id: null,
    goals_json: '[]',
    model_pref_json: null,
    health: 'unknown',
    last_review_at: null,
    next_review_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

/** 构造最小 RoutingRuleRow 替身。 */
function makeRuleRow(keyword: string, workspaceId: string): RoutingRuleRow {
  return {
    id: `rule-${keyword}`,
    keyword,
    workspace_id: workspaceId,
    created_by: 'user',
    note: '',
    hit_count: 0,
    enabled: 1,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

/** 记录型替身的聚合视图。 */
interface GuardHarness {
  guard: RouterGuard;
  steers: Array<{ sessionId: string; text: string }>;
  notifies: Array<{ message: string; severity: 'info' | 'warning' | 'critical' }>;
  setRouter: (yes: boolean) => void;
}

/** 组装守卫 + 手写替身（默认 Router 会话；paths 为 workspaceId→path 映射）。 */
function createHarness(options: { paths?: Record<string, string>; rules?: RoutingRuleRow[] } = {}): GuardHarness {
  const steers: GuardHarness['steers'] = [];
  const notifies: GuardHarness['notifies'] = [];
  let router = true;
  const deps: RouterGuardDeps = {
    routingRules: { lookup: (text) => (options.rules ?? []).filter((rule) => text.includes(rule.keyword)) },
    projects: { list: () => Object.keys(options.paths ?? {}).map(makeProjectRow) },
    resolveWorkspacePath: async (workspaceId) => (options.paths ?? {})[workspaceId],
    steer: async (sessionId, text) => {
      steers.push({ sessionId, text });
    },
    notify: async (message, severity) => {
      notifies.push({ message, severity });
      return true;
    },
    isRouter: async () => router,
  };
  return { guard: new RouterGuard(deps), steers, notifies, setRouter: (yes) => { router = yes; } };
}

describe('RouterGuard onToolResult 越权执行告警（FB-5 层1）', () => {
  it('Router 会话 bash 参数含受管 workspace path → notify warning 恰好一次（含 path/toolName/派发建议），5 分钟内不重复', async () => {
    const h = createHarness({ paths: { 'ws-inv': '/root/data/local-inv' } });
    const argsJson = JSON.stringify({ command: 'cd /root/data/local-inv && ls' });
    await h.guard.onToolResult('router-1', 'bash', argsJson);
    expect(h.notifies).toHaveLength(1);
    expect(h.notifies[0]?.severity).toBe('warning');
    expect(h.notifies[0]?.message).toContain('/root/data/local-inv');
    expect(h.notifies[0]?.message).toContain('bash');
    expect(h.notifies[0]?.message).toContain('supervisor_task_assign');
    await h.guard.onToolResult('router-1', 'bash', argsJson);
    expect(h.notifies).toHaveLength(1);
  });

  it('非 Router 会话 → 无 notify 无 steer', async () => {
    const h = createHarness({ paths: { 'ws-inv': '/root/data/local-inv' }, rules: [makeRuleRow('内存测试', 'ws-mem')] });
    h.setRouter(false);
    await h.guard.onToolResult('worker-1', 'bash', JSON.stringify({ command: 'cd /root/data/local-inv' }));
    await h.guard.onUserMessage('worker-1', '跑一轮内存测试');
    expect(h.notifies).toHaveLength(0);
    expect(h.steers).toHaveLength(0);
  });

  it("路径后边界：'/root/data/local-inv' 不匹配 '/root/data/local-inv2'（Windows 反斜杠同样）", async () => {
    const h = createHarness({ paths: { 'ws-inv': '/root/data/local-inv', 'ws-win': 'E:\\work\\inv' } });
    await h.guard.onToolResult('router-1', 'bash', JSON.stringify({ command: 'ls /root/data/local-inv2' }));
    await h.guard.onToolResult('router-1', 'bash', JSON.stringify({ command: 'dir E:\\work\\inv2\\out' }));
    expect(h.notifies).toHaveLength(0);
  });

  it('Windows 路径在 argsJson 中以 JSON 转义形态命中，且后边界正确', async () => {
    const h = createHarness({ paths: { 'ws-win': 'E:\\work\\inv' } });
    await h.guard.onToolResult('router-1', 'bash', JSON.stringify({ command: 'type E:\\work\\inv\\notes.txt' }));
    expect(h.notifies).toHaveLength(1);
    expect(h.notifies[0]?.message).toContain('E:\\work\\inv');
  });

  it('5 分钟窗口过期后再次越权 → 重新告警（注入时钟验证惰性清理）', async () => {
    let clock = 1_000_000;
    const notifies: string[] = [];
    const guard = new RouterGuard({
      routingRules: { lookup: () => [] },
      projects: { list: () => [makeProjectRow('ws-inv')] },
      resolveWorkspacePath: async () => '/root/data/local-inv',
      steer: async () => {},
      notify: async (message) => {
        notifies.push(message);
        return true;
      },
      isRouter: async () => true,
      now: () => clock,
    });
    const argsJson = JSON.stringify({ command: 'cd /root/data/local-inv' });
    await guard.onToolResult('router-1', 'bash', argsJson);
    await guard.onToolResult('router-1', 'bash', argsJson);
    expect(notifies).toHaveLength(1);
    clock += 5 * 60_000 + 1;
    await guard.onToolResult('router-1', 'bash', argsJson);
    expect(notifies).toHaveLength(2);
  });
});

describe('RouterGuard onUserMessage 路由预检与纠正即学习（FB-6）', () => {
  it('用户消息命中路由规则 → steer 注入（含 workspaceId 与关键词、supervisor_task_assign），同关键词 10 分钟去抖', async () => {
    const h = createHarness({ rules: [makeRuleRow('内存测试', 'ws-mem')] });
    await h.guard.onUserMessage('router-1', '帮我跑 4 轮内存测试');
    expect(h.steers).toHaveLength(1);
    expect(h.steers[0]?.sessionId).toBe('router-1');
    expect(h.steers[0]?.text).toContain('ws-mem');
    expect(h.steers[0]?.text).toContain('内存测试');
    expect(h.steers[0]?.text).toContain('supervisor_task_assign');
    await h.guard.onUserMessage('router-1', '再跑一轮内存测试');
    expect(h.steers).toHaveLength(1);
  });

  it('未命中路由规则但命中纠正关键词 → steer 内容含 supervisor_routing_save', async () => {
    const h = createHarness();
    await h.guard.onUserMessage('router-1', '停止，不是你跑');
    expect(h.steers).toHaveLength(1);
    expect(h.steers[0]?.text).toContain('supervisor_routing_save');
  });

  it('未命中规则且无纠正关键词 → 不注入', async () => {
    const h = createHarness();
    await h.guard.onUserMessage('router-1', '帮我总结今天的进展');
    expect(h.steers).toHaveLength(0);
  });

  it('steer 抛错不向上传播，且失败不记去抖、后续调用可重试成功', async () => {
    const steers: Array<{ sessionId: string; text: string }> = [];
    let fail = true;
    const guard = new RouterGuard({
      routingRules: { lookup: () => [] },
      projects: { list: () => [] },
      resolveWorkspacePath: async () => undefined,
      steer: async (sessionId, text) => {
        if (fail) throw new Error('会话已结束');
        steers.push({ sessionId, text });
      },
      notify: async () => true,
      isRouter: async () => true,
    });
    await expect(guard.onUserMessage('router-1', '停下')).resolves.toBeUndefined();
    fail = false;
    await expect(guard.onUserMessage('router-1', '停下')).resolves.toBeUndefined();
    expect(steers).toHaveLength(1);
  });
});
