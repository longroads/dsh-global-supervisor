import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
import { SessionDirectNotifier, NotifierService } from '../../src/services/notifier.js';
import { TaskManager } from '../../src/services/task-manager.js';
import { WorkspaceManager } from '../../src/services/workspace-manager.js';
import { EventRouter } from '../../src/services/event-router.js';
import { DshLlmCatalogAdapter } from '../../src/adapters/dsh-llm-catalog.js';
import { RoutingRuleRepository } from '../../src/database/repository/routing-rule-repository.js';
import { ThreadSubscriptionRepository } from '../../src/database/repository/thread-subscription-repository.js';
import { PluginSettingRepository } from '../../src/database/repository/plugin-setting-repository.js';
import type { SupervisorStack } from '../../src/runtime.js';
import { isGuardDenied, makeTool } from '../../src/tools/toolkit.js';
import { parseWorkerReport } from '../../src/protocols/worker-report.js';
import { buildSupervisorTools } from '../../src/tools/supervisor-tools.js';
import { buildWorkerReportTool } from '../../src/tools/worker-report-tool.js';

const ROUTER_SESSION = 'session-router';
const WORKER_SESSION = 'session-worker-a';

/** 最小执行上下文（仅提供身份与取消信号）。 */
function execOf(sessionId: string): ToolRunContext {
  return { agent: { id: sessionId }, signal: new AbortController().signal } as unknown as ToolRunContext;
}

/** Agent 服务间谍：live 会话上捕获 model.select / followup / steer 调用。 */
const agentSpies = {
  selects: [] as Array<Record<string, unknown>>,
  followups: [] as string[],
  steers: [] as string[],
};

function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text ?? '';
}

/** 夹具 projcache 临时目录登记（afterEach 统一清理）。 */
const projcacheDirs: string[] = [];

