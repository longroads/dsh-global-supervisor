/**
 * Router 侧工具集（15 个，方案 §7 的 14 个 + workspace_adopt 纳管）：唯一构建入口 buildSupervisorTools。
 * 权限：执行期校验调用者 === routerSessionId（toolkit 第二防线）；
 * 业务归属校验由 TaskManager（assigned_session）承担第三防线。
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { EventRoutingAction } from '../database/repository/event-routing-rule-repository.js';
import { MEMORY_CATEGORIES } from '../database/repository/memory-repository.js';
import type { MemoryCategory } from '../database/repository/memory-repository.js';
import { PluginSettingRepository } from '../database/repository/plugin-setting-repository.js';
import type { SupervisorStack } from '../runtime.js';
import { WATCHDOG_SETTING_KEYS } from '../services/project-monitor.js';
import { asRecord, intArg, makeTool, optionalStringArg, stringArg } from './toolkit.js';
import { jsonSafeDeep } from '../utils/json-safe.js';
import { DshPresetCatalogAdapter } from '../adapters/dsh-preset.js';

/** Router 守卫：经 RouterIdentity 动态判定（运行时认领制，见 services/router-identity.ts）。 */
function routerGuard(stack: SupervisorStack) {
  return (caller: string) => stack.routerIdentity.isRouter(caller);
}

