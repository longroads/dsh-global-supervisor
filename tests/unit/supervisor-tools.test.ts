import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { openDatabase } from '../../src/database/connection.js';
import { DshAgentAdapter } from '../../src/adapters/dsh-agent.js';
import { DshScheduleAdapter } from '../../src/adapters/dsh-schedule.js';
import { DshSessionAdapter } from '../../src/adapters/dsh-session.js';
import { DshWorkspaceAdapter } from '../../src/adapters/dsh-workspace.js';
import { AgentController } from '../../src/services/agent-controller.js';
import { EventManager } from '../../src/services/event-manager.js';
import { ProjectMonitor } from '../../src/services/project-monitor.js';
import { RouterIdentity } from '../../src/services/router-identity.js';
import { SchedulerService } from '../../src/services/scheduler.js';
import { SessionDirectNotifier } from '../../src/services/notifier.js';
import { TaskManager } from '../../src/services/task-manager.js';
import { WorkspaceManager } from '../../src/services/workspace-manager.js';
import { EventRouter } from '../../src/services/event-router.js';
import { RoutingRuleRepository } from '../../src/database/repository/routing-rule-repository.js';
import { ThreadSubscriptionRepository } from '../../src/database/repository/thread-subscription-repository.js';
import type { SupervisorStack } from '../../src/runtime.js';
import { isGuardDenied, makeTool } from '../../src/tools/toolkit.js';
import { buildSupervisorTools } from '../../src/tools/supervisor-tools.js';
import { buildWorkerReportTool } from '../../src/tools/worker-report-tool.js';

const ROUTER_SESSION = 'session-router';
const WORKER_SESSION = 'session-worker-a';

/** 最小执行上下文（仅提供身份与取消信号）。 */
function execOf(sessionId: string): ToolRunContext {
  return { agent: { id: sessionId }, signal: new AbortController().signal } as unknown as ToolRunContext;
}

/** 手工组装服务栈（内存库 + fake ctx；workspaceRegistry 提供 list/resolveByPath/create 假实现）。 */
async function buildStack(): Promise<SupervisorStack> {
  const db = await openDatabase(':memory:');
  const workspaces = [{ id: 'ws-1', path: 'E:\\proj\\p1', title: 'P1', sessionIds: [WORKER_SESSION], createdAt: '', updatedAt: '' }];
  const registry = {
    list: () => [...workspaces],
    resolveByPath: async () => undefined,
    create: async (path: string, title: string) => {
      const created = { id: 'ws-created', path, title, sessionIds: [] as string[], createdAt: '', updatedAt: '' };
      workspaces.push(created);
      return created;
    },
  };
  const fakeCtx = { get: (name: string) => (name === 'workspaceRegistry' ? registry : {}) } as unknown as Context;
  const agentAdapter = new DshAgentAdapter(fakeCtx);
  const taskManager = new TaskManager(db);
  taskManager.projects.create({ id: 'proj-1', workspaceId: 'ws-1', name: 'P1', workerSessionId: WORKER_SESSION });
  return {
    db,
    dataDir: ':memory:',
    taskManager,
    workspaceManager: new WorkspaceManager(new DshWorkspaceAdapter(fakeCtx), db),
    agentController: new AgentController(agentAdapter, taskManager, db),
    scheduler: new SchedulerService(new DshScheduleAdapter(fakeCtx), db),
    eventManager: new EventManager(db),
    sessionAdapter: new DshSessionAdapter(fakeCtx),
    monitor: new ProjectMonitor(taskManager),
    notifier: new SessionDirectNotifier(agentAdapter, () => ROUTER_SESSION),
    routerIdentity: new RouterIdentity(db, ROUTER_SESSION),
    routingRules: new RoutingRuleRepository(db),
    // 派发目标用空实现替身：工具层测试不依赖真实 Agent 服务（派发失败会降级 pending，掩盖路由结果）
    eventRouter: new EventRouter(db, { dispatch: async () => undefined }, () => ROUTER_SESSION),
  };
}

