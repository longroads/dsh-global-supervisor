/**
 * RouterGuard：Router 执行守卫（生产反馈 FB-5 层1 + FB-6）。
 * 三个能力（全部为事后检测与引导，不做真拦截——tools/pre-execute guard 待 probe 验证后下版本）：
 * (a) 越权执行告警：Router 会话的工具调用参数指向受管 workspace 路径 → notify warning；
 * (b) 用户消息路由预检：命中路由规则关键词 → steer 注入"应派发而非自执行"提示；
 * (c) 纠正即学习：命中终止类纠正关键词 → steer 注入"建议 supervisor_routing_save 固化职责归属"。
 * 纪律：公开方法永不抛错（旁路观测组件，内部 catch 降级为本次不动作）；
 * 去抖用 Map+时间戳惰性清理，零定时器（沙箱 timer 需 inject 声明，规避）。
 */
import type { ProjectRow, RoutingRuleRow } from '../types/index.js';

/** 纠正类关键词集：用户终止 Router 自执行的信号（FB-6 纠正即学习）。 */
const CORRECTION_KEYWORDS: readonly string[] = ['停止', '不是你跑', '不是你执行', '别自己', '停下'];

/** 承诺类关键词集：用户亲自跟进的承诺信号（0.7.2 开放回路——建议登记 commitment 记忆）。 */
const COMMITMENT_KEYWORDS: readonly string[] = ['我去', '我来', '我回头', '稍后我', '明天我', '我稍后', '我自己来'];

/** 越权告警去抖窗口（毫秒）：同 agentId+path 5 分钟内只告警一次。 */
const TOOL_ALERT_DEDUP_MS = 5 * 60_000;

/** steer 提示去抖窗口（毫秒）：同 agentId+关键词 10 分钟内只注入一次。 */
const PROMPT_DEDUP_MS = 10 * 60_000;

/** 路径命中后的合法边界字符（路径分隔符/引号/空白）——避免 /root/data/local-inv 误报 /root/data/local-inv2。 */
const PATH_BOUNDARY_CHARS = new Set(['/', '\\', '"', "'", ' ', '\t', '\n', '\r']);

/** 越权告警文案（含机器可判别值：toolName、path、建议派发工具名）。 */
const TOOL_ALERT_TEMPLATE = (toolName: string, path: string): string =>
  `Router 会话工具「${toolName}」的参数指向受管 workspace 路径「${path}」——Router 应经 supervisor_task_assign 创建任务派发给对应 Worker 执行，而非在本会话直接操作该路径。`;

/** 路由命中提示文案头（含机器可判别值：supervisor_task_assign）。 */
const ROUTE_PROMPT_HEADER =
  '此请求命中路由偏好：应创建任务派发给对应 workspace 的 Worker（supervisor_task_assign），而非在本会话直接执行。命中规则：';

/** 承诺即登记提示文案（含机器可判别值：supervisor_memory_save / commitment）。 */
const COMMITMENT_PROMPT =
  '检测到用户承诺亲自跟进某事项（开放回路）：请调用 supervisor_memory_save（category=commitment，content="谁+做什么+大致时限"）登记该承诺——supervisor_briefing 会持续跟踪直至闭环，避免遗忘。';
const CORRECTION_PROMPT =
  '检测到用户终止/纠正类消息：当前请求不应由本会话继续自执行。请确认用户意图，并建议使用 supervisor_routing_save 将该职责归属固化为路由规则，后续同类请求将自动派发给对应 workspace 的 Worker。';

/** RouterGuard 最小依赖面（纯接口/函数，便于单测替身；接线见 src/index.ts）。 */
export interface RouterGuardDeps {
  /** 路由规则仓库（关键词子串匹配；src/database/repository/routing-rule-repository.ts） */
  routingRules: { lookup(text: string): RoutingRuleRow[] };
  /** 受管项目仓库（取 workspace_id；taskManager.projects） */
  projects: { list(includeArchived?: boolean): ProjectRow[] };
  /** workspaceId → 本地路径解析（接线层经 listWorkspaceOverview 做 id→path 缓存） */
  resolveWorkspacePath: (workspaceId: string) => Promise<string | undefined>;
  /** 会话运行中纠偏注入（agents.steer 包装） */
  steer: (sessionId: string, text: string) => Promise<void>;
  /** 告警通知（notifier.notify 包装） */
  notify: (message: string, severity: 'info' | 'warning' | 'critical') => Promise<boolean>;
  /** Router 会话判定（routerIdentity.isRouter） */
  isRouter: (sessionId: string) => Promise<boolean>;
  /** 可注入时钟（默认 Date.now；测试可控） */
  now?: () => number;
}

/** 判定 needle 在 text 中是否以"完整路径"形态出现：命中位置之后必须为分隔符/引号/空白或串尾。 */
function containsAtBoundary(text: string, needle: string): boolean {
  let from = 0;
  const lastStart = text.length - needle.length;
  while (from <= lastStart) {
    const idx = text.indexOf(needle, from);
    if (idx < 0 || idx > lastStart) return false;
    const afterIdx = idx + needle.length;
    const nextChar = afterIdx < text.length ? (text[afterIdx] ?? '') : '';
    if (nextChar === '' || PATH_BOUNDARY_CHARS.has(nextChar)) return true;
    from = idx + 1;
  }
  return false;
}

/**
 * 判定 text 中 path 是否作为完整路径出现。
 * 同时匹配 JSON 字符串转义形态（Windows 反斜杠路径在 argsJson 中以 \\ 形式出现），边界规则一致。
 */
