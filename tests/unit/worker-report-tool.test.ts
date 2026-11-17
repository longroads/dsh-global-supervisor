import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { openDatabase } from '../../src/database/connection.js';
import { DshAgentAdapter } from '../../src/adapters/dsh-agent.js';
import { DshScheduleAdapter } from '../../src/adapters/dsh-schedule.js';
import { DshSessionAdapter } from '../../src/adapters/dsh-session.js';
import { DshWorkspaceAdapter } from '../../src/adapters/dsh-workspace.js';
import { AgentController } from '../../src/services/agent-controller.js';
import { EventManager } from '../../src/services/event-manager.js';
import { EventRouter } from '../../src/services/event-router.js';
import { NotifierService, SessionDirectNotifier } from '../../src/services/notifier.js';
import { ProjectMonitor } from '../../src/services/project-monitor.js';
import { RouterIdentity } from '../../src/services/router-identity.js';
import { RoutingRuleRepository } from '../../src/database/repository/routing-rule-repository.js';
import { DshLlmCatalogAdapter } from '../../src/adapters/dsh-llm-catalog.js';
import { SchedulerService } from '../../src/services/scheduler.js';
import { TaskManager } from '../../src/services/task-manager.js';
import { ThreadSubscriptionRepository } from '../../src/database/repository/thread-subscription-repository.js';
import { WorkspaceManager } from '../../src/services/workspace-manager.js';
import type { SupervisorStack } from '../../src/runtime.js';
import { buildWorkerReportTool } from '../../src/tools/worker-report-tool.js';

const ROUTER_SESSION = 'session-router';
const WORKER_SESSION = 'session-worker-a';

interface SentNotice {
  message: string;
}

/** 最小执行上下文（仅提供身份与取消信号）。 */
function execOf(sessionId: string): ToolRunContext {
  return { agent: { id: sessionId }, signal: new AbortController().signal } as unknown as ToolRunContext;
}

/** 组装服务栈并挂通知收集器（IM/会话两条通道均落到 notices）。 */
async function buildStack(): Promise<{ stack: SupervisorStack; notices: SentNotice[] }> {
  const db = await openDatabase(':memory:');
  const fakeCtx = { get: () => ({}) } as unknown as Context;
  const agentAdapter = new DshAgentAdapter(fakeCtx);
  const taskManager = new TaskManager(db);
  taskManager.projects.create({ id: 'proj-1', workspaceId: 'ws-1', name: 'P1', workerSessionId: WORKER_SESSION });
  const notices: SentNotice[] = [];
  // 夹具走 dsh-im 通道使通知落到收集器（IM 间谍返回 true，不触发会话降级）
  const notifier = new NotifierService(
    new SessionDirectNotifier(agentAdapter, () => ROUTER_SESSION),
    { notify: async (message: string) => { notices.push({ message }); return true; } },
    { type: 'dsh-im', botId: 'bot-test', targetId: 't-test' },
  );
  const stack: SupervisorStack = {
    db,
    dataDir: ':memory:',
    taskManager,
    workspaceManager: new WorkspaceManager(new DshWorkspaceAdapter(fakeCtx), db),
    agentController: new AgentController(agentAdapter, taskManager, db),
    scheduler: new SchedulerService(new DshScheduleAdapter(fakeCtx), db),
    eventManager: new EventManager(db),
    eventRouter: new EventRouter(db, { dispatch: async () => undefined }, () => ROUTER_SESSION),
    sessionAdapter: new DshSessionAdapter(fakeCtx),
    monitor: new ProjectMonitor(taskManager),
    notifier,
    routerIdentity: new RouterIdentity(db, ROUTER_SESSION),
    routingRules: new RoutingRuleRepository(db),
    llmCatalog: new DshLlmCatalogAdapter(fakeCtx),
  } as unknown as SupervisorStack;
  return { stack, notices };
}

