import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { buildSessionOpenApiSpec } from '../src/routes/api-openapi.js';
import { buildOpenApiSpec } from '../src/routes/v1/openapi.js';

const app = createApp();
const origin = 'https://mail.test';

/** 线上 temp-mailbox 版本的 10 个临时访问接口；合并 admin.read 后必须仍然挂载。 */
const TEMP_ACCESS_ROUTES = [
  ['GET', '/mailboxes/:id/temp-access'],
  ['PUT', '/mailboxes/:id/temp-access'],
  ['DELETE', '/mailboxes/:id/temp-access'],
  ['POST', '/mailbox-access/login'],
  ['POST', '/mailbox-access/logout'],
  ['GET', '/mailbox-access/session'],
  ['GET', '/mailbox-access/messages'],
  ['GET', '/mailbox-access/messages/:id'],
  ['GET', '/mailbox-access/messages/:id/raw'],
  ['GET', '/mailbox-access/attachments/:id'],
] as const;

async function call(method: string, path: string, body?: unknown) {
  const ctx = createExecutionContext();
  const res = await app.request(`${origin}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('合并 admin.read 后临时邮箱访问接口仍在', () => {
  it('10 个 temp-access 路由都挂在 /api 下', () => {
    const mounted = new Set(app.routes.map((route) => `${route.method} ${route.path.replace(/\/$/, '')}`));
    for (const [method, path] of TEMP_ACCESS_ROUTES) expect(mounted, `${method} /api${path}`).toContain(`${method} /api${path}`);
  });

  it('10 个 temp-access 路由都写进 JWT OpenAPI', () => {
    const paths = buildSessionOpenApiSpec(origin).paths as Record<string, Record<string, unknown>>;
    for (const [method, path] of TEMP_ACCESS_ROUTES) {
      const key = path.replace(/:([^/]+)/g, '{$1}');
      expect(paths[key], key).toHaveProperty(method.toLowerCase());
    }
  });

  it.each(TEMP_ACCESS_ROUTES)('未登录调用 %s /api%s 走对应处理而不是 404', async (method, path) => {
    const concrete = path.replace(/:id/g, '1');
    const isLogin = concrete === '/mailbox-access/login';
    const res = await call(method, `/api${concrete}`, method === 'PUT' ? { maxLogins: 1 }
      : isLogin ? { email: 'missing@example.test', password: 'incorrect' } : undefined);
    expect(res.status).not.toBe(404);
    if (concrete === '/mailbox-access/logout') {
      // 没有会话时退出是幂等清 Cookie
      expect(res.status).toBe(200);
      return;
    }
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe(isLogin ? 'bad_credentials' : 'unauthorized');
  });

  it('admin.read 的 /v1/admin 与 temp-access 同时存在', async () => {
    const v1 = buildOpenApiSpec(origin).paths as Record<string, unknown>;
    expect(v1).toHaveProperty('/admin/mailboxes');
    const res = await call('GET', '/v1/admin/mailboxes');
    expect(res.status).toBe(401);
  });
});
