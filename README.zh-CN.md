# dsh-global-supervisor

> **简体中文** | [English](README.md)

DSH（DeepSeek Harness）全局监督插件：跨 Workspace 的项目管理、任务分派、状态监控、定时巡检与事件响应。

在不修改 DSH 核心源码的前提下，以一个 Router 会话统一管理多个项目 Workspace——识别项目、分派任务、恢复 Session、接收结构化汇报、定时巡检，全局状态 SQLite 持久化，Host 重启后可恢复。

## 核心特性

- **Router/Worker 分工**：Router 会话持有 `supervisor_*` 工具集（26 个）统一调度；Worker 会话经 `worker_report` 结构化汇报（权限服务端校验，非 Prompt 约束）。
- **任务状态机**：`pending → queued → running → completed` 及 `blocked / need_human / failed / canceled`，严格转换表 + 审计留痕；Task 与 TaskRun 分离，重试不覆盖历史。
- **SQLite 持久化**：十三张表（八表基线 + plugin_settings / routing_rules / event_routing_rules / thread_subscriptions 等），基于 Node 内建 `node:sqlite`，零原生依赖。
- **事件驱动**：Webhook 接入外部事件 + 五种 cordis 内部事件订阅，统一流水去重；observe/auto 双模式规则路由（转述/静音/直投 Worker），多条事件自动合批为一条 Router 通知。
- **Thread 直通**：从事件创建的任务自动订阅来源 Thread，同 Thread 后续事件直投该任务 Worker，不经 Router。
- **上下文召回**：`supervisor_recall` 按事件/任务 ID 一跳召回关联上下文（同 Thread 事件、订阅任务、Worker 汇报、执行历史）。
- **看门狗四分类**：启动超时重试（默认 10 分钟窗口 + Worker 活跃宽限，可经 `supervisor_watchdog_config` 运行时调整）/ 执行超时重试 / 需人工超时升级 / Worker 空闲失联检测，每 5 分钟自动扫描（间隔可调）；判死与重试必通知 Router。
- **心跳契约与进度可见性**：派发指令协议层注入周期心跳要求（间隔可配）；心跳超龄先 steer 催告 Worker 再升级告警；每轮零 LLM 产出运行任务进度快照与巡检摘要事件，并按可配间隔向 Router/IM 推送进度汇总（默认 15 分钟，可关）。
- **分类跟进与个人助手形态**：任务分类（巡检/排查/开发/维护/日常）+ 分类级差异化节奏覆盖；派发契约（验收条件 + Worker 证据 + 完成轻验证）；四类长期记忆（偏好/事实/惯例/承诺，派发时自动注入相关记忆）；每日简报（supervisor_briefing：运行×分类/异常/目标进度/开放回路/周统计，零 LLM 收集）；用户承诺自动建议登记开放回路；会话退化断路器。
- **Router 执行守卫**：Router 会话工具调用指向其他受管 workspace 路径时告警；用户消息命中路由偏好时注入"应派发而非自执行"提示；用户纠正时建议固化路由规则。
- **会话供给与退化干预**：`supervisor_session_create` 按需在受管 workspace 下新建 Worker 会话；`supervisor_task_assign` 支持 `session_id`/`fresh_session`（一任务一专用执行体，零上下文污染）；steer 兼容 need_human（引导继续）；会话空转检测（连续回合无工具产出即告警并建议轮换）。
- **IM 推送（可选）**：经 dsh-im 把需人工提醒与完成摘要推到飞书/Telegram 等手机 IM，不可用自动降级 Router 会话。
- **串行派发**：ModelQueue 默认并发 1，优先级插队不抢占运行中任务，适配本地推理资源。
- **定时巡检**：复用 DSH 原生 Host-wide Schedule（0.2.2-rc.x），不自研 Cron。
- **内置更新检查**：设置面板自动探测 npm 最新版（npmmirror 兜底），发现新版即提示升级命令。

## 环境要求

- DSH Desktop **0.2.2-rc.x**（Host-wide Schedule 依赖 0.2.x；0.1.x 不兼容）
- Node ≥ 22.19（内建 `node:sqlite`）

## 安装

```powershell
# DSH Desktop 内置终端执行（--profile 后换成你自己的 profile 名）
dsh plugin --profile desktop add dsh-global-supervisor
```

安装后重启 DSH Desktop。**装完 ≠ 可用**：首次使用需在设置面板（全局监督）指派 Router 会话，IM 推送为可选项（配置 dsh-im bot 后生效）；patch 级配置项见包内 `cordis.patch.yml` 示例。

## 升级

打开设置面板，面板会自动检查新版本（npmjs 主源、npmmirror 兜底）并给出升级命令：

```powershell
dsh plugin --profile desktop update dsh-global-supervisor
```

若升级报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`：DSH 供应链策略拦截了发布过新的版本（发版后立即升级常见）。先做指定版本豁免（`dsh plugin allow-version dsh-global-supervisor@<版本>`，报错点名的 lockfile 旧条目也需一并豁免），或等该版本发布约一天后重试——详见包内 `docs/TROUBLESHOOTING.md`。

## 文档

完整文档随 npm 包发行（安装后位于 `node_modules/dsh-global-supervisor/docs/`）：USER_GUIDE（使用说明）、TROUBLESHOOTING（排障）、DEPLOYMENT（部署运维）、INTEGRATIONS（外部集成样例）、API_COMPATIBILITY（宿主兼容契约）。

## 状态

当前版本 0.7.6：fresh_session 终局修复（真实宿主探针 VERIFIED）——编程创建会话按四要素配方装配：meta.cwd + meta.agentPreset + agentOptions 初始模型路由 + **setup 回调内 agentPresets.mount**（宿主子代理同款用法；meta.agentPreset 本身不触发装配——宿主源码与端到端探针双重实证）；预设目录适配双面服务（Host 面 remote-client：list/read，Agent 作用域完整面：mount）；探针新增 V8 装配验证与 V9 端到端（followup→inbox→推理→fs 工具→宿主机文件，9 秒实测）。31 个工具、274 个单测。

## License

MIT
