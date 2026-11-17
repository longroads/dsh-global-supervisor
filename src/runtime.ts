/**
 * 服务栈组装：apply 时按配置实例化全部服务并持有到插件生命周期结束。
 * 顶层零 node:* 静态依赖（沙箱纪律），运行时模块按需动态加载。
 */
import type { Context } from '@deepseek-ai/cordis';
import { DshAgentAdapter } from './adapters/dsh-agent.js';
import { DshImNotifierAdapter } from './adapters/dsh-im-notifier.js';
import { DshLlmCatalogAdapter } from './adapters/dsh-llm-catalog.js';
import { DshScheduleAdapter } from './adapters/dsh-schedule.js';
import { DshSessionAdapter } from './adapters/dsh-session.js';
import { DshWorkspaceAdapter } from './adapters/dsh-workspace.js';
import type { DatabaseSync } from 'node:sqlite';
import { AuditRepository } from './database/repository/audit-repository.js';
import { PluginSettingRepository } from './database/repository/plugin-setting-repository.js';
import { EventManager } from './services/event-manager.js';
import { EventBatcher } from './services/event-batcher.js';
import { EventRouter } from './services/event-router.js';
import { AgentController } from './services/agent-controller.js';
import { ProjectMonitor } from './services/project-monitor.js';
import { RouterIdentity } from './services/router-identity.js';
import { RoutingRuleRepository } from './database/repository/routing-rule-repository.js';
import { SchedulerService } from './services/scheduler.js';
import { NotifierService, SessionDirectNotifier } from './services/notifier.js';
import type { NotifierConfig } from './services/notifier.js';
import { TaskManager } from './services/task-manager.js';
import { UpdateChecker } from './services/update-checker.js';
import { WorkspaceManager } from './services/workspace-manager.js';

/** 完整服务栈（工具层的唯一依赖面）。 */
export interface SupervisorStack {
  db: DatabaseSync;
  dataDir: string;
  taskManager: TaskManager;
  workspaceManager: WorkspaceManager;
  agentController: AgentController;
  scheduler: SchedulerService;
  eventManager: EventManager;
  eventRouter: EventRouter;
  sessionAdapter: DshSessionAdapter;
  monitor: ProjectMonitor;
  notifier: NotifierService;
  routerIdentity: RouterIdentity;
  routingRules: RoutingRuleRepository;
  llmCatalog: DshLlmCatalogAdapter;
  updateChecker: UpdateChecker;
}

/** 数据库文件名（位于插件数据目录下）。 */
const DB_FILENAME = 'supervisor.db';

/** 组装服务栈（打开数据库并完成迁移）。 */
export async function createStack(ctx: Context, options: { dataDir?: string; routerSessionId?: string; notifier?: NotifierConfig; updateCheck?: boolean }): Promise<SupervisorStack> {
  const dataDir = await resolveDataDir(options.dataDir);
  const { openDatabase } = await import('./database/connection.js');
  const { join } = await import('node:path');
  const db = await openDatabase(join(dataDir, DB_FILENAME));

  const workspaceAdapter = new DshWorkspaceAdapter(ctx);
  const agentAdapter = new DshAgentAdapter(ctx);
  const scheduleAdapter = new DshScheduleAdapter(ctx);
  const sessionAdapter = new DshSessionAdapter(ctx);

  const taskManager = new TaskManager(db);
  const eventManager = new EventManager(db);
  const workspaceManager = new WorkspaceManager(workspaceAdapter, db);
  const agentController = new AgentController(agentAdapter, taskManager, db);
  const scheduler = new SchedulerService(scheduleAdapter, db);
  const routerIdentity = new RouterIdentity(db, options.routerSessionId ?? '', async (sessionId, workspaceId) => {
    const workspace = await workspaceAdapter.getWorkspace(workspaceId);
    return workspace?.sessionIds.includes(sessionId) ?? false;
  });
  const sessionNotifier = new SessionDirectNotifier(agentAdapter, () => routerIdentity.ownerSessionId());
  const notifier = new NotifierService(sessionNotifier, new DshImNotifierAdapter(ctx), {
    type: options.notifier?.type === 'dsh-im' ? 'dsh-im' : 'session',
    botId: options.notifier?.botId ?? '',
    targetId: options.notifier?.targetId ?? 'supervisor-alerts',
  });
  const audit = new AuditRepository(db);
  const eventBatcher = new EventBatcher(agentAdapter, () => routerIdentity.ownerSessionId(), {}, (error, batchSize) => {
    audit.log({
      actorRole: 'system',
      action: 'event.batch-failed',
      targetType: 'eventBatch',
      targetId: `batch-${Date.now()}`,
      detailJson: JSON.stringify({ batchSize, message: error instanceof Error ? error.message : String(error) }),
    });
  });
  const eventRouter = new EventRouter(db, agentAdapter, () => routerIdentity.ownerSessionId(), eventBatcher);
  // 闭环种子规则（FB-4）：启动时确定性写入（幂等；observe 模式下仅留痕）
  await eventRouter.ensureCoreRules();
  const monitor = new ProjectMonitor(taskManager, agentController, undefined, {
    agents: agentAdapter,
    notify: (message, severity) => notifier.notify(message, severity),
    settings: new PluginSettingRepository(db),
  });

  return {
    db,
    dataDir,
    taskManager,
    workspaceManager,
    agentController,
    scheduler,
    eventManager,
    eventRouter,
    sessionAdapter,
    monitor,
    notifier,
    routerIdentity,
    routingRules: new RoutingRuleRepository(db),
    llmCatalog: new DshLlmCatalogAdapter(ctx),
    updateChecker: new UpdateChecker({ enabled: options.updateCheck !== false }),
  };
}

/** 数据目录解析：优先显式配置，其次 dsh-home-paths，降级 ~/.dsh。 */
async function resolveDataDir(configured?: string): Promise<string> {
  if (configured && configured.trim() !== '') return configured;
  try {
    const mod = await import('@deepseek-ai/dsh-home-paths');
    return mod.dshHomePath('global-supervisor');
  } catch {
    const os = await import('node:os');
    const path = await import('node:path');
    return path.join(os.homedir(), '.dsh', 'global-supervisor');
  }
}
