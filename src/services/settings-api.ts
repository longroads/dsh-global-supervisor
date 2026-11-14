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
export interface SettingsApiResponse {
  router: { mode: string; sessionId: string; workspaceId?: string; claimedAt: string } | null;
  workspaces: Array<{ id: string; title: string; path: string; sessionIds: readonly string[] }>;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 注册设置 API 路由（幂等调用方保证一次性）。 */
export async function registerSettingsApi(ctx: Context, stack: SupervisorStack): Promise<void> {
  const webServer = await awaitService<WebServerLike>(ctx, 'webServer');

  webServer.register({
    kind: 'exact',
    path: '/global-supervisor/settings',
    resource: async () => {
      const workspaces = await stack.workspaceManager.listWorkspaceOverview(true);
      const payload: SettingsApiResponse = {
        router: stack.routerIdentity.current() ?? null,
        workspaces: workspaces.map((item) => ({ id: item.workspaceId, title: item.title, path: item.path, sessionIds: [] })),
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
}

/** 读取并解析 JSON 请求体（上限 4KB，畸形返回 undefined）。 */
function readJsonBody(req: { on: (event: string, cb: (chunk?: Buffer) => void) => void }): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk?: Buffer) => {
      if (chunk) {
        size += chunk.length;
        if (size > 4096) {
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