describe('makeTool 权限中间件', () => {
  it('guard 拒绝时返回结构化 forbidden 值', async () => {
    const tool = makeTool({
      name: 't', description: 'd',
      parameters: { type: 'object', properties: {} },
      resultSchema: { type: 'object', properties: {} },
      guard: (caller) => caller === 'allowed',
      guardDeniedMessage: '拒绝',
      handler: () => ({ ok: true }),
    });
    const result = await tool.execute({}, execOf('intruder'));
    expect(isGuardDenied(result)).toBe(true);
    expect((result as { message: string }).message).toBe('拒绝');
  });

  it('guard 通过时 handler 收到调用者会话', async () => {
    let seen = '';
    const tool = makeTool({
      name: 't', description: 'd',
      parameters: { type: 'object', properties: {} },
      resultSchema: { type: 'object', properties: {} },
      guard: () => true,
      guardDeniedMessage: '',
      handler: (_args, ctx) => { seen = ctx.callerSessionId; return { ok: true }; },
    });
    await tool.execute({}, execOf('session-x'));
    expect(seen).toBe('session-x');
  });

  it('timeoutMs 透传到工具定义（长耗时工具的协作式超时预算）', () => {
    const tool = makeTool({
      name: 't', description: 'd',
      parameters: { type: 'object', properties: {} },
      resultSchema: { type: 'object', properties: {} },
      guard: () => true,
      guardDeniedMessage: '',
      timeoutMs: 30_000,
      handler: () => ({ ok: true }),
    });
    expect(tool.timeoutMs).toBe(30_000);
    const withoutBudget = makeTool({
      name: 't2', description: 'd',
      parameters: { type: 'object', properties: {} },
      resultSchema: { type: 'object', properties: {} },
      guard: () => true,
      guardDeniedMessage: '',
      handler: () => ({ ok: true }),
    });
    expect(withoutBudget.timeoutMs).toBeUndefined();
  });
});

