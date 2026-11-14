/**
 * 服务栈组装：apply 时按配置实例化全部服务并持有到插件生命周期结束。
 * 顶层零 node:* 静态依赖（沙箱纪律），运行时模块按需动态加载。
 */
import type { Context } from '@deepseek-ai/cordis';
import { DshAgentAdapter } from './adapters/dsh-agent.js';
import { DshScheduleAdapter } from './adapters/dsh-schedule.js';
import { DshSessionAdapter } from './adapters/dsh-session.js';
import { DshWorkspaceAdapter } from './adapters/dsh-workspace.js';
import type { DatabaseSync } from 'node:sqlite';
import { EventManager } from './services/event-manager.js';
import { AgentController } from './services/agent-controller.js';
import { ProjectMonitor } from './services/project-monitor.js';
import { SchedulerService } from './services/scheduler.js';
import { SessionDirectNotifier } from './services/notifier.js';
import { TaskManager } from './services/task-manager.js';
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
  sessionAdapter: DshSessionAdapter;
  monitor: ProjectMonitor;
  notifier: SessionDirectNotifier;
}

/** 数据库文件名（位于插件数据目录下）。 */
const DB_FILENAME = 'supervisor.db';

/** 组装服务栈（打开数据库并完成迁移）。 */
export async function createStack(ctx: Context, options: { dataDir?: string; routerSessionId?: string }): Promise<SupervisorStack> {
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
  const monitor = new ProjectMonitor(taskManager);
  const notifier = new SessionDirectNotifier(agentAdapter, options.routerSessionId ?? '');

  return {
    db,
    dataDir,
    taskManager,
    workspaceManager,
    agentController,
    scheduler,
    eventManager,
    sessionAdapter,
    monitor,
    notifier,
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
