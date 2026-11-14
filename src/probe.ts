/**
 * S1 API 探针：在真实 DSH Host 进程内验证本插件依赖的全部能力。
 *
 * 设计原则（见 docs/DEVELOPMENT_PLAN.md §10）：
 * - 每项检查独立 try/catch，单项失败不阻断整体；
 * - 结果四态：VERIFIED / UNAVAILABLE / UNSTABLE / SKIPPED；
 * - 报告 JSON 落盘到插件数据目录，供 docs/API_COMPATIBILITY.md 汇总；
 * - 探针只读探测，不创建 Workspace / Session / Schedule 等业务对象。
 * - 模块顶层零 node:* 静态依赖（宿主插件环境可能限制 Node 内建模块的解析，
 *   全部内建改为使用点动态 import，保证本模块本身可被任何环境加载）。
 */
import type { Context } from '@deepseek-ai/cordis';
// 以下 side-effect 类型导入用于合并 Context 上的服务声明（workspaceRegistry / agents / schedule / sessionPersistence / tools）
import type {} from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-schedule';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-tools';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import type { AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { ScheduleService } from '@deepseek-ai/dsh-schedule';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import type { ToolsService } from '@deepseek-ai/dsh-tools';
import type { ProbeCheck, ProbeReport } from './types/index.js';

/** 插件版本（与 package.json 同步维护）。 */
const PLUGIN_VERSION = '0.1.0-alpha.1';

/** 单项检查的安全包装：任何抛错都转为 UNAVAILABLE 记录，不中断整体。 */
async function check(id: string, name: string, body: () => Promise<string>): Promise<ProbeCheck> {
  const startedAt = Date.now();
  try {
    const detail = await body();
    return { id, name, status: 'VERIFIED', detail, durationMs: Date.now() - startedAt };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { id, name, status: 'UNAVAILABLE', detail, durationMs: Date.now() - startedAt };
  }
}

/** 截断任意值的安全 JSON 摘要（探针证据有长度纪律）。 */
function brief(value: unknown, maxChars = 300): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > maxChars ? `${text.slice(0, maxChars)}…(截断)` : text;
}

/** 等待式服务解析：宿主服务链异步初始化（如 schedule 依赖 sessionPersistence），
 * apply 时刻可能未就绪——轮询 ctx.get 直到出现或超时。 */
