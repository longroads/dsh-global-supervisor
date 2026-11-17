# dsh-global-supervisor

> [简体中文](README.zh-CN.md) | **English**

Global supervisor plugin for DSH (DeepSeek Harness): cross-workspace project management, task dispatch, status monitoring, scheduled inspections, and event response — without modifying DSH core.

A single Router session manages many project workspaces: identify projects, dispatch tasks, resume sessions, receive structured worker reports, run periodic patrols. All state persists in SQLite and survives host restarts.

## Highlights

- **Router/Worker split** — the Router session holds 26 `supervisor_*` tools; worker sessions report via `worker_report` with server-side permission checks (not prompt constraints).
- **Task state machine** — `pending → queued → running → completed` plus `blocked / need_human / failed / canceled`; strict transition table with audit trail; Task/TaskRun separation keeps retry history intact.
- **SQLite persistence** — 13 tables on built-in `node:sqlite`, zero native dependencies.
- **Event-driven** — webhook intake + 5 cordis event subscriptions with a unified dedup pipeline; observe/auto rule routing; multiple events batched into one Router notification.
- **Thread passthrough** — tasks created from an event auto-subscribe to its thread; follow-up events on the same thread go straight to the assigned worker, bypassing the Router.
- **Context recall** — `supervisor_recall` pulls related context (thread events, subscriptions, worker reports, run history) in one hop.
- **Watchdog, 4 classes** — startup-timeout retry (10-min window with live-agent grace, tunable at runtime via `supervisor_watchdog_config`), run-timeout retry, need-human escalation, idle/lost worker detection; 5-minute scans by default (interval also tunable). Judgements and retries always notify the Router.
- **Heartbeat contract & progress visibility** — dispatch instructions embed a periodic heartbeat requirement (interval configurable); a stale heartbeat first steers the worker to report, then escalates; every scan emits zero-LLM progress snapshots and patrol summaries into the event stream, with an optional periodic progress digest to the Router/IM (default 15 min, 0 disables).
- **Category-based cadence & personal-assistant form** — task categories (inspection/investigation/development/maintenance/daily) with per-category watchdog overrides; dispatch contracts (acceptance criteria + worker evidence + zero-LLM completion verification); four memory categories (preference/fact/routine/commitment) auto-injected into dispatches; a daily briefing tool (running-by-category, exceptions, goal progress, open loops, weekly stats — zero-LLM collection); automatic open-loop registration prompts on user commitments; and a session-degeneration circuit breaker.
- **Router execution guard** — flags Router-session tool calls that target other managed workspaces, injects "dispatch instead of self-execute" hints on routing-preference hits, and suggests saving a routing rule when the user corrects the Router.
- **Session supply & degeneration response** — `supervisor_session_create` provisions fresh worker sessions on demand; `supervisor_task_assign` accepts `session_id`/`fresh_session` for one-task-one-executor isolation (zero context pollution); steer works on `need_human` tasks (guide-and-continue); idle-spin detection warns when a worker session finishes turns without any tool output.
- **IM push (optional)** — need-human alerts and completion summaries to Feishu/Telegram etc. via dsh-im, with automatic fallback to the Router session.
- **Model control** — per-task / per-project model selection and switching; `steer` to inject instructions into a running task.
- **Serial dispatch** — ModelQueue defaults to concurrency 1 with priority queue-jumping that never preempts a running task, tuned for local inference.
- **Scheduled inspections** — reuses the DSH native host-wide Schedule service (0.2.2-rc.x); no custom cron.
- **Built-in update check** — the settings panel probes the latest npm release (with npmmirror fallback) and shows an upgrade hint when a newer version exists.

## Requirements

- DSH Desktop **0.2.2-rc.x** (host-wide Schedule requires 0.2.x; 0.1.x is incompatible)
- Node ≥ 22.19 (built-in `node:sqlite`; shipped with the DSH runtime)

## Install

```powershell
# Run in the DSH Desktop built-in terminal (replace "desktop" with your profile name)
dsh plugin --profile desktop add dsh-global-supervisor
```

Restart DSH Desktop. **Installing is not enough**: open the settings panel ("Global Supervisor") and assign a Router session first. IM push is optional (configure a dsh-im bot). Patch-level configuration options: see `cordis.patch.yml`.

## Upgrade

Open the settings panel — it checks for new releases (npmjs, npmmirror fallback) and shows the upgrade command:

```powershell
dsh plugin --profile desktop update dsh-global-supervisor
```

If the upgrade fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, DSH's supply-chain policy is rejecting a version published more recently than the policy window (common right after a release). Grant an exact-version exemption (`dsh plugin allow-version dsh-global-supervisor@<version>`, covering the stale lockfile entry named in the error as well), or retry about a day after that version was published — see the packaged `docs/TROUBLESHOOTING.md` for details.

## Documentation

Full documentation ships inside the npm package (in Chinese) at `node_modules/dsh-global-supervisor/docs/`: USER_GUIDE (usage), TROUBLESHOOTING (troubleshooting), DEPLOYMENT (deployment & operations), INTEGRATIONS (external integration examples), API_COMPATIBILITY (host compatibility contract).

## Status

Version 0.7.2 — personal-assistant completion: task categories with per-category cadence overrides, dispatch contracts (acceptance + evidence + zero-LLM completion verification), four memory categories auto-injected into dispatches, a daily briefing tool (zero-LLM: running-by-category, exceptions, goal progress, open loops, weekly stats), automatic open-loop prompts on user commitments, and a session-degeneration circuit breaker. Prior: 0.6.x closed-loop hardening, 0.7.0 degeneration response & session supply, 0.7.1 heartbeat contract & progress visibility. 30 tools (29 Router + `worker_report`), 253 unit tests. Note: 0.6.0 was a broken publish (UTF-8 BOM) and is superseded — always update to the latest.

## License

MIT
