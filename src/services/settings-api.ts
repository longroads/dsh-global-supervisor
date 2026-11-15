/**
 * 设置面板 HTTP API：webServer 路由（client fetch 的后端，契约见 docs/UI_PANEL_PLAN.md）。
 * GET  /global-supervisor/settings —— workspace 清单 + 当前 Router 身份（resource 模式，答 GET/HEAD）
 * POST /global-supervisor/claim    —— 指派 Router（handler 模式；物理访问授权语义）
 * 安全：webserver 绑定 loopback；POST 校验同源/loopback Origin + JSON 体严格校验。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { awaitService } from '../adapters/host-services.js';
import type { SupervisorStack } from '../runtime.js';

/** 最小 WebServer 服务面（沙箱 ctx.get 解析，类型收窄）。 */
interface WebServerLike {
  register(route: unknown): () => void;
}

/** GET settings 的响应形态（client 面板消费）。 */
export interface SessionOption {
  id: string;
  /** 面板下拉显示名：目录名 · 日期 · 短 ID（快照数据派生，不读事件流） */
  label: string;
}

export interface SettingsApiResponse {
  /** 当前生效身份（认领记录优先，其次 patch 预置；source 区分来源，preset 无 claimedAt 时间戳） */
  router: { mode: string; sessionId: string; workspaceId?: string; claimedAt: string; source: 'claimed' | 'preset' } | null;
  workspaces: Array<{ id: string; title: string; path: string; sessions: SessionOption[] }>;
}