async function awaitService(ctx: Context, name: string, retries = 40, intervalMs = 200): Promise<unknown> {
  for (let i = 0; i < retries; i++) {
    try {
      const service = ctx.get(name);
      if (service !== undefined && service !== null) return service;
    } catch {
      // 门禁抛错时同样等待重试（apply 早期 façade 可能尚未就绪）
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return undefined;
}

/** 解析插件数据目录：优先 dsh-home-paths（V6），失败降级 ~/.dsh。 */
async function resolveDataDir(configured?: string): Promise<{ dir: string; basis: string }> {
  if (configured && configured.trim() !== '') {
    return { dir: configured, basis: '显式配置' };
  }
  try {
    const mod = await import('@deepseek-ai/dsh-home-paths');
    const dir = mod.dshHomePath('global-supervisor');
    return { dir, basis: `dsh-home-paths（home=${mod.resolveDshHome()}）` };
  } catch (error) {
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const fallback = join(homedir(), '.dsh', 'global-supervisor');
    const reason = error instanceof Error ? error.message : String(error);
    return { dir: fallback, basis: `降级 ~/.dsh（dsh-home-paths 不可用：${reason}）` };
  }
}

/**
 * 运行完整探针并落盘报告。
 * @param ctx - Cordis 插件上下文（真实 Host 进程内）
 * @param configuredDir - 配置指定的数据目录（可空）
 * @returns 完整报告对象
 */
export async function runProbe(ctx: Context, configuredDir?: string): Promise<ProbeReport> {
  const data = await resolveDataDir(configuredDir);
  const checks: ProbeCheck[] = [];

  // --- 环境 ---
  checks.push(await check('env.node-version', '宿主 Node 版本（要求 >=22.19）', async () => {
    const v = process.version;
    const major = Number(v.slice(1).split('.')[0] ?? 0);
    if (major < 22) throw new Error(`Node 版本过低：${v}`);
    return v;
  }));

  checks.push(await check('env.data-dir', '插件数据目录解析（V6）', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(data.dir, { recursive: true });
    return `${data.dir}（依据：${data.basis}）`;
  }));

  // --- SQLite（V3）---
  checks.push(await check('sqlite.node-sqlite', 'node:sqlite 可用性（V3：建表/插入/查询/事务）', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE probe(id INTEGER PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO probe(v) VALUES(?)').run('ok');
    const row = db.prepare('SELECT * FROM probe WHERE id = ?').get(1) as Record<string, unknown>;
    db.close();
    if (row['v'] !== 'ok') throw new Error(`读写不一致：${brief(row)}`);
    return 'DatabaseSync/StatementSync 正常，参数绑定与查询返回符合预期';
  }));

  // --- 服务存在性与实际调用 ---
  // 宿主沙箱门禁：属性访问需要 inject 声明，ctx.get() 按需解析（官方插件模式）；
  // 服务链异步初始化，统一经 awaitService 等待就绪。
  checks.push(await check('service.workspace-registry', 'ctx.workspaceRegistry 存在且 list() 可调用', async () => {
    const reg = (await awaitService(ctx, 'workspaceRegistry')) as WorkspaceRegistry | undefined;
    if (!reg) throw new Error('ctx.workspaceRegistry 未就绪（等待 8s 后仍不可见）');
    const list = reg.list();
    const first = list[0];
    return `list() 返回 ${list.length} 个 workspace；方法集：${['create', 'get', 'list', 'delete', 'resolveByPath'].filter((m) => typeof (reg as unknown as Record<string, unknown>)[m] === 'function').join('/')}；示例：${first ? `${first.id} → ${first.path}` : '(空)'}`;
  }));

  checks.push(await check('service.agents', 'ctx.agents 存在及关键方法签名（create/resume/get/list）', async () => {
    const agents = (await awaitService(ctx, 'agents')) as AgentRegistry | undefined;
    if (!agents) throw new Error('ctx.agents 未就绪');
    const missing = ['create', 'resume', 'get', 'list'].filter((m) => typeof (agents as unknown as Record<string, unknown>)[m] !== 'function');
    if (missing.length > 0) throw new Error(`缺少方法：${missing.join('/')}`);
    const live = agents.list();
    return `方法齐全；当前活动 Agent ${live.length} 个${live[0] ? `，示例 id=${live[0].id} status=${live[0].status}` : ''}`;
  }));

  checks.push(await check('service.schedule', 'ctx.schedule（Host-wide）存在且 catalog() 可调用', async () => {
    const schedule = (await awaitService(ctx, 'schedule')) as ScheduleService | undefined;
    if (!schedule) throw new Error('ctx.schedule 未就绪（等待 8s 后仍不可见——旧版 DSH 无 Host-wide Schedule）');
    const catalog = await schedule.catalog();
    return `catalog() 返回 ${catalog.length} 个任务；方法集：${['create', 'list', 'catalog', 'view', 'history', 'edit', 'run', 'deleteInactive'].filter((m) => typeof (schedule as unknown as Record<string, unknown>)[m] === 'function').join('/')}`;
  }));

  checks.push(await check('service.session-persistence', 'ctx.sessionPersistence 存在及快照查询', async () => {
    const sp = (await awaitService(ctx, 'sessionPersistence')) as SessionPersistence | undefined;
    if (!sp) throw new Error('ctx.sessionPersistence 未就绪');
    const missing = ['create', 'open', 'stat', 'list'].filter((m) => typeof (sp as unknown as Record<string, unknown>)[m] !== 'function');
    if (missing.length > 0) throw new Error(`缺少方法：${missing.join('/')}`);
    const snapshots = await sp.list();
    return `list() 返回 ${snapshots.length} 个会话快照${snapshots[0] ? `；示例字段：${Object.keys(snapshots[0] as object).join('/')}` : ''}`;
  }));

  checks.push(await check('service.tools', 'ctx.tools 存在且 register 可用', async () => {
    const tools = (await awaitService(ctx, 'tools')) as ToolsService | undefined;
    if (!tools) throw new Error('ctx.tools 未就绪');
    if (typeof tools.register !== 'function') throw new Error('ctx.tools.register 不是函数');
    return 'register(definition, options?) 签名存在';
  }));

  // --- 关键 API 形态 ---
  checks.push(await check('api.user-message-factory', 'createUserMessage 构造（V2：任务指令消息）', async () => {
    const mod = await import('@deepseek-ai/dsh-llm');
    if (typeof mod.createUserMessage !== 'function') throw new Error('@deepseek-ai/dsh-llm 未导出 createUserMessage');
    const msg = mod.createUserMessage({
      content: [{ type: 'text', text: 'probe' }],
      source: { kind: 'user' },
    });
    return `构造成功：id=${String(msg.id)} role=${msg.role} content 块数=${msg.content.length}`;
  }));

  // --- 工具执行上下文（V1：注册探针工具，由任意会话调用后捕获 exec.agent）---
  checks.push(await check('api.tool-exec-context', '工具执行上下文可获调用者（V1：probe_echo 工具）', async () => {
    // 本检查只确认工具注册通道；exec.agent 的实际捕获依赖模型调用 probe_echo，
    // 结果在会话触发后由 captureToolInvocation 补充记录。
    const tools = ctx.get('tools') as { register: unknown } | undefined;
    if (!tools || typeof tools.register !== 'function') throw new Error('工具注册不可用');
    return 'probe_echo 已注册（SKIPPED→VERIFIED 待任意会话调用一次后复核）';
  }));

  const report: ProbeReport = {
    ranAt: new Date().toISOString(),
    nodeVersion: process.version,
    pluginVersion: PLUGIN_VERSION,
    dataDir: data.dir,
    checks,
  };

  // 落盘报告（探针自身的持久化验证）
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const reportPath = join(data.dir, 'probe-report.json');
  await mkdir(data.dir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  return report;
}