function matchesPathBoundary(text: string, path: string): boolean {
  if (path === '') return false;
  if (containsAtBoundary(text, path)) return true;
  const escaped = JSON.stringify(path).slice(1, -1);
  return escaped !== path && containsAtBoundary(text, escaped);
}

/** Router 执行守卫（纯内存态，无定时器；状态仅去抖时间戳）。 */
export class RouterGuard {
  private readonly now: () => number;
  /** 越权告警去抖：key = `alert|agentId|path`，value = 上次告警毫秒时间戳 */
  private readonly alertDebounce = new Map<string, number>();
  /** steer 提示去抖：key = `route|agentId|keyword` 或 `correct|agentId|keyword`，value = 上次注入毫秒时间戳 */
  private readonly promptDebounce = new Map<string, number>();

  constructor(private readonly deps: RouterGuardDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * 工具调用越权检测（tools/result 事后消费，不拦截）：
   * Router 会话的 toolName+argsJson 拼文本，对每个受管 workspace 的 path 做边界子串匹配，
   * 命中 → notify warning（含 toolName、path、supervisor_task_assign 建议）。
   */
  async onToolResult(agentId: string, toolName: string, argsJson: string): Promise<void> {
    try {
      if (agentId === '') return;
      if (!(await this.deps.isRouter(agentId))) return;
      const text = `${toolName} ${argsJson}`;
      for (const project of this.deps.projects.list()) {
        const path = await this.deps.resolveWorkspacePath(project.workspace_id);
        if (!path) continue;
        if (!matchesPathBoundary(text, path)) continue;
        const key = `alert|${agentId}|${path}`;
        if (this.isDebounced(this.alertDebounce, key, TOOL_ALERT_DEDUP_MS)) continue;
        const delivered = await this.deps.notify(TOOL_ALERT_TEMPLATE(toolName, path), 'warning');
        // 仅送达后记录去抖：投递失败不记，下次越权可重试告警
        if (delivered) this.alertDebounce.set(key, this.now());
      }
    } catch {
      // 旁路观测组件：内部故障降级为本次不告警，绝不影响调用方主流程
    }
  }

  /**
   * 用户消息路由预检（user.message 事件消费）：
   * 命中路由规则 → steer 注入"应派发而非自执行"（含关键词与目标 workspaceId）；
   * 未命中规则但命中纠正关键词 → steer 注入"纠正即学习"（supervisor_routing_save）。
   */
  async onUserMessage(agentId: string, content: string): Promise<void> {
    try {
      if (agentId === '') return;
      if (!(await this.deps.isRouter(agentId))) return;
      const hits = this.deps.routingRules.lookup(content);
      if (hits.length > 0) {
        await this.steerRoutePrompt(agentId, hits);
        return;
      }
      const keyword = CORRECTION_KEYWORDS.find((word) => content.includes(word));
      if (keyword === undefined) {
        // 0.7.2 开放回路：承诺信号 → 建议登记 commitment 记忆（简报持续跟踪）
        const commitWord = COMMITMENT_KEYWORDS.find((word) => content.includes(word));
        if (commitWord === undefined) return;
        const commitKey = `commit|${agentId}|${commitWord}`;
        if (this.isDebounced(this.promptDebounce, commitKey, PROMPT_DEDUP_MS)) return;
        await this.deps.steer(agentId, COMMITMENT_PROMPT);
        this.promptDebounce.set(commitKey, this.now());
        return;
      }
      const key = `correct|${agentId}|${keyword}`;
      if (this.isDebounced(this.promptDebounce, key, PROMPT_DEDUP_MS)) return;
      await this.deps.steer(agentId, CORRECTION_PROMPT);
      // 仅注入成功后记录去抖：steer 失败不记，同类消息可重试
      this.promptDebounce.set(key, this.now());
    } catch {
      // 同 onToolResult：旁路守卫永不抛错
    }
  }

  /** 清理去抖状态（零定时器实现无需销毁；保留接口供生命周期接线与测试重置）。 */
  stop(): void {
    this.alertDebounce.clear();
    this.promptDebounce.clear();
  }

  /** 路由命中注入：过滤已去抖关键词后组装一条提示（含命中关键词与目标 workspaceId）。 */
  private async steerRoutePrompt(agentId: string, hits: RoutingRuleRow[]): Promise<void> {
    const fresh: RoutingRuleRow[] = [];
    for (const rule of hits) {
      if (!this.isDebounced(this.promptDebounce, `route|${agentId}|${rule.keyword}`, PROMPT_DEDUP_MS)) {
        fresh.push(rule);
      }
    }
    if (fresh.length === 0) return;
    const lines = fresh.map((rule) => `关键词「${rule.keyword}」→ workspace ${rule.workspace_id}`);
    await this.deps.steer(agentId, `${ROUTE_PROMPT_HEADER}${lines.join('；')}`);
    for (const rule of fresh) {
      this.promptDebounce.set(`route|${agentId}|${rule.keyword}`, this.now());
    }
  }

  /** 去抖判定：窗口内已触发返回 true（顺带惰性清理该表过期项，无定时器）。 */
  private isDebounced(map: Map<string, number>, key: string, windowMs: number): boolean {
    const nowMs = this.now();
    for (const [k, last] of map) {
      if (nowMs - last >= windowMs) map.delete(k);
    }
    const last = map.get(key);
    return last !== undefined && nowMs - last < windowMs;
  }
}