afterEach(() => {
  for (const dir of projcacheDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 手工组装服务栈（内存库 + fake ctx；workspaceRegistry/agents/llm 提供假实现；projcache 注入 tmp 目录）。 */
async function buildStack(seedProject = true): Promise<SupervisorStack> {
  const db = await openDatabase(':memory:');
  agentSpies.selects.length = 0;
  agentSpies.followups.length = 0;
  agentSpies.steers.length = 0;
  const projcacheDir = mkdtempSync(join(tmpdir(), 'projcache-tools-'));
  projcacheDirs.push(projcacheDir);
  writeFileSync(join(projcacheDir, `${WORKER_SESSION}.json`), JSON.stringify({ record: { rows: { title: { val: '切换cloud2bim会话模型为GLM-5.3' } } } }), 'utf8');
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
  const liveAgent = {
    id: WORKER_SESSION,
    status: 'idle',
    options: {},
    model: { select: (selection: Record<string, unknown>) => { agentSpies.selects.push(selection); }, current: () => undefined },
    followup: (message: unknown) => { agentSpies.followups.push(textOf(message)); },
    steer: (message: unknown) => { agentSpies.steers.push(textOf(message)); },
    cancel: () => undefined,
    whenIdle: async () => undefined,
  };
  const agentsService = {
    get: (sessionId: string) => (sessionId === WORKER_SESSION ? liveAgent : undefined),
    list: () => [liveAgent],
    resume: async () => ({ agent: liveAgent }),
  };
  const llmService = {
    listProviders: () => [{ id: 'p1', name: 'Provider One' }],
    listModels: async (provider: string) => (provider === 'p1' ? [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'Model Two' }] : []),
  };
  const fakeCtx = {
    get: (name: string) =>
      name === 'workspaceRegistry' ? registry : name === 'agents' ? agentsService : name === 'llm' ? llmService : {},
  } as unknown as Context;
  const agentAdapter = new DshAgentAdapter(fakeCtx);
  const taskManager = new TaskManager(db);
  if (seedProject) {
    taskManager.projects.create({ id: 'proj-1', workspaceId: 'ws-1', name: 'P1', workerSessionId: WORKER_SESSION });
  }
  const agentController = new AgentController(agentAdapter, taskManager, db);
  const monitor = new ProjectMonitor(taskManager, agentController, undefined, { settings: new PluginSettingRepository(db) });
  return {
    db,
    dataDir: ':memory:',
    taskManager,
    workspaceManager: new WorkspaceManager(new DshWorkspaceAdapter(fakeCtx), db),
    agentController,
    scheduler: new SchedulerService(new DshScheduleAdapter(fakeCtx), db),
    eventManager: new EventManager(db),
    sessionAdapter: new DshSessionAdapter(fakeCtx, projcacheDir),
    monitor,
    notifier: new NotifierService(
      new SessionDirectNotifier(agentAdapter, () => ROUTER_SESSION),
      { notify: async () => false },
      { type: 'session', botId: '', targetId: '' },
    ),
    routerIdentity: new RouterIdentity(db, ROUTER_SESSION),
    routingRules: new RoutingRuleRepository(db),
    llmCatalog: new DshLlmCatalogAdapter(fakeCtx),
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
  it('workspace_get 返回 available_sessions（可读会话名，经 projcache 解析真实 title）——绑定 Worker 会话时从中选 session_id', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const get = tools.find((t) => t.name === 'supervisor_workspace_get') as ToolDefinition;
    const result = await get.execute({ workspace_id: 'ws-1' }, execOf(ROUTER_SESSION));
    expect((result as { ok: boolean }).ok).toBe(true);
    const sessions = (result as { available_sessions: Array<{ id: string; label: string }> }).available_sessions;
    expect(sessions.some((s) => s.id === WORKER_SESSION && s.label === '切换cloud2bim会话模型为GLM-5.3')).toBe(true);
  });

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

  it('supervisor_recall 按 task_id：来源事件、同 Thread 事件、汇报与执行历史', async () => {
    const stack = await buildStack();
    await stack.eventManager.ingest({ eventId: 'wh-1', source: 'webhook', type: 'issue.opened', threadId: 'th-1', payloadJson: '{"body":"起源"}' });
    await stack.eventManager.ingest({ eventId: 'wh-2', source: 'webhook', type: 'issue.comment', threadId: 'th-1' });
    const tools = buildSupervisorTools(stack);
    const create = tools.find((t) => t.name === 'supervisor_task_create') as ToolDefinition;
    const created = await create.execute({ project_id: 'proj-1', title: 'T', source_event_id: 'wh-1' }, execOf(ROUTER_SESSION));
    const taskId = (created as { task: { id: string } }).task.id;
    stack.taskManager.enqueue(taskId, { sessionId: ROUTER_SESSION, role: 'router' });
    stack.taskManager.markDispatched(taskId, WORKER_SESSION, null);
    stack.taskManager.applyWorkerReport(parseWorkerReport({ workspace_id: 'ws-1', task_id: taskId, status: 'running', progress: 30 }), WORKER_SESSION);
    const recall = tools.find((t) => t.name === 'supervisor_recall') as ToolDefinition;
    const result = await recall.execute({ task_id: taskId }, execOf(ROUTER_SESSION));
    expect((result as { ok: boolean }).ok).toBe(true);
    expect((result as { source_event: { event_id: string } | null }).source_event?.event_id).toBe('wh-1');
    const threadEvents = (result as { thread_events: Array<{ event_id: string }> }).thread_events;
    expect(threadEvents.map((e) => e.event_id).sort()).toEqual(['wh-1', 'wh-2']);
    expect((result as { reports: unknown[] }).reports).toHaveLength(1);
    expect((result as { runs: unknown[] }).runs).toHaveLength(1);
    const links = (result as { links: { event_ids: string[]; task_ids: string[]; thread_ids: string[] } }).links;
    expect(links.task_ids).toEqual([taskId]);
    expect(links.event_ids).toContain('wh-2');
    expect(links.thread_ids).toEqual(['th-1']);
  });

  it('supervisor_recall 按 event_id：同 Thread 事件与订阅任务；无锚点拒绝', async () => {
    const stack = await buildStack();
    await stack.eventManager.ingest({ eventId: 'wh-1', source: 'webhook', type: 'issue.opened', threadId: 'th-1' });
    const tools = buildSupervisorTools(stack);
    const create = tools.find((t) => t.name === 'supervisor_task_create') as ToolDefinition;
    const created = await create.execute({ project_id: 'proj-1', title: 'T', source_event_id: 'wh-1' }, execOf(ROUTER_SESSION));
    const taskId = (created as { task: { id: string } }).task.id;
    const recall = tools.find((t) => t.name === 'supervisor_recall') as ToolDefinition;
    const byEvent = await recall.execute({ event_id: 'wh-1' }, execOf(ROUTER_SESSION));
    expect((byEvent as { ok: boolean }).ok).toBe(true);
    const tasks = (byEvent as { tasks: Array<{ id: string; status: string }> }).tasks;
    expect(tasks.some((t) => t.id === taskId && t.status === 'pending')).toBe(true);
    const links = (byEvent as { links: { event_ids: string[]; task_ids: string[] } }).links;
    expect(links.task_ids).toContain(taskId);
    expect(links.event_ids).toContain('wh-1');
    const noAnchor = await recall.execute({}, execOf(ROUTER_SESSION));
    expect((noAnchor as { ok: boolean }).ok).toBe(false);
  });

  it('supervisor_task_steer：运行中任务插入纠偏并留审计；非 running 拒绝', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const steer = tools.find((t) => t.name === 'supervisor_task_steer') as ToolDefinition;
    const pending = stack.taskManager.createTask({ projectId: 'proj-1', title: 'T' }, { sessionId: ROUTER_SESSION, role: 'router' });
    const denied = await steer.execute({ task_id: pending.id, text: '换个方向' }, execOf(ROUTER_SESSION));
    expect((denied as { ok: boolean }).ok).toBe(false);
    expect((denied as { error: string }).error).toContain('task-not-running');

    stack.taskManager.enqueue(pending.id, { sessionId: ROUTER_SESSION, role: 'router' });
    stack.taskManager.markDispatched(pending.id, WORKER_SESSION, null);
    const steered = await steer.execute({ task_id: pending.id, text: '重点看兼容性矩阵' }, execOf(ROUTER_SESSION));
    expect((steered as { ok: boolean }).ok).toBe(true);
    expect(agentSpies.steers).toHaveLength(1);
    expect(agentSpies.steers[0]).toContain('兼容性矩阵');
    expect(stack.taskManager.audit.byTarget('task', pending.id).some((a) => a.action === 'task.steer')).toBe(true);
  });

  it('supervisor_model_set 项目锚点：写偏好、目录校验通过，派发时应用 select', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const modelSet = tools.find((t) => t.name === 'supervisor_model_set') as ToolDefinition;
    const result = await modelSet.execute({ workspace_id: 'ws-1', provider: 'p1', model: 'm1' }, execOf(ROUTER_SESSION));
    expect((result as { ok: boolean }).ok).toBe(true);
    expect((result as { scope: string }).scope).toBe('project');
    expect((result as { catalog_checked: boolean }).catalog_checked).toBe(true);
    expect(stack.taskManager.projects.byId('proj-1')?.model_pref_json).toBe('{"provider":"p1","model":"m1"}');

    const task = stack.taskManager.createTask({ projectId: 'proj-1', title: 'T' }, { sessionId: ROUTER_SESSION, role: 'router' });
    stack.taskManager.enqueue(task.id, { sessionId: ROUTER_SESSION, role: 'router' });
    const dispatch = await stack.agentController.dispatchTask(task.id);
    expect(dispatch.dispatched).toBe(true);
    expect(agentSpies.selects).toHaveLength(1);
    expect(agentSpies.selects[0]).toEqual({ provider: 'p1', model: 'm1' });
  });

  it('supervisor_model_set 任务锚点优先于项目偏好；clear 语义正确', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const modelSet = tools.find((t) => t.name === 'supervisor_model_set') as ToolDefinition;
    await modelSet.execute({ project_id: 'proj-1', provider: 'p1', model: 'm1' }, execOf(ROUTER_SESSION));
    const task = stack.taskManager.createTask({ projectId: 'proj-1', title: 'T' }, { sessionId: ROUTER_SESSION, role: 'router' });
    await modelSet.execute({ task_id: task.id, provider: 'p1', model: 'm2', reasoning_effort: 'high' }, execOf(ROUTER_SESSION));
    expect(stack.taskManager.tasks.byId(task.id)?.model_pref_json).toContain('"reasoningEffort":"high"');

    stack.taskManager.enqueue(task.id, { sessionId: ROUTER_SESSION, role: 'router' });
    await stack.agentController.dispatchTask(task.id);
    expect(agentSpies.selects).toHaveLength(1);
    expect(agentSpies.selects[0]).toEqual({ provider: 'p1', model: 'm2', reasoningEffort: 'high' });

    const cleared = await modelSet.execute({ task_id: task.id, clear: true }, execOf(ROUTER_SESSION));
    expect((cleared as { ok: boolean }).ok).toBe(true);
    expect((cleared as { cleared: string }).cleared).toBe('task');
    expect(stack.taskManager.tasks.byId(task.id)?.model_pref_json).toBeNull();
  });

  it('supervisor_model_set 目录校验拒绝未知 provider/model；多锚点/无锚点拒绝', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const modelSet = tools.find((t) => t.name === 'supervisor_model_set') as ToolDefinition;
    const badProvider = await modelSet.execute({ project_id: 'proj-1', provider: 'px', model: 'm1' }, execOf(ROUTER_SESSION));
    expect((badProvider as { ok: boolean }).ok).toBe(false);
    expect((badProvider as { error: string }).error).toContain('provider 不在 llm 目录');
    const badModel = await modelSet.execute({ project_id: 'proj-1', provider: 'p1', model: 'mx' }, execOf(ROUTER_SESSION));
    expect((badModel as { ok: boolean }).ok).toBe(false);
    expect((badModel as { error: string }).error).toContain('model 不在');
    const noAnchor = await modelSet.execute({ provider: 'p1', model: 'm1' }, execOf(ROUTER_SESSION));
    expect((noAnchor as { ok: boolean }).ok).toBe(false);
    const twoAnchors = await modelSet.execute({ project_id: 'proj-1', task_id: 'task-x', provider: 'p1', model: 'm1' }, execOf(ROUTER_SESSION));
    expect((twoAnchors as { ok: boolean }).ok).toBe(false);
  });

  it('supervisor_model_set session 锚点：live 立即 select，冷会话 live:false', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const modelSet = tools.find((t) => t.name === 'supervisor_model_set') as ToolDefinition;
    const live = await modelSet.execute({ session_id: WORKER_SESSION, provider: 'p1', model: 'm2' }, execOf(ROUTER_SESSION));
    expect((live as { ok: boolean }).ok).toBe(true);
    expect((live as { live: boolean }).live).toBe(true);
    expect(agentSpies.selects).toHaveLength(1);
    expect(agentSpies.selects[0]).toEqual({ provider: 'p1', model: 'm2' });
    const cold = await modelSet.execute({ session_id: 'session-nowhere', provider: 'p1', model: 'm2' }, execOf(ROUTER_SESSION));
    expect((cold as { ok: boolean }).ok).toBe(true);
    expect((cold as { live: boolean }).live).toBe(false);
    const clearSession = await modelSet.execute({ session_id: WORKER_SESSION, clear: true }, execOf(ROUTER_SESSION));
    expect((clearSession as { ok: boolean }).ok).toBe(false);
  });

  it('supervisor_model_list：目录可达返回清单；不可达结构化降级', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const modelList = tools.find((t) => t.name === 'supervisor_model_list') as ToolDefinition;
    const okResult = await modelList.execute({}, execOf(ROUTER_SESSION));
    expect((okResult as { ok: boolean }).ok).toBe(true);
    const providers = (okResult as { providers: Array<{ provider: string; models: Array<{ id: string }> }> }).providers;
    expect(providers).toHaveLength(1);
    expect(providers[0]?.models.map((m) => m.id)).toEqual(['m1', 'm2']);

    stack.llmCatalog = { list: async () => undefined } as unknown as typeof stack.llmCatalog;
    const degraded = await modelList.execute({}, execOf(ROUTER_SESSION));
    expect((degraded as { ok: boolean }).ok).toBe(false);
    expect((degraded as { error: string }).error).toContain('llm 目录不可达');
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

describe('supervisor_watchdog_config 与纳管引导（FB-2/FB-8）', () => {
  function findTool(stack: SupervisorStack, name: string): ToolDefinition {
    const tool = buildSupervisorTools(stack).find((t) => t.name === name);
    if (!tool) throw new Error(`工具未注册：${name}`);
    return tool;
  }

  it('无参调用返回当前缺省配置', async () => {
    const stack = await buildStack();
    const result = await findTool(stack, 'supervisor_watchdog_config').execute({}, execOf(ROUTER_SESSION));
    expect(result).toEqual({ ok: true, starting_timeout_ms: 600_000, approval_timeout_ms: 60_000, idle_stale_ms: 600_000, scan_interval_ms: 1_800_000 });
  });

  it('设置启动窗口：KV 落库且再次查询返回新值；审计留痕', async () => {
    const stack = await buildStack();
    const tool = findTool(stack, 'supervisor_watchdog_config');
    const updated = await tool.execute({ starting_timeout_ms: 120_000 }, execOf(ROUTER_SESSION));
    expect((updated as { starting_timeout_ms: number }).starting_timeout_ms).toBe(120_000);
    const again = await tool.execute({}, execOf(ROUTER_SESSION));
    expect((again as { starting_timeout_ms: number }).starting_timeout_ms).toBe(120_000);
    expect((again as { approval_timeout_ms: number }).approval_timeout_ms).toBe(60_000);
    expect(stack.taskManager.audit.byAction('watchdog.config.set')).toHaveLength(1);
  });

  it('设置扫描间隔：KV 落库且 effectiveConfig 反映（下轮扫描后重排定时器）', async () => {
    const stack = await buildStack();
    const tool = findTool(stack, 'supervisor_watchdog_config');
    const updated = await tool.execute({ scan_interval_ms: 3_600_000 }, execOf(ROUTER_SESSION));
    expect((updated as { scan_interval_ms: number }).scan_interval_ms).toBe(3_600_000);
    expect(stack.monitor.effectiveConfig().scanIntervalMs).toBe(3_600_000);
  });

  it('纳管首个项目：返回值含巡检引导（FB-8）', async () => {
    const stack = await buildStack(false);
    const result = await findTool(stack, 'supervisor_workspace_adopt').execute({ workspace_id: 'ws-1' }, execOf(ROUTER_SESSION));
    expect((result as { ok: boolean }).ok).toBe(true);
    expect((result as { guidance: string }).guidance).toContain('supervisor_schedule_set');
  });

  it('重复纳管（非首项目）：无引导字段', async () => {
    const stack = await buildStack();
    const result = await findTool(stack, 'supervisor_workspace_adopt').execute({ workspace_id: 'ws-1' }, execOf(ROUTER_SESSION));
    expect((result as { ok: boolean }).ok).toBe(true);
    expect((result as { guidance?: string }).guidance).toBeUndefined();
  });
});