/** 从快照派生会话显示名（用户不认识原始 ID；标题需读事件流故第一版不取）。 */
function sessionLabel(snapshot: { sessionId: string; cwd?: string; createdAt?: number }): string {
  const dir = snapshot.cwd !== undefined ? snapshot.cwd.split(/[\\/]/).filter(Boolean).pop() ?? '' : '';
  const date = snapshot.createdAt !== undefined ? new Date(snapshot.createdAt).toISOString().slice(0, 10) : '';
  const short = snapshot.sessionId.replace(/^session-/, '').slice(0, 8);
  return [dir, date, short].filter((part) => part !== '').join(' · ');
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Webhook 事件路由选项（ITERATION_PLAN 1-D；来自插件 config.events）。 */
export interface WebhookEventOptions {
  webhookSources: string[];
  maxEventTextChars: number;
  redactPatterns: boolean;
}

// 凭证脱敏正则（借鉴 MYCF711 redact() 单出口模式）：GitHub PAT / PEM 私钥 / Bearer / api key
const REDACT_PATTERNS: RegExp[] = [
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  /\b(?:api[-_]?key|apikey|access[-_]?token|secret)\b["'\s:=]+[A-Za-z0-9\-._]{16,}/gi,
];

/** 凭证脱敏：Webhook 事件正文进入 EventManager 前的单出口过滤。 */
export function redact(text: string): string {
  let out = text;
  for (const pattern of REDACT_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

/** 注册设置 API 路由（幂等调用方保证一次性；webhookOptions 为 Webhook 事件路由配置）。 */
export async function registerSettingsApi(ctx: Context, stack: SupervisorStack, webhookOptions?: WebhookEventOptions): Promise<void> {
  const webServer = await awaitService<WebServerLike>(ctx, 'webServer');

  webServer.register({
    kind: 'exact',
    path: '/global-supervisor/settings',
    resource: async () => {
      const overview = await stack.workspaceManager.listWorkspaceOverview(true);
      const snapshots = await stack.sessionAdapter.listSnapshots();
      const labels = new Map(snapshots.map((s) => [s.sessionId, s]));
      const allSessionIds = overview.flatMap((item) => [...item.sessionIds]);
      const titles = await stack.sessionAdapter.readTitles(allSessionIds);
      const claimed = stack.routerIdentity.current();
      const fallbackSession = stack.routerIdentity.ownerSessionId();
      const router: SettingsApiResponse['router'] = claimed
        ? { ...claimed, source: 'claimed' }
        : fallbackSession !== ''
          ? { mode: 'session', sessionId: fallbackSession, claimedAt: '', source: 'preset' }
          : null;
      const payload: SettingsApiResponse = {
        router,
        workspaces: overview.map((item) => ({
          id: item.workspaceId,
          title: item.title,
          path: item.path,
          sessions: item.sessionIds.map((id) => ({
            id,
            label: titles.get(id) ?? sessionLabel(labels.get(id) ?? { sessionId: id }),
          })),
        })),
      };
      return jsonResponse(payload);
    },
  });

  webServer.register({
    kind: 'exact',
    path: '/global-supervisor/client-ping',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.statusCode = 200;
      res.end('{"ok":true}');
      let body = '';
      try {
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve) => {
          req.on('data', (c?: Buffer) => { if (c) chunks.push(c); });
          req.on('end', () => resolve());
        });
        body = Buffer.concat(chunks).toString('utf8').slice(0, 300);
      } catch {
        body = '';
      }
      const { appendFile, mkdir } = await import('node:fs/promises');
      const os = await import('node:os');
      const path = await import('node:path');
      const file = path.join(os.homedir(), '.dsh', 'global-supervisor-load.log');
      await mkdir(path.dirname(file), { recursive: true }).catch(() => undefined);
      await appendFile(file, `${new Date().toISOString()} [client-ping] ${body || '(no-body)'}\n`, 'utf8').catch(() => undefined);
    },
  });

  webServer.register({
    kind: 'exact',
    path: '/global-supervisor/claim',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      const origin = req.headers.origin ?? '';
      const host = req.headers.host ?? '';
      if (origin !== '' && origin !== `http://${host}`) {
        res.statusCode = 403;
        res.end(JSON.stringify({ ok: false, error: 'origin' }));
        return;
      }
      const body = await readJsonBody(req);
      if (body === undefined) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: 'invalid-body' }));
        return;
      }
      const mode = body['mode'] === 'workspace' ? 'workspace' : 'session';
      const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : '';
      const workspaceId = typeof body['workspaceId'] === 'string' ? body['workspaceId'] : undefined;
      if (sessionId.trim() === '' || (mode === 'workspace' && (workspaceId ?? '').trim() === '')) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: 'missing-args' }));
        return;
      }
      const record = stack.routerIdentity.assign({ mode, sessionId, workspaceId });
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, router: record }));
    },
  });

  // Webhook 事件路由（ITERATION_PLAN 1-D）：外部系统 POST → redact/截断 → EventManager 统一入口
  webServer.register({
    kind: 'prefix',
    path: '/global-supervisor/events',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      const origin = req.headers.origin ?? '';
      const host = req.headers.host ?? '';
      if (origin !== '' && origin !== `http://${host}`) {
        res.statusCode = 403;
        res.end(JSON.stringify({ ok: false, error: 'origin' }));
        return;
      }
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }));
        return;
      }
      const body = await readJsonBody(req, 65_536);
      if (body === undefined) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: 'invalid-body' }));
        return;
      }
      const source = typeof body['source'] === 'string' ? body['source'] : '';
      const allowed = webhookOptions?.webhookSources ?? [];
      if (allowed.length > 0 && !allowed.includes(source)) {
        res.statusCode = 403;
        res.end(JSON.stringify({ ok: false, error: 'source-not-allowed' }));
        return;
      }
      const type = typeof body['type'] === 'string' ? body['type'] : '';
      if (type === '') {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: 'missing-type' }));
        return;
      }
      let payloadJson = '{}';
      if (body['payload'] !== undefined) payloadJson = JSON.stringify(body['payload']);
      if (webhookOptions?.redactPatterns !== false) payloadJson = redact(payloadJson);
      const maxChars = webhookOptions?.maxEventTextChars ?? 4000;
      if (payloadJson.length > maxChars) {
        payloadJson = JSON.stringify({ truncated: true, text: payloadJson.slice(0, maxChars) });
      }
      const explicitId = typeof body['event_id'] === 'string' ? (body['event_id'] as string).trim() : '';
      const eventId = explicitId !== '' ? `webhook:${source}:${explicitId}` : `webhook:${source}:${type}:${Date.now()}`;
      const result = await stack.eventManager.ingest({
        eventId,
        source: 'webhook',
        type,
        payloadJson,
        threadId: typeof body['thread_id'] === 'string' ? (body['thread_id'] as string) : undefined,
        channelRef: source !== '' ? `webhook:${source}` : undefined,
      });
      res.statusCode = 202;
      res.end(JSON.stringify({ ok: true, inserted: result.inserted, duplicate: !result.inserted }));
    },
  });
}

/** 读取并解析 JSON 请求体（超限或畸形返回 undefined；claim 默认 4KB，webhook 可放宽至 64KB）。 */
function readJsonBody(req: { on: (event: string, cb: (chunk?: Buffer) => void) => void }, limit = 4096): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk?: Buffer) => {
      if (chunk) {
        size += chunk.length;
        if (size > limit) {
          resolve(undefined);
          return;
        }
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        resolve(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}
