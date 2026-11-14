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

/** 手工组装服务栈（内存库 + fake ctx，Adapter 不被真正调用）。 */
async function buildStack(): Promise<SupervisorStack> {
  const db = await openDatabase(':memory:');
  const fakeCtx = { get: () => ({}) } as unknown as Context;
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