describe('worker_report 通知（Phase 4）', () => {
  it('need_human 汇报：推送警告级通知（含任务 ID）', async () => {
    const { stack, notices } = await buildStack();
    const tool = buildWorkerReportTool(stack);
    const task = stack.taskManager.createTask({ projectId: 'proj-1', title: 'T' }, { sessionId: ROUTER_SESSION, role: 'router' });
    stack.taskManager.enqueue(task.id, { sessionId: ROUTER_SESSION, role: 'router' });
    stack.taskManager.markDispatched(task.id, WORKER_SESSION, null);
    await tool.execute(
      { workspace_id: 'ws-1', task_id: task.id, status: 'need_human', need_human: true, summary: '需要确认部署方案' },
      execOf(WORKER_SESSION),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain('【警告】');
    expect(notices[0]?.message).toContain(task.id);
  });

  it('完成且任务带 channel_ref：闭环通知 + 信道摘要各一条（两条目的不同）', async () => {
    const { stack, notices } = await buildStack();
    stack.eventManager.ingest({ eventId: 'wh-1', source: 'im', type: 'issue.opened', channelRef: 'im:feishu:chat-1' });
    const tool = buildWorkerReportTool(stack);
    const task = stack.taskManager.createTask({ projectId: 'proj-1', title: 'T', sourceEventId: 'wh-1' }, { sessionId: ROUTER_SESSION, role: 'router' });
    expect(task.channel_ref).toBe('im:feishu:chat-1');
    stack.taskManager.enqueue(task.id, { sessionId: ROUTER_SESSION, role: 'router' });
    stack.taskManager.markDispatched(task.id, WORKER_SESSION, null);
    await tool.execute(
      { workspace_id: 'ws-1', task_id: task.id, status: 'completed', progress: 100, summary: '已完成' },
      execOf(WORKER_SESSION),
    );
    expect(notices).toHaveLength(2);
    expect(notices.every((n) => n.message.includes('【通知】') && n.message.includes(task.id))).toBe(true);
  });

  it('完成（无 channel_ref）：闭环通知 info（FB-4——Worker 交付必达 Router）', async () => {
    const { stack, notices } = await buildStack();
    const tool = buildWorkerReportTool(stack);
    const task = stack.taskManager.createTask({ projectId: 'proj-1', title: 'T' }, { sessionId: ROUTER_SESSION, role: 'router' });
    stack.taskManager.enqueue(task.id, { sessionId: ROUTER_SESSION, role: 'router' });
    stack.taskManager.markDispatched(task.id, WORKER_SESSION, null);
    await tool.execute(
      { workspace_id: 'ws-1', task_id: task.id, status: 'completed', progress: 100, summary: '已完成' },
      execOf(WORKER_SESSION),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain('【通知】');
    expect(notices[0]?.message).toContain(task.id);
  });

  it('失败终态：闭环通知 warning + task.terminal 事件入库', async () => {
    const { stack, notices } = await buildStack();
    const tool = buildWorkerReportTool(stack);
    const task = stack.taskManager.createTask({ projectId: 'proj-1', title: 'T' }, { sessionId: ROUTER_SESSION, role: 'router' });
    stack.taskManager.enqueue(task.id, { sessionId: ROUTER_SESSION, role: 'router' });
    stack.taskManager.markDispatched(task.id, WORKER_SESSION, null);
    await tool.execute(
      { workspace_id: 'ws-1', task_id: task.id, status: 'failed', blockers: ['依赖崩溃'] },
      execOf(WORKER_SESSION),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain('【警告】');
    expect(notices[0]?.message).toContain(task.id);
    expect(countEvents(stack, 'task.terminal')).toBe(1);
  });

  it('拒收（invalid-transition）：critical 通知 + worker_report.rejected 事件（拒收不再是黑洞）', async () => {
    const { stack, notices } = await buildStack();
    const tool = buildWorkerReportTool(stack);
    const task = stack.taskManager.createTask({ projectId: 'proj-1', title: 'T' }, { sessionId: ROUTER_SESSION, role: 'router' });
    stack.taskManager.enqueue(task.id, { sessionId: ROUTER_SESSION, role: 'router' });
    stack.taskManager.markDispatched(task.id, WORKER_SESSION, null);
    stack.taskManager.cancel(task.id, { sessionId: ROUTER_SESSION, role: 'router' });
    await tool.execute(
      { workspace_id: 'ws-1', task_id: task.id, status: 'completed' },
      execOf(WORKER_SESSION),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain('【严重】');
    expect(notices[0]?.message).toContain('invalid-transition');
    expect(countEvents(stack, 'worker_report.rejected')).toBe(1);
  });

  it('收编（adopted）：迟到终态汇报同样通知 Router', async () => {
    const { stack, notices } = await buildStack();
    const tool = buildWorkerReportTool(stack);
    const task = stack.taskManager.createTask({ projectId: 'proj-1', title: 'T' }, { sessionId: ROUTER_SESSION, role: 'router' });
    stack.taskManager.enqueue(task.id, { sessionId: ROUTER_SESSION, role: 'router' });
    stack.taskManager.markDispatched(task.id, WORKER_SESSION, null);
    stack.taskManager.markStartupTimeout(task.id);
    stack.taskManager.retry(task.id, { role: 'system' });
    const outcome = await tool.execute(
      { workspace_id: 'ws-1', task_id: task.id, status: 'completed', progress: 100, summary: '迟到交付' },
      execOf(WORKER_SESSION),
    );
    expect((outcome as { reason: string }).reason).toBe('adopted');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain('【通知】');
    expect(notices[0]?.message).toContain(task.id);
  });

  it('0.7.2 完成轻验证：带验收条件 + evidence 文件（mtime 新于派发）→ verified=1；缺 evidence → verified=0 并告警', async () => {
    const { stack, notices } = await buildStack();
    const tool = buildWorkerReportTool(stack);
    // 证据文件：新建于派发之后（mtime 必然新于 run.started_at）
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'evidence-'));
    const evidencePath = join(dir, 'report.md');
    try {
      const task = stack.taskManager.createTask(
        { projectId: 'proj-1', title: '压测报告', acceptance: '报告写入结果文件' },
        { sessionId: ROUTER_SESSION, role: 'router' },
      );
      stack.taskManager.enqueue(task.id, { sessionId: ROUTER_SESSION, role: 'router' });
      stack.taskManager.markDispatched(task.id, WORKER_SESSION, null);
      writeFileSync(evidencePath, 'report body', 'utf8');
      await tool.execute(
        { workspace_id: 'ws-1', task_id: task.id, status: 'completed', progress: 100, summary: '完成', evidence: evidencePath },
        execOf(WORKER_SESSION),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(stack.taskManager.tasks.byId(task.id)?.verified).toBe(1);
      expect(stack.taskManager.audit.byTarget('task', task.id).some((a) => a.action === 'task.verification')).toBe(true);

      // 无 evidence 的带验收任务 → 未验证 + warning 告警
      const task2 = stack.taskManager.createTask({ projectId: 'proj-1', title: 'T2', acceptance: '须给出文件' }, { sessionId: ROUTER_SESSION, role: 'router' });
      stack.taskManager.enqueue(task2.id, { sessionId: ROUTER_SESSION, role: 'router' });
      stack.taskManager.markDispatched(task2.id, WORKER_SESSION, null);
      await tool.execute({ workspace_id: 'ws-1', task_id: task2.id, status: 'completed', summary: '完成' }, execOf(WORKER_SESSION));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(stack.taskManager.tasks.byId(task2.id)?.verified).toBe(0);
      expect(notices.some((n) => n.message.includes('证据未通过核验'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** 断言 events 表中指定 type 的事件条数（直查库，机器消费值）。 */
function countEvents(stack: SupervisorStack, type: string): number {
  const row = (stack.db as { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } })
    .prepare('SELECT COUNT(*) AS n FROM events WHERE type = ?')
    .get(type) as { n: number };
  return row.n;
}
