# dsh-global-supervisor

DSH（DeepSeek Harness）全局监督插件：跨 Workspace 的项目管理、任务分派、状态监控、定时巡检与事件响应。

在不修改 DSH 核心源码的前提下，以一个 Router 会话统一管理多个项目 Workspace——识别项目、分派任务、恢复 Session、接收结构化汇报、定时巡检，全局状态 SQLite 持久化，Host 重启后可恢复。

## 核心特性

- **Router/Worker 分工**：Router 会话持有 `supervisor_*` 工具集（24 个）统一调度；Worker 会话经 `worker_report` 结构化汇报（权限服务端校验，非 Prompt 约束）。
- **任务状态机**：`pending → queued → running → completed` 及 `blocked / need_human / failed / canceled`，严格转换表 + 审计留痕；Task 与 TaskRun 分离，重试不覆盖历史。
- **SQLite 持久化**：十三张表（八表基线 + plugin_settings / routing_rules / event_routing_rules / thread_subscriptions 等），基于 Node 内建 `node:sqlite`，零原生依赖。
- **事件驱动**：Webhook 接入外部事件 + 五种 cordis 内部事件订阅，统一流水去重；observe/auto 双模式规则路由（转述/静音/直投 Worker），多条事件自动合批为一条 Router 通知。
- **Thread 直通**：从事件创建的任务自动订阅来源 Thread，同 Thread 后续事件直投该任务 Worker，不经 Router。
- **上下文召回**：`supervisor_recall` 按事件/任务 ID 一跳召回关联上下文（同 Thread 事件、订阅任务、Worker 汇报、执行历史）。
- **看门狗四分类**：启动超时重试 / 执行超时重试 / 需人工超时升级 / Worker 空闲失联检测，每 5 分钟自动扫描。
- **IM 推送（可选）**：经 dsh-im 把需人工提醒与完成摘要推到飞书/Telegram 等手机 IM，不可用自动降级 Router 会话。
- **串行派发**：ModelQueue 默认并发 1，优先级插队不抢占运行中任务，适配本地推理资源。
- **定时巡检**：复用 DSH 原生 Host-wide Schedule（0.2.2-rc.x），不自研 Cron。

## 环境要求

- DSH Desktop **0.2.2-rc.x**（Host-wide Schedule 依赖 0.2.x；0.1.x 不兼容）
- Node ≥ 22.19（内建 `node:sqlite`）

## 安装

```powershell
# DSH Desktop 内置终端执行（--profile 后换成你自己的 profile 名）
dsh plugin --profile desktop add dsh-global-supervisor
```

安装后重启 DSH Desktop。**装完 ≠ 可用**：首次使用需在设置面板（全局监督）指派 Router 会话，IM 推送为可选项（配置 dsh-im bot 后生效）；patch 级配置项见包内 `cordis.patch.yml` 示例。

开发期调试可用 link 模式：profile 目录 `pnpm add "dsh-global-supervisor@link:<仓库路径>"` 并把包名加入 profile 的 `dsh.profile.bundles`。

## 开发

```powershell
# 构建与测试须用 DSH runtime node（本机 PATH node 过旧）
node24 node_modules\typescript\bin\tsc -p tsconfig.json   # host 侧构建（含类型检查）
node24 scripts\build-client.mjs                        # client 侧构建（设置面板 bundle）
node24 node_modules\vitest\vitest.mjs run              # 全部测试
```

完整文档随 npm 包发行（安装后位于 `node_modules/dsh-global-supervisor/docs/`）：USER_GUIDE（使用说明）、DEVELOPMENT_PLAN（开发方案）、API_COMPATIBILITY（API 使用契约与宿主沙箱契约）、ITERATION_PLAN（迭代方案）、TEST_PLAN（测试与验收映射）、DEPLOYMENT（部署运维）、TROUBLESHOOTING（排障）、INTEGRATIONS（外部集成样例）、ASSESSMENT_SWOT（生态定位评估）。工程纪律见 [AGENTS.md](AGENTS.md)。

## 状态

当前版本 0.5.1：**迭代方案五阶段全部完成 + Phase 6 执行控制增强**——事件基础设施（Webhook + cordis 订阅）、Eval 决策层（observe/auto 规则路由）、Thread 订阅直通、多信道通知（dsh-im 优先降级会话 + 退避重试）、上下文管理（事件合批 + 链式召回）、看门狗四分类，以及 steer 插队、任务/项目级模型选择切换、会话标题 projcache 解析。25 个工具（24 Router + worker_report）、190/190 单测全绿；探针 13/13 VERIFIED；五阶段完整性测试与 Phase 6 特性均在真实 Host 实测通过（Webhook 七例矩阵、端到端合批回路、看门狗升级、模型目录 6 提供商枚举、真实标题 24/25 命中，见 API_COMPATIBILITY 变更记录）。IM 首条真实投递待用户配置 bot 后触发。

## License

MIT