describe('supervisor 工具权限与任务流', () => {
  it('非 Router 会话调用一律 forbidden', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const listTool = tools.find((t) => t.name === 'supervisor_workspace_list') as ToolDefinition;
    const denied = await listTool.execute({}, execOf(WORKER_SESSION));
    expect(isGuardDenied(denied)).toBe(true);
  });

  it('Router 创建任务（pending）并出现在列表', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const create = tools.find((t) => t.name === 'supervisor_task_create') as ToolDefinition;
    const list = tools.find((t) => t.name === 'supervisor_task_list') as ToolDefinition;
    const created = await create.execute(
      { project_id: 'proj-1', title: '调研调度策略', priority: 7 },
      execOf(ROUTER_SESSION),
    );
    expect((created as { ok: boolean }).ok).toBe(true);
    const taskId = (created as { task: { id: string } }).task.id;
    const listed = await list.execute({ project_id: 'proj-1' }, execOf(ROUTER_SESSION));
    expect((listed as { count: number }).count).toBe(1);
    const task = stack.taskManager.tasks.byId(taskId);
    expect(task?.status).toBe('pending');
    expect(task?.priority).toBe(7);
  });

  it('workspace_create 未确认时仅返回预览，不创建项目', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const create = tools.find((t) => t.name === 'supervisor_workspace_create') as ToolDefinition;
    const result = await create.execute({ path: 'E:\\tmp\\never-created', title: 'NewProj' }, execOf(ROUTER_SESSION));
    expect((result as { ok: boolean }).ok).toBe(false);
    expect((result as { preview: boolean }).preview).toBe(true);
    expect(stack.workspaceManager.projects.list(true).some((p) => p.name === 'NewProj')).toBe(false);
  });

  it('workspace_create confirmed=true：目录不存在时自动创建并纳管', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const dir = path.join(os.tmpdir(), `gs-create-${Date.now()}`);
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const create = tools.find((t) => t.name === 'supervisor_workspace_create') as ToolDefinition;
    const result = await create.execute({ path: dir, title: 'AutoDir', confirmed: true }, execOf(ROUTER_SESSION));
    expect((result as { ok: boolean }).ok).toBe(true);
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('task_create 接受 workspace_id 并解析为受管项目', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const create = tools.find((t) => t.name === 'supervisor_task_create') as ToolDefinition;
    const result = await create.execute({ workspace_id: 'ws-1', title: '按工作区建任务' }, execOf(ROUTER_SESSION));
    expect((result as { ok: boolean }).ok).toBe(true);
    expect((result as { task: { project_id: string } }).task.project_id).toBe('proj-1');
  });

  it('routing_save 保存偏好后 routing_lookup 命中并递增计数', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const save = tools.find((t) => t.name === 'supervisor_routing_save') as ToolDefinition;
    const lookup = tools.find((t) => t.name === 'supervisor_routing_lookup') as ToolDefinition;
    const saved = await save.execute({ keyword: 'Kubernetes', workspace_id: 'ws-1', note: 'k8s 给 research' }, execOf(ROUTER_SESSION));
    expect((saved as { ok: boolean }).ok).toBe(true);
    expect((saved as { rule: { keyword: string } }).rule.keyword).toBe('kubernetes');
    const hit = await lookup.execute({ text: '帮我跑个 kubernetes 实验' }, execOf(ROUTER_SESSION));
    expect((hit as { matched: number }).matched).toBe(1);
    const rules = (hit as { rules: Array<{ workspace_id: string; hit_count: number }> }).rules;
    expect(rules[0]?.workspace_id).toBe('ws-1');
    expect(rules[0]?.hit_count).toBe(1);
  });

  it('routing_save 指向未纳管 workspace 时拒绝', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const save = tools.find((t) => t.name === 'supervisor_routing_save') as ToolDefinition;
    const result = await save.execute({ keyword: 'misc', workspace_id: 'ws-999' }, execOf(ROUTER_SESSION));
    expect((result as { ok: boolean }).ok).toBe(false);
    expect((result as { error: string }).error).toContain('未纳管');
  });

  it('event_rule_save 保存后 event_list 可见规则与事件流水（observe 默认、状态 pending）', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const save = tools.find((t) => t.name === 'supervisor_event_rule_save') as ToolDefinition;
    const saved = await save.execute({ source_pattern: 'webhook.*', action: 'route_to_router', description: 'webhook 转述' }, execOf(ROUTER_SESSION));
    expect((saved as { ok: boolean }).ok).toBe(true);
    await stack.eventManager.ingest({ eventId: 'wh-t1', source: 'webhook', type: 'issue.opened' });
    const list = tools.find((t) => t.name === 'supervisor_event_list') as ToolDefinition;
    const result = await list.execute({}, execOf(ROUTER_SESSION));
    expect((result as { mode: string }).mode).toBe('observe');
    const events = (result as { events: Array<{ event_id: string; status: string }> }).events;
    expect(events.some((e) => e.event_id === 'wh-t1' && e.status === 'pending')).toBe(true);
    const rules = (result as { rules: Array<{ source_pattern: string; action: string }> }).rules;
    expect(rules.some((r) => r.source_pattern === 'webhook.*' && r.action === 'route_to_router')).toBe(true);
  });

  it('event_rule_save：非法 action 与 route_to_worker 缺 target 拒绝', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const save = tools.find((t) => t.name === 'supervisor_event_rule_save') as ToolDefinition;
    const badAction = await save.execute({ source_pattern: 'webhook.*', action: 'explode' }, execOf(ROUTER_SESSION));
    expect((badAction as { ok: boolean }).ok).toBe(false);
    const noTarget = await save.execute({ source_pattern: 'webhook.*', action: 'route_to_worker' }, execOf(ROUTER_SESSION));
    expect((noTarget as { ok: boolean }).ok).toBe(false);
    expect((noTarget as { error: string }).error).toContain('target_session_id');
  });

  it('event_mode_set：observe/auto 持久化切换，非法值拒绝', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const set = tools.find((t) => t.name === 'supervisor_event_mode_set') as ToolDefinition;
    const switched = await set.execute({ mode: 'auto' }, execOf(ROUTER_SESSION));
    expect((switched as { mode: string }).mode).toBe('auto');
    expect(stack.eventRouter.mode()).toBe('auto');
    const invalid = await set.execute({ mode: 'fast' }, execOf(ROUTER_SESSION));
    expect((invalid as { ok: boolean }).ok).toBe(false);
  });

  it('task_create 带 source_event_id：任务落库来源事件并自动订阅其 Thread', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    await stack.eventManager.ingest({ eventId: 'wh-1', source: 'webhook', type: 'issue.opened', threadId: 'th-1' });
    const create = tools.find((t) => t.name === 'supervisor_task_create') as ToolDefinition;
    const result = await create.execute({ project_id: 'proj-1', title: '来自事件的任务', source_event_id: 'wh-1' }, execOf(ROUTER_SESSION));
    expect((result as { ok: boolean }).ok).toBe(true);
    const task = (result as { task: { id: string; source_event_id: string | null } }).task;
    expect(task.source_event_id).toBe('wh-1');
    expect(new ThreadSubscriptionRepository(stack.db).threadsOfTask(task.id)).toEqual(['th-1']);
  });

  it('event_list 呈现 passed_through：Thread 直通事件不进 Router', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const subscriber = stack.taskManager.createTask({ projectId: 'proj-1', title: '订阅者任务' }, { sessionId: ROUTER_SESSION, role: 'router' });
    stack.taskManager.enqueue(subscriber.id, { sessionId: ROUTER_SESSION, role: 'router' });
    stack.taskManager.markDispatched(subscriber.id, WORKER_SESSION, null);
    new ThreadSubscriptionRepository(stack.db).subscribe(subscriber.id, 'th-1');
    await stack.eventManager.ingest({ eventId: 'wh-2', source: 'webhook', type: 'issue.opened', threadId: 'th-1' });
    const set = tools.find((t) => t.name === 'supervisor_event_mode_set') as ToolDefinition;
    await set.execute({ mode: 'auto' }, execOf(ROUTER_SESSION));
    const row = stack.eventManager.repository.byEventId('wh-2');
    if (!row) throw new Error('事件未落库');
    await stack.eventRouter.route(row);
    const list = tools.find((t) => t.name === 'supervisor_event_list') as ToolDefinition;
    const result = await list.execute({ status: 'passed_through' }, execOf(ROUTER_SESSION));
    const events = (result as { events: Array<{ event_id: string; status: string }> }).events;
    expect(events.some((e) => e.event_id === 'wh-2' && e.status === 'passed_through')).toBe(true);
  });
});