const DENIED = '仅 Router 会话可调用 supervisor 工具。Worker 会话请使用 worker_report 汇报任务进展；如需将本会话设为 Router，请在会话内直接调用 supervisor_claim_router 认领';

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
    description: '查看单个项目详情（workspace_id 或 project_id 二选一）。返回含 available_sessions（可读会话名）——绑定 Worker 会话时从中选 session_id 填入 supervisor_workspace_update 的 worker_session_id',
    parameters: OBJ({ workspace_id: { type: 'string' }, project_id: { type: 'string' } }),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    timeoutMs: 15_000,
    handler: async (args) => {
      const record = asRecord(args);
      const byWorkspace = optionalStringArg(record, 'workspace_id');
      const byProject = optionalStringArg(record, 'project_id');
      const project = byWorkspace
        ? await stack.workspaceManager.projectByWorkspace(byWorkspace)
        : byProject
          ? await stack.workspaceManager.getProject(byProject)
          : undefined;
      if (!project) return { ok: false, error: 'not-found' };
      const workspace = await stack.workspaceManager.listWorkspaceOverview(true).then((all) => all.find((item) => item.workspaceId === project.workspaceId));
      const sessionIds = workspace?.sessionIds ?? [];
      const titles = await stack.sessionAdapter.readTitles([...sessionIds]);
      const cached = await stack.sessionAdapter.readCachedTitles([...sessionIds]);
      return {
        ok: true,
        project,
        available_sessions: sessionIds.map((id) => ({ id, label: titles.get(id) ?? cached.get(id) ?? id.slice(0, 18) })),
      };
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
        const wasFirstProject = stack.taskManager.projects.list().length === 0;
        const project = await stack.workspaceManager.adoptWorkspace(stringArg(record, 'workspace_id'), {
          priority: intArg(record, 'priority', 3, 0, 9),
          description: stringArg(record, 'description'),
        });
        // FB-8：纳管首个项目后引导设置巡检节奏（通知链路的定时兜底）
        const guidance = wasFirstProject
          ? '已纳管首个项目——建议：(1) supervisor_workspace_update 绑定 Worker 会话；(2) supervisor_schedule_set 设置巡检节奏（如 daily 快速巡检），定时巡检是任务通知的兜底通道'
          : undefined;
        return { ok: true, project, ...(guidance !== undefined ? { guidance } : {}) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_workspace_create',
    description: '新建项目并纳管。⚠️ 必须先向用户确认（描述项目名与路径，用户明确同意后传 confirmed: true）；未确认时调用只返回预览。目录不存在时插件自动创建。若不确定是否需要新工作区，先调 supervisor_workspace_list 检查能否复用既有项目。',
    parameters: OBJ({
      path: { type: 'string', description: '项目目录绝对路径（不存在时自动创建）' },
      title: { type: 'string' },
      priority: { type: 'integer', description: '0-9，默认 3' },
      description: { type: 'string' },
      confirmed: { type: 'boolean', description: '用户已确认创建；不带此参数时仅返回预览不执行' },
    }, ['path', 'title']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: async (args) => {
      const record = asRecord(args);
      const path = stringArg(record, 'path');
      const title = stringArg(record, 'title');
      if (record['confirmed'] !== true) {
        return { ok: false, preview: true, message: '尚未获得用户确认：请先向用户确认是否创建该工作区（title/path），确认后携带 confirmed: true 重新调用', path, title };
      }
      try {
        const project = await stack.workspaceManager.createProject(path, title, {
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
    description: '更新项目属性（priority/description/status/worker_session_id）。worker_session_id 从 supervisor_workspace_get 返回的 available_sessions 中选（含可读会话名）',
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
    description: '创建任务（pending 起步，需 supervisor_task_assign 派发；depends_on 为前置任务 ID 数组）。project_id 与 workspace_id 二选一——传 workspace_id 时自动解析对应受管项目。带 source_event_id 时自动订阅该事件所属 Thread（同 Thread 后续事件直通本任务 Worker）。category 决定差异化跟进节奏（可用 supervisor_watchdog_config 的 category_overrides 按分类覆盖心跳/超时）；acceptance 为验收条件（注入派发指令，Worker 完成时需对照并附 evidence 佐证）',
    parameters: OBJ({
      project_id: { type: 'string' }, workspace_id: { type: 'string', description: 'DSH workspace ID（与 project_id 二选一）' }, title: { type: 'string' }, description: { type: 'string' },
      priority: { type: 'integer' }, due_at: { type: 'string', description: 'RFC3339 截止时间' },
      depends_on: { type: 'array', items: { type: 'string' } },
      source_event_id: { type: 'string', description: '来源事件 ID（supervisor_event_list 可查）；该事件带 thread_id 时本任务自动订阅其 Thread' },
      category: { type: 'string', description: '任务分类：inspection（巡检）/ investigation（排查）/ development（开发）/ maintenance（维护）/ daily（日常）或自定义；未分类走全局缺省节奏' },
      acceptance: { type: 'string', description: '验收条件（派发契约）：明确可判定的完成标准，如"报告文件写入 <路径>""命令 X 输出含 Y"；Worker 完成时需对照并附 evidence（文件路径或输出摘要）' },
    }, ['title']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: async (args, ctx) => {
      const record = asRecord(args);
      try {
        const projectId = await resolveProjectId(stack, record);
        const deps = Array.isArray(record['depends_on']) ? (record['depends_on'] as unknown[]).filter((d): d is string => typeof d === 'string') : [];
        const task = stack.taskManager.createTask(
          {
            projectId,
            title: stringArg(record, 'title'),
            description: stringArg(record, 'description'),
            priority: intArg(record, 'priority', 3, 0, 9),
            dueAt: optionalStringArg(record, 'due_at'),
            dependsOn: deps,
            sourceEventId: optionalStringArg(record, 'source_event_id'),
            category: optionalStringArg(record, 'category'),
            acceptance: optionalStringArg(record, 'acceptance'),
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
    description: '派发任务：入队并提交给 Worker 会话执行（含 worker_report 汇报要求）。默认用项目 Worker 会话；session_id 指定其他会话执行本任务（一任务一执行体，不写回项目绑定）；fresh_session=true 自动新建专用会话执行（任务描述需自包含：基线数据/文件路径/步骤，成果写入磁盘文件——零上下文污染，长寿命会话退化时的标准处置）',
    parameters: OBJ({
      task_id: { type: 'string' },
      session_id: { type: 'string', description: '指定执行会话（可选；不填用项目 Worker）' },
      fresh_session: { type: 'boolean', description: 'true 时为本任务新建专用会话（可选）' },
      agent_preset: { type: 'string', description: 'fresh_session 新建会话的宿主预设名（可选；预设决定工具集——不传则无执行类工具，任务将无法落盘，强烈建议传入）' },
      sandbox_mode: { type: 'string', description: 'fresh_session 会话沙箱模式：danger-full-access（默认，系统级任务必需）/ workspace-write / read-only' },
    }, ['task_id']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    timeoutMs: 120_000,
    handler: async (args, ctx) => {
      const record = asRecord(args);
      const taskId = stringArg(record, 'task_id');
      let override: { sessionId: string } | undefined;
      if (record['fresh_session'] === true) {
        const task = stack.taskManager.tasks.byId(taskId);
        const project = task ? stack.taskManager.projects.byId(task.project_id) : undefined;
        const workspaceId = project?.workspace_id;
        if (!workspaceId) return { ok: false, error: `task-not-found-or-no-project: ${taskId}` };
        const path = await resolveWorkspacePath(stack, workspaceId);
        if (path === undefined) return { ok: false, error: `workspace-path-unresolved: ${workspaceId}` };
        const preset = await resolveAgentPreset(stack, optionalStringArg(record, 'agent_preset'));
        if (!preset.ok) return { ok: false, error: preset.error };
        const sandboxMode = parseSandboxMode(optionalStringArg(record, 'sandbox_mode'));
        if (sandboxMode === undefined) return { ok: false, error: 'sandbox_mode 必须是 danger-full-access / workspace-write / read-only 之一' };
        try {
          const sessionId = await stack.agentController.createWorkerSession(path, { sessionId: ctx.callerSessionId, role: 'router' }, {
            agentPreset: preset.preset.id,
            sandboxMode,
            ...(await resolveSessionModelPref(stack, taskId)),
          });
          override = { sessionId };
        } catch (error) {
          return { ok: false, error: `session-create-failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      } else {
        const sessionId = optionalStringArg(record, 'session_id');
        if (sessionId !== undefined) override = { sessionId };
      }
      // 幂等入队：仅 pending 需要入队（断路器拒派等场景任务已处于 queued，重复 assign 直接走派发）
      if (stack.taskManager.tasks.byId(taskId)?.status === 'pending') {
        try {
          stack.taskManager.enqueue(taskId, { sessionId: ctx.callerSessionId, role: 'router' });
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      const dispatch = await stack.agentController.dispatchTask(taskId, override);
      if (!dispatch.dispatched && dispatch.reason === 'session-degenerated') {
        return { ok: false, dispatch, error: '项目 Worker 会话对本任务连续 2 次失败（疑似退化）——建议 fresh_session=true 换新会话重派，或 session_id 指定其他会话' };
      }
      return { ok: dispatch.dispatched, dispatch, ...(override !== undefined ? { session_id: override.sessionId, session_scope: 'task' } : {}) };
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
      return jsonSafeDeep({
        ok: true,
        task,
        runs: stack.taskManager.runs.byTask(taskId),
        latestReport: stack.taskManager.reports.latestOf(taskId),
      });
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

  tools.push(makeTool({
    name: 'supervisor_routing_save',
    description: '保存任务路由偏好：任务描述包含某关键词时自动路由到指定工作区。用户表达"这类任务以后都给 X 执行"时调用；同关键词重复保存为覆盖更新',
    parameters: OBJ({
      keyword: { type: 'string', description: '匹配关键词（任务描述包含即命中，忽略大小写）' },
      workspace_id: { type: 'string', description: '目标 DSH workspace ID' },
      note: { type: 'string', description: '用户原话或说明（可选，审计用）' },
    }, ['keyword', 'workspace_id']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: async (args) => {
      const record = asRecord(args);
      const keyword = stringArg(record, 'keyword').trim().toLowerCase();
      const workspaceId = stringArg(record, 'workspace_id');
      if (keyword === '') return { ok: false, error: 'keyword 不能为空' };
      const project = await stack.workspaceManager.projectByWorkspace(workspaceId);
      if (!project) return { ok: false, error: `workspace 未纳管：${workspaceId}（先 supervisor_workspace_adopt 纳管）` };
      const rule = await stack.routingRules.save({ keyword, workspaceId, createdBy: 'router', note: optionalStringArg(record, 'note') });
      return { ok: true, rule };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_routing_lookup',
    description: '按任务描述查询路由偏好（创建任务前调用：命中则直接使用返回的 workspace_id 对应项目）',
    parameters: OBJ({ text: { type: 'string', description: '任务描述文本' } }, ['text']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: (args) => {
      const rules = stack.routingRules.lookupAndRecord(stringArg(asRecord(args), 'text'));
      return { ok: true, matched: rules.length, rules };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_event_list',
    description: '查看事件流水与路由状态（pending/observed/routed/ignored/passed_through），附当前路由模式与全部路由规则。Router 用它了解系统看到了什么，并决定是否创建任务或调整过滤规则',
    parameters: OBJ({
      source: { type: 'string', description: '按来源过滤（schedule/im/agent/system/internal/webhook）' },
      status: { type: 'string', description: '按处理状态过滤（pending/observed/routed/ignored/passed_through）' },
      limit: { type: 'integer', description: '返回条数（默认 20，上限 100）' },
    }),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: (args) => {
      const record = asRecord(args);
      const limit = intArg(record, 'limit', 20, 1, 100);
      const events = stack.eventRouter.listEventsWithStatus(
        optionalStringArg(record, 'source'),
        limit,
        optionalStringArg(record, 'status'),
      );
      return { ok: true, mode: stack.eventRouter.mode(), count: events.length, events, rules: stack.eventRouter.rules.list() };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_event_rule_save',
    description: '保存事件路由规则（同 source_pattern 覆盖）。匹配键为 "source.type"（如 webhook.issue.opened、agent.user.message），模式支持尾缀 .* 前缀通配与裸 * 全量。action：route_to_router=转述给 Router（auto 模式生效）、route_to_worker=发给指定会话、ignore=静默丢弃、observe=只记录不派发',
    parameters: OBJ({
      source_pattern: { type: 'string', description: '匹配模式（如 webhook.*、agent.user.message、*）' },
      action: { type: 'string', description: 'route_to_router / route_to_worker / ignore / observe' },
      target_session_id: { type: 'string', description: '目标会话 ID（action=route_to_worker 时必填）' },
      description: { type: 'string', description: '规则说明（审计用）' },
      enabled: { type: 'boolean', description: '默认 true；false 停用但保留规则' },
    }, ['source_pattern', 'action']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: async (args, ctx) => {
      const record = asRecord(args);
      const pattern = stringArg(record, 'source_pattern').trim();
      const action = stringArg(record, 'action');
      const actions: EventRoutingAction[] = ['route_to_router', 'route_to_worker', 'ignore', 'observe'];
      if (pattern === '') return { ok: false, error: 'source_pattern 不能为空' };
      if (!actions.includes(action as EventRoutingAction)) return { ok: false, error: 'action 必须是 route_to_router / route_to_worker / ignore / observe' };
      const target = optionalStringArg(record, 'target_session_id');
      if (action === 'route_to_worker' && target === undefined) return { ok: false, error: 'action=route_to_worker 必须提供 target_session_id' };
      const rule = await stack.eventRouter.saveRule(
        { sourcePattern: pattern, action: action as EventRoutingAction, targetSessionId: target, description: optionalStringArg(record, 'description'), enabled: record['enabled'] !== false },
        ctx.callerSessionId,
      );
      return { ok: true, rule };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_event_mode_set',
    description: '切换事件路由模式：observe（默认，规则只评估留痕不派发）/ auto（按规则真实派发到 Router 或指定会话）。建议先 observe 观察确认规则无误后切 auto',
    parameters: OBJ({ mode: { type: 'string', description: 'observe / auto' } }, ['mode']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: (args, ctx) => {
      const mode = stringArg(asRecord(args), 'mode');
      if (mode !== 'observe' && mode !== 'auto') return { ok: false, error: 'mode 必须是 observe / auto' };
      stack.eventRouter.setMode(mode, ctx.callerSessionId);
      return { ok: true, mode: stack.eventRouter.mode() };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_recall',
    description: '按 event_id 或 task_id（二选一）召回关联上下文：事件 → 同 Thread 事件 + 订阅任务；任务 → 来源事件 + Thread 事件 + Worker 汇报 + 执行历史。返回一跳关联（links）',
    parameters: OBJ({
      event_id: { type: 'string', description: '锚点事件 ID（supervisor_event_list 可查）' },
      task_id: { type: 'string', description: '锚点任务 ID（task-xxx）' },
    }),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: (args) => {
      const record = asRecord(args);
      const eventId = optionalStringArg(record, 'event_id');
      const taskId = optionalStringArg(record, 'task_id');
      if (eventId === undefined && taskId === undefined) {
        return { ok: false, error: 'event_id 与 task_id 至少提供一个' };
      }
      const events = stack.eventManager.repository;
      const threadSubs = stack.taskManager.threadSubs;
      if (taskId !== undefined) {
        const task = stack.taskManager.tasks.byId(taskId);
        if (!task) return { ok: false, error: `task-not-found: ${taskId}` };
        const sourceEvent = task.source_event_id !== null ? events.byEventId(task.source_event_id) : undefined;
        const threadIds = threadSubs.threadsOfTask(taskId);
        const threadEvents = threadIds.flatMap((threadId) => events.byThread(threadId, 20));
        const eventIds = new Set<string>(threadEvents.map((e) => e.event_id));
        if (sourceEvent !== undefined) eventIds.add(sourceEvent.event_id);
        return jsonSafeDeep({
          ok: true,
          task,
          runs: stack.taskManager.runs.byTask(taskId),
          reports: stack.taskManager.reports.byTask(taskId),
          source_event: sourceEvent ?? null,
          thread_events: threadEvents,
          links: { event_ids: [...eventIds], task_ids: [taskId], thread_ids: threadIds },
        });
      }
      const anchorEventId = eventId as string;
      const event = events.byEventId(anchorEventId);
      if (!event) return { ok: false, error: `event-not-found: ${anchorEventId}` };
      const threadEvents = event.thread_id !== null ? events.byThread(event.thread_id, 20) : [];
      const taskIds = event.thread_id !== null ? threadSubs.tasksForThread(event.thread_id) : [];
      const eventIds = new Set<string>(threadEvents.map((e) => e.event_id));
      eventIds.add(anchorEventId);
      return {
        ok: true,
        event,
        thread_events: threadEvents,
        tasks: taskIds.map((id) => {
          const task = stack.taskManager.tasks.byId(id);
          return { id, status: task?.status ?? 'unknown', assigned_session_id: task?.assigned_session_id ?? null };
        }),
        links: { event_ids: [...eventIds], task_ids: taskIds, thread_ids: event.thread_id !== null ? [event.thread_id] : [] },
      };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_task_steer',
    description: '向任务的 Worker 会话插入纠偏指令（当前轮的下一个模型步生效，不打断进行中的工具调用）。适用于方向修正/补充上下文；need_human 状态下可用作"引导继续"（注入人工决策后引导 Worker 恢复执行）',
    parameters: OBJ({
      task_id: { type: 'string' },
      text: { type: 'string', description: '纠偏指令内容' },
    }, ['task_id', 'text']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    timeoutMs: 30_000,
    handler: async (args, ctx) => {
      const record = asRecord(args);
      const taskId = stringArg(record, 'task_id');
      const text = stringArg(record, 'text');
      if (text.trim() === '') return { ok: false, error: 'text 不能为空' };
      const task = stack.taskManager.tasks.byId(taskId);
      if (!task) return { ok: false, error: `task-not-found: ${taskId}` };
      // FB-9①：need_human 也允许 steer——会话等待人工决策时注入决策/引导继续，
      // 让 Router 不必"取消+重派"才能救活任务
      if (task.status !== 'running' && task.status !== 'need_human') {
        return { ok: false, error: `task-not-steerable: 当前状态 ${task.status}（steer 仅适用于 running / need_human 任务）` };
      }
      if (!task.assigned_session_id) return { ok: false, error: 'no-assigned-session' };
      const steered = await stack.agentController.steerTask(taskId, text, { sessionId: ctx.callerSessionId, role: 'router' });
      return steered ? { ok: true, task_id: taskId } : { ok: false, error: 'steer-failed' };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_model_set',
    description: '设置模型偏好以优化 token 成本（分级用模）。锚点四选一：project_id/workspace_id → 项目默认（该项目每次派发生效）；task_id → 任务覆盖（该任务派发生效）；session_id → 立即切换 live 会话（持久化进会话日志，冷会话返回 live:false 待下次派发）。偏好解析顺序 task > project。clear=true 清除 project/task 偏好。注意：切换在任务边界最省 token（KV-cache 前缀重编码）；弱模型可能影响 worker_report 汇报质量，建议只对巡检类任务降档',
    parameters: OBJ({
      project_id: { type: 'string' },
      workspace_id: { type: 'string', description: '与 project_id 等价（自动解析受管项目）' },
      task_id: { type: 'string' },
      session_id: { type: 'string', description: '立即切换的会话 ID' },
      provider: { type: 'string', description: 'llm provider 路由名（supervisor_model_list 可查）' },
      model: { type: 'string', description: '模型 ID' },
      reasoning_effort: { type: 'string', description: '推理档（可选，模型支持时生效）' },
      clear: { type: 'boolean', description: '清除 project/task 偏好（不适用于 session_id）' },
    }),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: async (args, ctx) => {
      const record = asRecord(args);
      const projectId = optionalStringArg(record, 'project_id');
      const workspaceId = optionalStringArg(record, 'workspace_id');
      const taskId = optionalStringArg(record, 'task_id');
      const sessionId = optionalStringArg(record, 'session_id');
      const anchors = [projectId, workspaceId, taskId, sessionId].filter((a) => a !== undefined);
      if (anchors.length !== 1) {
        return { ok: false, error: '锚点四选一：project_id / workspace_id / task_id / session_id（恰提供一个）' };
      }
      const clear = record['clear'] === true;
      if (clear && sessionId !== undefined) {
        return { ok: false, error: 'clear 不适用于 session_id（会话选择记录在会话日志，不经本插件清除）' };
      }
      if (sessionId !== undefined) {
        const provider = stringArg(record, 'provider');
        const model = stringArg(record, 'model');
        if (provider === '' || model === '') return { ok: false, error: 'session_id 锚点需要 provider 与 model' };
        const check = await stack.llmCatalog.validate(provider, model);
        if (!check.ok) return { ok: false, error: check.reason, catalog_checked: true };
        const selection = { provider, model, ...(optionalStringArg(record, 'reasoning_effort') !== undefined ? { reasoningEffort: optionalStringArg(record, 'reasoning_effort') } : {}) };
        const live = await stack.agentController.applySessionModel(sessionId, selection);
        return { ok: true, live, catalog_checked: check.catalogChecked };
      }
      let resolvedProjectId: string | undefined;
      if (projectId !== undefined) resolvedProjectId = projectId;
      else if (workspaceId !== undefined) {
        const project = await stack.workspaceManager.projectByWorkspace(workspaceId);
        if (!project) return { ok: false, error: `workspace 未纳管：${workspaceId}` };
        resolvedProjectId = project.projectId;
      }
      if (clear) {
        if (resolvedProjectId !== undefined) {
          stack.taskManager.projects.update(resolvedProjectId, { modelPrefJson: null });
          stack.taskManager.audit.log({ actorSessionId: ctx.callerSessionId, actorRole: 'router', action: 'model.pref.clear', targetType: 'project', targetId: resolvedProjectId });
          return { ok: true, cleared: 'project' };
        }
        const taskKey = taskId as string;
        const task = stack.taskManager.tasks.byId(taskKey);
        if (!task) return { ok: false, error: `task-not-found: ${taskKey}` };
        stack.taskManager.tasks.setModelPref(taskKey, null);
        stack.taskManager.audit.log({ actorSessionId: ctx.callerSessionId, actorRole: 'router', action: 'model.pref.clear', targetType: 'task', targetId: taskKey });
        return { ok: true, cleared: 'task' };
      }
      const provider = stringArg(record, 'provider');
      const model = stringArg(record, 'model');
      if (provider === '' || model === '') return { ok: false, error: '需要 provider 与 model' };
      const check = await stack.llmCatalog.validate(provider, model);
      if (!check.ok) return { ok: false, error: check.reason, catalog_checked: true };
      const effort = optionalStringArg(record, 'reasoning_effort');
      const prefJson = JSON.stringify(effort !== undefined ? { provider, model, reasoningEffort: effort } : { provider, model });
      if (resolvedProjectId !== undefined) {
        stack.taskManager.projects.update(resolvedProjectId, { modelPrefJson: prefJson });
        stack.taskManager.audit.log({ actorSessionId: ctx.callerSessionId, actorRole: 'router', action: 'model.pref.set', targetType: 'project', targetId: resolvedProjectId, detailJson: prefJson });
        return { ok: true, scope: 'project', catalog_checked: check.catalogChecked };
      }
      const taskKey = taskId as string;
      const task = stack.taskManager.tasks.byId(taskKey);
      if (!task) return { ok: false, error: `task-not-found: ${taskKey}` };
      stack.taskManager.tasks.setModelPref(taskKey, prefJson);
      stack.taskManager.audit.log({ actorSessionId: ctx.callerSessionId, actorRole: 'router', action: 'model.pref.set', targetType: 'task', targetId: taskKey, detailJson: prefJson });
      return { ok: true, scope: 'task', catalog_checked: check.catalogChecked };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_model_list',
    description: '列出可用模型目录（provider × 模型），供 supervisor_model_set 填参。目录来自 DSH llm 服务；不可达时返回结构化降级提示（可直接按 provider 配置填写）',
    parameters: OBJ({}),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: async () => {
      const catalog = await stack.llmCatalog.list();
      if (catalog === undefined) {
        return { ok: false, error: 'llm 目录不可达（dsh-llm 服务未就绪）——降级：supervisor_model_set 仍可直填 provider/model（catalog_checked 将为 false）' };
      }
      return { ok: true, providers: catalog };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_watchdog_config',
    description: '查看或设置看门狗配置（毫秒，超时项下轮扫描生效、间隔下轮扫描后重排）：starting_timeout_ms 启动窗口（默认 600000；Worker Agent 活跃时自动宽限）、approval_timeout_ms 人工决策升级窗口（默认 60000）、idle_stale_ms Worker 空闲阈值（默认 600000，超龄先催告心跳再升级告警）、scan_interval_ms 扫描间隔（默认 300000 即 5 分钟）、heartbeat_interval_ms 心跳契约间隔（派发指令注入，默认 300000；须小于 idle_stale_ms）、progress_push_interval_ms 运行期进度推送间隔（默认 900000 即 15 分钟，0=关闭）、execution_timeout_ms 执行超时总预算（默认 1800000 即 30 分钟；有推进的心跳自动顺延一个窗口——progress 增长或 summary 变化才算推进，复读心跳不续期照常判死）。不传参数返回当前值',
    parameters: OBJ({
      starting_timeout_ms: { type: 'integer', description: '启动窗口毫秒（1000-86400000）' },
      approval_timeout_ms: { type: 'integer', description: 'need_human 升级窗口毫秒（1000-86400000）' },
      idle_stale_ms: { type: 'integer', description: 'Worker 空闲阈值毫秒（1000-86400000）' },
      scan_interval_ms: { type: 'integer', description: '扫描间隔毫秒（60000-86400000）' },
      heartbeat_interval_ms: { type: 'integer', description: '心跳契约间隔毫秒（1000-86400000，派发时注入指令）' },
      progress_push_interval_ms: { type: 'integer', description: '运行期进度推送间隔毫秒（0=关闭；1000-86400000）' },
      execution_timeout_ms: { type: 'integer', description: '执行超时总预算毫秒（60000-86400000；系统级长任务建议调大；有推进心跳自动续期）' },
      category_overrides: { type: 'object', description: '分类级节奏覆盖表（对象键用 camelCase：{分类名:{startingTimeoutMs?,idleStaleMs?,heartbeatIntervalMs?,executionTimeoutMs?}}，值为毫秒；整体替换）' },
    }),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: async (args, ctx) => {
      const record = asRecord(args);
      const settings = new PluginSettingRepository(stack.db);
      const clamp = (value: unknown, min = 1_000): number | undefined => {
        if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
        return Math.min(86_400_000, Math.max(min, value));
      };
      const starting = clamp(record['starting_timeout_ms']);
      const approval = clamp(record['approval_timeout_ms']);
      const idle = clamp(record['idle_stale_ms']);
      const scan = clamp(record['scan_interval_ms'], 60_000);
      const heartbeat = clamp(record['heartbeat_interval_ms']);
      const execution = clamp(record['execution_timeout_ms'], 60_000);
      // 进度推送显式允许 0（关闭）
      const progressRaw = record['progress_push_interval_ms'];
      const progressPush = progressRaw === 0 ? 0 : clamp(progressRaw);
      if (starting !== undefined) settings.setJson(WATCHDOG_SETTING_KEYS.startingTimeoutMs, starting);
      if (approval !== undefined) settings.setJson(WATCHDOG_SETTING_KEYS.approvalTimeoutMs, approval);
      if (idle !== undefined) settings.setJson(WATCHDOG_SETTING_KEYS.idleStaleMs, idle);
      if (scan !== undefined) settings.setJson(WATCHDOG_SETTING_KEYS.scanIntervalMs, scan);
      if (heartbeat !== undefined) settings.setJson(WATCHDOG_SETTING_KEYS.heartbeatIntervalMs, heartbeat);
      if (progressPush !== undefined) settings.setJson(WATCHDOG_SETTING_KEYS.progressPushIntervalMs, progressPush);
      if (execution !== undefined) settings.setJson(WATCHDOG_SETTING_KEYS.executionTimeoutMs, execution);
      const overridesRaw = record['category_overrides'];
      const overrides = typeof overridesRaw === 'object' && overridesRaw !== null && !Array.isArray(overridesRaw) ? (overridesRaw as Record<string, Record<string, number>>) : undefined;
      if (overrides !== undefined) settings.setJson(WATCHDOG_SETTING_KEYS.categoryOverrides, overrides);
      if (starting !== undefined || approval !== undefined || idle !== undefined || scan !== undefined || heartbeat !== undefined || progressPush !== undefined || execution !== undefined || overrides !== undefined) {
        stack.taskManager.audit.log({
          actorSessionId: ctx.callerSessionId,
          actorRole: 'router',
          action: 'watchdog.config.set',
          targetType: 'watchdogConfig',
          targetId: 'watchdog',
          detailJson: JSON.stringify({ startingTimeoutMs: starting ?? null, approvalTimeoutMs: approval ?? null, idleStaleMs: idle ?? null, scanIntervalMs: scan ?? null, heartbeatIntervalMs: heartbeat ?? null, progressPushIntervalMs: progressPush ?? null, executionTimeoutMs: execution ?? null, categoryOverrides: overrides ?? null }),
        });
      }
      const current = stack.monitor.effectiveConfig();
      return {
        ok: true,
        starting_timeout_ms: starting ?? current.startingTimeoutMs,
        approval_timeout_ms: approval ?? current.approvalTimeoutMs,
        idle_stale_ms: idle ?? current.idleStaleMs,
        scan_interval_ms: scan ?? current.scanIntervalMs,
        heartbeat_interval_ms: heartbeat ?? current.heartbeatIntervalMs,
        progress_push_interval_ms: progressPush ?? current.progressPushIntervalMs,
        execution_timeout_ms: execution ?? current.executionTimeoutMs,
        category_overrides: overrides ?? settings.getJson<Record<string, unknown>>(WATCHDOG_SETTING_KEYS.categoryOverrides) ?? {},
      };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_preset_list',
    description: '枚举宿主 Agent 预设（FB-21：fresh_session/session_create 的 agent_preset 取值来源）。返回每个预设的 id/名称/描述/是否默认/激活状态，以及组合的插件模块清单与"疑似含执行工具"启发标记（模块名匹配 native-command/tools/edit 等——提示非断言，派发执行类任务前应人工确认模块清单）。服务不可达（隔离/未安装）时返回降级提示',
    parameters: OBJ({}, []),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    timeoutMs: 30_000,
    handler: async () => {
      const presets = await stack.presetCatalog.listPresets();
      if (presets === undefined) {
        return { ok: false, error: 'agentPresets 服务不可达（可能因 cordis group 隔离或宿主未装载）——无法枚举预设，请人工在 GUI 确认预设名后直接传入 agent_preset' };
      }
      const compositions = await stack.presetCatalog.listCompositions();
      const compositionById = new Map((compositions ?? []).map((c) => [c.id, c]));
      return {
        ok: true,
        count: presets.length,
        presets: presets.map((p) => {
          const composition = compositionById.get(p.id);
          return {
            id: p.id,
            name: p.name,
            description: p.description,
            is_default: p.isDefault,
            broken: p.broken,
            modules: composition?.modules ?? null,
            execution_hint: composition !== undefined && DshPresetCatalogAdapter.executionHint(composition.modules),
          };
        }),
        hint: 'execution_hint=true 仅表示组合模块名疑似含执行类工具（启发式）；派发落盘任务前请核对 modules 清单',
      };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_session_create',
    description: '在受管 workspace 下按需创建全新 Worker 会话（FB-10①：会话供给——换绑不再依赖"恰好有另一个空闲会话"的巧合）。返回新 session_id，可用 supervisor_workspace_update 绑定为项目 Worker，或 supervisor_task_assign 的 session_id 参数单任务使用。长寿命会话行为退化（空转/汇报循环）时的标准轮换手段。agent_preset 指定宿主预设（决定新会话的工具集——不传则仅只读工具，无法执行任务，必须传）；模型路由自动解析：项目偏好 → llm 目录默认',
    parameters: OBJ({
      workspace_id: { type: 'string', description: '受管 DSH workspace ID（须已纳管）' },
      agent_preset: { type: 'string', description: '宿主会话预设名（决定工具集；预设无效时创建报错并返回原因）' },
      sandbox_mode: { type: 'string', description: '沙箱模式：danger-full-access（默认，系统级任务必需——沙箱后端不可用环境唯一可行）/ workspace-write / read-only' },
    }, ['workspace_id']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    timeoutMs: 60_000,
    handler: async (args, ctx) => {
      const record = asRecord(args);
      const workspaceId = stringArg(record, 'workspace_id');
      const preset = await resolveAgentPreset(stack, optionalStringArg(record, 'agent_preset'));
      if (!preset.ok) return { ok: false, error: preset.error };
      const sandboxMode = parseSandboxMode(optionalStringArg(record, 'sandbox_mode'));
      if (sandboxMode === undefined) return { ok: false, error: 'sandbox_mode 必须是 danger-full-access / workspace-write / read-only 之一' };
      const project = await stack.workspaceManager.projectByWorkspace(workspaceId);
      if (!project) return { ok: false, error: `workspace-not-managed: ${workspaceId}（先 supervisor_workspace_adopt 纳管）` };
      const path = await resolveWorkspacePath(stack, workspaceId);
      if (path === undefined) return { ok: false, error: `workspace-path-unresolved: ${workspaceId}` };
      try {
        const sessionId = await stack.agentController.createWorkerSession(
          path,
          { sessionId: ctx.callerSessionId, role: 'router' },
          { agentPreset: preset.preset.id, sandboxMode, ...(await resolveSessionModelPrefByProject(stack, project.projectId)) },
        );
        return {
          ok: true,
          session_id: sessionId,
          workspace_id: workspaceId,
          preset: { id: preset.preset.id, source: preset.preset.source, name: preset.preset.name, description: preset.preset.description },
          sandbox_mode: sandboxMode,
          ...(preset.preset.source === 'default' ? { warning: '使用宿主默认预设——若 Worker 汇报无执行工具，请 supervisor_preset_list 选含执行模块的预设后重建' } : {}),
          hints: [
            `绑定为项目 Worker：supervisor_workspace_update（workspace_id=${workspaceId}, worker_session_id=${sessionId}）`,
            '或单任务使用：supervisor_task_assign（session_id 参数）——任务描述需自包含，成果写入磁盘文件',
          ],
        };
      } catch (error) {
        return { ok: false, error: `session-create-failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_memory_save',
    description: '保存/更新长期记忆（0.7.2 记忆地基）：preference（用户偏好）/ fact（既定事实）/ routine（惯例）/ commitment（承诺——开放回路，简报持续跟踪直至闭环）。同 category+content 幂等。带 memory_id + close=true 时闭环该承诺（用户已完成跟进）。用户表达偏好、陈述事实、或承诺亲自做某事时，应主动调用本工具登记',
    parameters: OBJ({
      category: { type: 'string', description: 'preference / fact / routine / commitment' },
      content: { type: 'string', description: '记忆内容（commitment 用"谁 + 做什么 + 大致时限"句式）' },
      memory_id: { type: 'string', description: '已存在记忆的 ID（闭环或更新时提供）' },
      close: { type: 'boolean', description: 'true 时闭环该承诺（开放回路收口，需配合 memory_id）' },
    }, ['category', 'content']),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: async (args, ctx) => {
      const record = asRecord(args);
      const category = stringArg(record, 'category');
      if (!(MEMORY_CATEGORIES as readonly string[]).includes(category)) {
        return { ok: false, error: `category 必须是 ${MEMORY_CATEGORIES.join(' / ')} 之一` };
      }
      const memoryId = optionalStringArg(record, 'memory_id');
      if (record['close'] === true) {
        if (memoryId === undefined) return { ok: false, error: 'close 需要 memory_id（supervisor_memory_list 可查）' };
        const closed = stack.agentController.memories.close(memoryId);
        if (closed) {
          stack.taskManager.audit.log({ actorSessionId: ctx.callerSessionId, actorRole: 'router', action: 'memory.close', targetType: 'memory', targetId: memoryId });
        }
        return { ok: closed, memory_id: memoryId };
      }
      const row = await stack.agentController.memories.save({ category: category as MemoryCategory, content: stringArg(record, 'content'), source: 'router' });
      stack.taskManager.audit.log({ actorSessionId: ctx.callerSessionId, actorRole: 'router', action: 'memory.save', targetType: 'memory', targetId: row.id, detailJson: JSON.stringify({ category }) });
      return { ok: true, memory: row };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_memory_list',
    description: '查询长期记忆（category 可选过滤 preference/fact/routine/commitment；include_closed=true 含已闭环承诺）。生成简报、派发任务、回答"我之前说过什么"时使用',
    parameters: OBJ({
      category: { type: 'string', description: 'preference / fact / routine / commitment（可选）' },
      include_closed: { type: 'boolean', description: '包含已闭环的承诺（默认仅未闭环）' },
    }),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: async (args) => {
      const record = asRecord(args);
      const category = optionalStringArg(record, 'category');
      const valid = category === undefined || (MEMORY_CATEGORIES as readonly string[]).includes(category);
      if (!valid) return { ok: false, error: `category 必须是 ${MEMORY_CATEGORIES.join(' / ')} 之一` };
      const rows = stack.agentController.memories.list(category as MemoryCategory | undefined, record['include_closed'] === true);
      return { ok: true, count: rows.length, memories: rows };
    },
  }));

  tools.push(makeTool({
    name: 'supervisor_briefing',
    description: '生成每日简报数据（0.7.2，零 LLM 收集——所有数字来自本地数据库，无需模型调用；Router 拿到后可整理转述给用户）。含：运行中任务×分类与进度、待人工决策、近期失败、各项目目标进度（goals）、开放回路（未闭环承诺）、近 7 天完成/失败统计与分类分布。建议配合 supervisor_schedule_set 每晨自动调用形成晨报习惯',
    parameters: OBJ({}),
    resultSchema: RESULT,
    guard, guardDeniedMessage: DENIED,
    handler: async () => {
      const nowMs = Date.now();
      const dayAgo = new Date(nowMs - 24 * 3600_000).toISOString();
      const weekAgo = new Date(nowMs - 7 * 24 * 3600_000).toISOString();
      const running = stack.taskManager.tasks.list({ status: 'running' }).map((t) => {
        const report = stack.taskManager.reports.latestOf(t.id);
        const ageMs = t.last_report_at === null ? null : nowMs - Date.parse(t.last_report_at);
        return {
          id: t.id, title: t.title, category: t.category,
          progress: report?.progress ?? null, summary: report?.summary ?? null,
          last_report_age_min: ageMs === null ? null : Math.round(ageMs / 60000),
        };
      });
      const needHuman = stack.taskManager.tasks.list({ status: 'need_human' }).map((t) => ({ id: t.id, title: t.title }));
      const failedRecent = stack.taskManager.tasks.list({ status: 'failed' }).filter((t) => t.updated_at >= dayAgo).map((t) => ({ id: t.id, title: t.title, retry_count: t.retry_count }));
      const goals = stack.taskManager.projects.list().map((p) => {
        let goalList: string[] = [];
        try {
          const parsed = p.goals_json !== null ? (JSON.parse(p.goals_json) as unknown) : [];
          if (Array.isArray(parsed) && parsed.every((g) => typeof g === 'string')) goalList = parsed;
        } catch {
          goalList = [];
        }
        const projectTasks = stack.taskManager.tasks.list({ projectId: p.id });
        return {
          project: p.name, workspace_id: p.workspace_id, health: p.health, goals: goalList,
          running: projectTasks.filter((t) => t.status === 'running').length,
          completed_7d: projectTasks.filter((t) => t.status === 'completed' && t.updated_at >= weekAgo).length,
        };
      });
      const openLoops = stack.agentController.memories.list('commitment').map((m) => ({ id: m.id, content: m.content, since: m.created_at.slice(0, 10) }));
      const completedWeek = stack.taskManager.tasks.list({ status: 'completed' }).filter((t) => t.updated_at >= weekAgo);
      const categoryDist: Record<string, number> = {};
      for (const t of completedWeek) {
        const key = t.category ?? '未分类';
        categoryDist[key] = (categoryDist[key] ?? 0) + 1;
      }
      return {
        ok: true,
        generated_at: new Date(nowMs).toISOString(),
        running,
        need_human: needHuman,
        failed_recent_24h: failedRecent,
        goals,
        open_loops: openLoops,
        weekly: {
          completed_7d: completedWeek.length,
          retried_share: completedWeek.length === 0 ? 0 : Math.round((completedWeek.filter((t) => t.retry_count > 0).length / completedWeek.length) * 100),
          category_distribution: categoryDist,
        },
        guidance: '可整理为晨报转述用户；开放回路中的承诺若已完成，用 supervisor_memory_save(memory_id, close=true) 闭环',
      };
    },
  }));

  return tools;
}

/**
 * 解析新建会话预设（FB-21②）：显式传入 → resolve 预检（不存在/激活失败即拒绝）；
 * 未传 → 宿主默认预设（同样预检）。服务不可达时显式值放行（无法预检）、缺省值拒绝。
 */
async function resolveAgentPreset(stack: SupervisorStack, explicit: string | undefined): Promise<
  { ok: true; preset: { id: string; source: 'explicit' | 'default'; name: string | null; description: string | null } } | { ok: false; error: string }
> {
  const id = explicit ?? (await stack.presetCatalog.defaultId());
  if (id === undefined) {
    return { ok: false, error: 'agent_preset 未提供且宿主默认预设不可达（agentPresets 服务隔离/未装载）——请显式传入预设名（GUI 创建会话所用预设）' };
  }
  const resolved = await stack.presetCatalog.resolvePreset(id);
  if (resolved === undefined) {
    // 服务在 defaultId 之后失联：显式值无法预检，放行（创建报错会透传宿主原因）
    if (explicit !== undefined) {
      return { ok: true, preset: { id: explicit, source: 'explicit', name: null, description: null } };
    }
    return { ok: false, error: `预设 ${id} 无法预检（服务不可达）——请显式传入 agent_preset` };
  }
  if (!resolved.found) {
    return { ok: false, error: `预设不存在：${id}（supervisor_preset_list 可枚举有效预设）` };
  }
  if (resolved.broken !== null) {
    return { ok: false, error: `预设激活失败：${id}（${resolved.broken}）——换用其他预设` };
  }
  return { ok: true, preset: { id, source: explicit !== undefined ? 'explicit' : 'default', name: resolved.name, description: resolved.description } };
}

/** 解析受管 workspace 的本地路径（listWorkspaceOverview 一次查询；未纳管的 workspace 返回 undefined）。 */
async function resolveWorkspacePath(stack: SupervisorStack, workspaceId: string): Promise<string | undefined> {
  const overview = await stack.workspaceManager.listWorkspaceOverview(true);
  return overview.find((item) => item.workspaceId === workspaceId)?.path;
}

/** 解析沙箱模式入参（非法值返回 undefined 由调用方拒绝；缺省 danger-full-access——FB-24/25）。 */
function parseSandboxMode(raw: string | undefined): 'danger-full-access' | 'workspace-write' | 'read-only' | undefined {
  if (raw === undefined) return 'danger-full-access';
  if (raw === 'danger-full-access' || raw === 'workspace-write' || raw === 'read-only') return raw;
  return undefined;
}

/** 解析 model_pref_json 的最小面（工具层自用，与 AgentController.parseModelPref 同构）。 */
function parseModelPrefJson(json: string | null | undefined): { provider: string; model: string } | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as { provider?: unknown; model?: unknown };
    if (typeof parsed.provider === 'string' && typeof parsed.model === 'string') return { provider: parsed.provider, model: parsed.model };
  } catch {
    // 畸形偏好按无偏好处理，由目录回退兜底
  }
  return undefined;
}

/**
 * 新建会话的初始模型路由（FB-20③ 无模型回退）：任务偏好 → 项目偏好 → llm 目录首个 provider 首个模型。
 * 三处都解析不到时返回 undefined——会话将无路由（宿主不回退，followup 会报 no provider/model）。
 */
async function resolveSessionModelPref(stack: SupervisorStack, taskId: string): Promise<{ provider: string; model: string } | undefined> {
  const task = stack.taskManager.tasks.byId(taskId);
  const project = task ? stack.taskManager.projects.byId(task.project_id) : undefined;
  const fromPref = parseModelPrefJson(task?.model_pref_json) ?? parseModelPrefJson(project?.model_pref_json);
  if (fromPref !== undefined) return fromPref;
  return resolveSessionModelPrefByProject(stack, project?.id);
}

/** 按项目解析初始模型路由（session_create 无任务上下文时用）：项目偏好 → llm 目录首个可用模型。 */
async function resolveSessionModelPrefByProject(stack: SupervisorStack, projectId: string | undefined): Promise<{ provider: string; model: string } | undefined> {
  const fromPref = parseModelPrefJson(projectId !== undefined ? stack.taskManager.projects.byId(projectId)?.model_pref_json : undefined);
  if (fromPref !== undefined) return fromPref;
  const catalog = await stack.llmCatalog.list();
  const first = catalog?.find((entry) => entry.models.length > 0);
  return first !== undefined ? { provider: first.provider, model: first.models[0]!.id } : undefined;
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

/** 解析任务归属项目：project_id 优先，否则按 workspace_id 解析受管项目。 */
async function resolveProjectId(stack: SupervisorStack, record: Record<string, unknown>): Promise<string> {
  const projectId = optionalStringArg(record, 'project_id');
  if (projectId !== undefined) return projectId;
  const workspaceId = optionalStringArg(record, 'workspace_id');
  if (workspaceId === undefined) throw new Error('project_id 与 workspace_id 至少提供一个');
  const project = await stack.workspaceManager.projectByWorkspace(workspaceId);
  if (!project) throw new Error(`workspace 未纳管：${workspaceId}（先 supervisor_workspace_adopt 纳管）`);
  return project.projectId;
}
