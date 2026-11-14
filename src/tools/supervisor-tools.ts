/**
 * Router 侧工具集（15 个，方案 §7 的 14 个 + workspace_adopt 纳管）：唯一构建入口 buildSupervisorTools。
 * 权限：执行期校验调用者 === routerSessionId（toolkit 第二防线）；
 * 业务归属校验由 TaskManager（assigned_session）承担第三防线。
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SupervisorStack } from '../runtime.js';
import { asRecord, intArg, makeTool, optionalStringArg, stringArg } from './toolkit.js';

/** Router 守卫：经 RouterIdentity 动态判定（运行时认领制，见 services/router-identity.ts）。 */
function routerGuard(stack: SupervisorStack) {
  return (caller: string) => stack.routerIdentity.isRouter(caller);
}

const DENIED = '仅 Router 会话可调用 supervisor 工具（首次使用可在目标会话调用 supervisor_claim_router 认领）';

const OBJ = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
});

/** 结果 schema（宽松对象：工具结果字段较多，统一由 render 全量输出）。 */
const RESULT = { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true } as const;

/** 构建 Router 工具（15 个管理工具；Router 身份经设置面板或 patch 预置管理，见 services/router-identity.ts）。 */
export function buildSupervisorTools(stack: SupervisorStack): ToolDefinition[] {
  const guard = routerGuard(stack);
  const routerActor = () => ({ sessionId: stack.routerIdentity.ownerSessionId(), role: 'router' as const });
  const tools: ToolDefinition[] = [];

  tools.push(makeTool({
    name: 'supervisor_workspace_list',
    description: '列出全量工作区概览（每个 DSH workspace 一行并标注 managed 受管状态；未纳管的可用 supervisor_workspace_adopt 纳入管理）。include_archived=true 追含已归档项目',
    parameters: OBJ({ include_archived: { type: 'boolean', description: '是否包含已归档项目' } }),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: async (args) => {
      const record = asRecord(args);
      const workspaces = await stack.workspaceManager.listWorkspaceOverview(record['include_archived'] === true);
      return {
        ok: true,
        total: workspaces.length,
        managed: workspaces.filter((w) => w.managed).length,
        unmanaged: workspaces.filter((w) => !w.managed).length,
        workspaces,
      };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_workspace_get',
    description: '查看单个项目详情（workspace_id 或 project_id 二选一）',
    parameters: OBJ({ workspace_id: { type: 'string' }, project_id: { type: 'string' } }),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: async (args) => {
      const record = asRecord(args);
      const byWorkspace = optionalStringArg(record, 'workspace_id');
      const byProject = optionalStringArg(record, 'project_id');
      const project = byWorkspace
        ? await stack.workspaceManager.projectByWorkspace(byWorkspace)
        : byProject
          ? await stack.workspaceManager.getProject(byProject)
          : undefined;
      return project ? { ok: true, project } : { ok: false, error: 'not-found' };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_workspace_adopt',
    description: '纳管既有 DSH workspace 为受管项目（幂等；重复纳管返回既有项目）。首个使用入口：把已有工作区纳入统一管理',
    parameters: OBJ({ workspace_id: { type: 'string', description: 'DSH workspace ID（supervisor_workspace_list 可查）' }, priority: { type: 'integer', description: '0-9，默认 3' }, description: { type: 'string' } }, ['workspace_id']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: async (args) => {
      const record = asRecord(args);
      try {
        const project = await stack.workspaceManager.adoptWorkspace(stringArg(record, 'workspace_id'), {
          priority: intArg(record, 'priority', 3, 0, 9),
          description: stringArg(record, 'description'),
        });
        return { ok: true, project };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_workspace_create',
    description: '新建项目：目录必须已存在（请先用文件工具创建目录），注册为 DSH workspace 并纳管',
    parameters: OBJ({ path: { type: 'string', description: '已存在的项目目录绝对路径' }, title: { type: 'string' }, priority: { type: 'integer', description: '0-9，默认 3' }, description: { type: 'string' } }, ['path', 'title']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: async (args) => {
      const record = asRecord(args);
      try {
        const project = await stack.workspaceManager.createProject(stringArg(record, 'path'), stringArg(record, 'title'), {
          priority: intArg(record, 'priority', 3, 0, 9),
          description: stringArg(record, 'description'),
        });
        return { ok: true, project };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_workspace_update',
    description: '更新项目属性（priority/description/status/worker_session_id）',
    parameters: OBJ({ project_id: { type: 'string' }, priority: { type: 'integer' }, description: { type: 'string' }, worker_session_id: { type: 'string' } }, ['project_id']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: (args) => {
      const record = asRecord(args);
      const projectId = stringArg(record, 'project_id');
      const patch: Record<string, unknown> = {};
      if (record['priority'] !== undefined) patch['priority'] = intArg(record, 'priority', 3, 0, 9);
      const workerSession = optionalStringArg(record, 'worker_session_id');
      if (workerSession !== undefined) patch['workerSessionId'] = workerSession;
      const description = optionalStringArg(record, 'description');
      if (description !== undefined) patch['description'] = description;
      const updated = stack.workspaceManager.projects.update(projectId, patch);
      return { ok: updated };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_workspace_archive',
    description: '归档项目（仅业务状态；不删除 DSH workspace 注册与历史数据）',
    parameters: OBJ({ project_id: { type: 'string' } }, ['project_id']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: (args) => {
      const archived = stack.workspaceManager.archiveProject(stringArg(asRecord(args), 'project_id'));
      return { ok: archived };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_task_create',
    description: '创建任务（pending 起步，需 supervisor_task_assign 派发；depends_on 为前置任务 ID 数组）',
    parameters: OBJ({
      project_id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
      priority: { type: 'integer' }, due_at: { type: 'string', description: 'RFC3339 截止时间' },
      depends_on: { type: 'array', items: { type: 'string' } },
    }, ['project_id', 'title']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: (args, ctx) => {
      const record = asRecord(args);
      try {
        const deps = Array.isArray(record['depends_on']) ? (record['depends_on'] as unknown[]).filter((d): d is string => typeof d === 'string') : [];
        const task = stack.taskManager.createTask(
          {
            projectId: stringArg(record, 'project_id'),
            title: stringArg(record, 'title'),
            description: stringArg(record, 'description'),
            priority: intArg(record, 'priority', 3, 0, 9),
            dueAt: optionalStringArg(record, 'due_at'),
            dependsOn: deps,
          },
          { sessionId: ctx.callerSessionId, role: 'router' },
        );
        return { ok: true, task };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_task_list',
    description: '查询任务列表（可按 project_id / status 过滤）',
    parameters: OBJ({ project_id: { type: 'string' }, status: { type: 'string', description: 'pending/queued/running/completed/blocked/need_human/failed/canceled' } }),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: (args) => {
      const record = asRecord(args);
      const status = optionalStringArg(record, 'status');
      const tasks = stack.taskManager.tasks.list({
        projectId: optionalStringArg(record, 'project_id'),
        status: status as never,
      });
      return { ok: true, count: tasks.length, tasks };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_task_assign',
    description: '派发任务：入队并提交给项目 Worker 会话执行（含 worker_report 汇报要求）',
    parameters: OBJ({ task_id: { type: 'string' } }, ['task_id']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    timeoutMs: 120_000,
    handler: async (args, ctx) => {
      const taskId = stringArg(asRecord(args), 'task_id');
      try {
        stack.taskManager.enqueue(taskId, { sessionId: ctx.callerSessionId, role: 'router' });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const dispatch = await stack.agentController.dispatchTask(taskId);
      return { ok: dispatch.dispatched, dispatch };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_task_cancel',
    description: '取消任务（停止 Worker 执行并进入 canceled 终态）',
    parameters: OBJ({ task_id: { type: 'string' }, reason: { type: 'string' } }, ['task_id']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    timeoutMs: 30_000,
    handler: async (args, ctx) => {
      const record = asRecord(args);
      const taskId = stringArg(record, 'task_id');
      try {
        await stack.agentController.cancelTask(taskId, { sessionId: ctx.callerSessionId, role: 'router' });
        return { ok: true, task_id: taskId };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_task_report',
    description: '查询任务详情：当前状态、执行历史（runs）与最近 Worker 汇报',
    parameters: OBJ({ task_id: { type: 'string' } }, ['task_id']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: (args) => {
      const taskId = stringArg(asRecord(args), 'task_id');
      const task = stack.taskManager.tasks.byId(taskId);
      if (!task) return { ok: false, error: 'not-found' };
      return {
        ok: true,
        task,
        runs: stack.taskManager.runs.byTask(taskId),
        latestReport: stack.taskManager.reports.latestOf(taskId),
      };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_review_project',
    description: '对单项目发起巡检：自动创建巡检任务并派发给该项目 Worker',
    parameters: OBJ({ workspace_id: { type: 'string' }, focus: { type: 'string', description: '巡检关注点（可选）' } }, ['workspace_id']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    timeoutMs: 120_000,
    handler: (args, ctx) => reviewProject(stack, asRecord(args), ctx.callerSessionId, routerActor()),
  }));

  tools.push(makeTool({
    name: 'supervisor_review_all',
    description: '全局巡检：对全部 active 项目逐个发起巡检（Worker 忙碌的项目跳过）',
    parameters: OBJ({ focus: { type: 'string', description: '巡检关注点（可选）' } }),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    timeoutMs: 120_000,
    handler: async (args, ctx) => {
      const record = asRecord(args);
      const projects = await stack.workspaceManager.listProjects();
      const results: Array<{ project: string; ok: boolean; reason: string }> = [];
      for (const project of projects.filter((p) => p.status === 'active')) {
        const outcome = await reviewProject(stack, { workspace_id: project.workspaceId, focus: record['focus'] }, ctx.callerSessionId, routerActor());
        results.push({ project: project.title, ok: outcome.ok, reason: outcome.reason });
      }
      return { ok: true, reviewed: results.filter((r) => r.ok).length, skipped: results.filter((r) => !r.ok).length, results };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_schedule_set',
    description: '设置 Router 定时巡检（DSH 原生 Host Schedule）。timing 用友好形态：{kind:"daily", time:"09:00"}；也支持 every（every_seconds 或 minutes）、after（after_seconds）、weekly（time + weekdays 1-7）、cron（expression 五段式）、at（ISO 时刻）、rrule（字符串）。缺省时区取本机时区。',
    parameters: OBJ({
      title: { type: 'string', description: '任务名（如"每日巡检"）' },
      prompt: { type: 'string', description: '每次触发投递给 Router 的指令' },
      timing: {
        type: 'object',
        description: '调度规则；例：{"kind":"daily","time":"09:00"}；{"kind":"every","minutes":30}；{"kind":"weekly","time":"09:00","weekdays":[1,2,3,4,5]}；{"kind":"cron","expression":"0 9 * * *"}',
        additionalProperties: true,
      },
    }, ['title', 'prompt', 'timing']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    timeoutMs: 30_000,
    handler: async (args) => {
      const record = asRecord(args);
      const timing = record['timing'];
      if (typeof timing !== 'object' || timing === null) return { ok: false, error: 'timing 必须是对象' };
      try {
        const scheduleId = await stack.scheduler.setRouterReview({
          title: stringArg(record, 'title'),
          prompt: stringArg(record, 'prompt'),
          timing,
          routerSessionId: stack.routerIdentity.ownerSessionId(),
        });
        return { ok: true, schedule_id: scheduleId };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_schedule_list',
    description: '查看巡检调度绑定（本地绑定与 Host 任务联合视图）',
    parameters: OBJ({}),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: async () => ({ ok: true, bindings: await stack.scheduler.listBindings() }),
  }));

  return tools;
}

/** 单项目巡检：创建巡检任务并入队派发。 */
async function reviewProject(
  stack: SupervisorStack,
  record: Record<string, unknown>,
  callerSessionId: string,
  routerActor: { sessionId: string; role: 'router' },
): Promise<{ ok: boolean; reason: string; task_id?: string }> {
  const workspaceId = stringArg(record, 'workspace_id');
  const project = await stack.workspaceManager.projectByWorkspace(workspaceId);
  if (!project) return { ok: false, reason: 'project-not-found' };
  if (!project.workerSessionId) return { ok: false, reason: 'no-worker-session' };
  const focus = optionalStringArg(record, 'focus');
  const task = stack.taskManager.createTask(
    {
      projectId: project.projectId,
      title: focus ? `项目巡检：${project.title}（关注：${focus}）` : `项目巡检：${project.title}`,
      description: '检查项目当前状态、进展与阻碍，经 worker_report 汇报（status=completed 时给出结构化项目状态摘要）。',
      priority: 5,
    },
    { sessionId: callerSessionId, role: routerActor.role },
  );
  try {
    stack.taskManager.enqueue(task.id, routerActor);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const dispatch = await stack.agentController.dispatchTask(task.id);
  return dispatch.dispatched
    ? { ok: true, reason: 'dispatched', task_id: task.id }
    : { ok: false, reason: dispatch.reason, task_id: task.id };
}