describe('worker_report 工具全链路', () => {
  async function dispatchedTask(stack: SupervisorStack): Promise<string> {
    const task = stack.taskManager.createTask({ projectId: 'proj-1', title: 'T' }, { sessionId: ROUTER_SESSION, role: 'router' });
    stack.taskManager.enqueue(task.id, { sessionId: ROUTER_SESSION, role: 'router' });
    stack.taskManager.markDispatched(task.id, WORKER_SESSION, null);
    return task.id;
  }

  it('非 Worker 会话（含 Router）被拒绝', async () => {
    const stack = await buildStack();
    const tool = buildWorkerReportTool(stack);
    const denied = await tool.execute(
      { workspace_id: 'ws-1', task_id: 'task-x', status: 'running' },
      execOf(ROUTER_SESSION),
    );
    expect(isGuardDenied(denied)).toBe(true);
  });

  it('合法 Worker 汇报 completed：任务终态 + 执行记录收口', async () => {
    const stack = await buildStack();
    const taskId = await dispatchedTask(stack);
    const tool = buildWorkerReportTool(stack);
    const outcome = await tool.execute(
      { workspace_id: 'ws-1', task_id: taskId, status: 'completed', progress: 100, summary: '完成' },
      execOf(WORKER_SESSION),
    );
    expect(outcome).toEqual({ accepted: true, reason: 'applied', taskStatus: 'completed' });
    expect(stack.taskManager.tasks.byId(taskId)?.status).toBe('completed');
  });

  it('非法载荷返回校验问题清单（未知字段拒绝）', async () => {
    const stack = await buildStack();
    const taskId = await dispatchedTask(stack);
    const tool = buildWorkerReportTool(stack);
    const outcome = await tool.execute(
      { workspace_id: 'ws-1', task_id: taskId, status: 'running', evil: 1 },
      execOf(WORKER_SESSION),
    );
    expect((outcome as { accepted: boolean }).accepted).toBe(false);
    expect((outcome as { reason: string }).reason).toBe('invalid-payload');
    expect((outcome as { issues: string[] }).issues.some((i) => i.includes('evil'))).toBe(true);
  });

  it('need_human 汇报：接受并尽力通知 Router（fake 适配器下通知失败不阻断）', async () => {
    const stack = await buildStack();
    const taskId = await dispatchedTask(stack);
    const tool = buildWorkerReportTool(stack);
    const outcome = await tool.execute(
      { workspace_id: 'ws-1', task_id: taskId, status: 'need_human', need_human: true, summary: '需要确认部署方案', blockers: ['缺少生产凭据'] },
      execOf(WORKER_SESSION),
    );
    expect(outcome).toEqual({ accepted: true, reason: 'applied', taskStatus: 'need_human' });
    expect(stack.taskManager.tasks.byId(taskId)?.status).toBe('need_human');
  });

  it('Worker 越权汇报他人任务：归属校验拒绝（第三防线）', async () => {
    const stack = await buildStack();
    const taskId = await dispatchedTask(stack);
    const tool = buildWorkerReportTool(stack);
    // 另一个项目 Worker（同会话集合通过 guard，但任务派发给了 WORKER_SESSION）
    stack.taskManager.projects.create({ id: 'proj-2', workspaceId: 'ws-2', name: 'P2', workerSessionId: 'session-worker-b' });
    const outcome = await tool.execute(
      { workspace_id: 'ws-2', task_id: taskId, status: 'completed' },
      execOf('session-worker-b'),
    );
    expect((outcome as { reason: string }).reason).toBe('wrong-session');
    expect(stack.taskManager.tasks.byId(taskId)?.status).toBe('running');
  });
});
