import { API_SCOPES, type AdminAuditLogEntry, type AdminUser, type ApiKeySummary, type ApiScope, type CreatedApiKey,
  type Mailbox, type MessageDetail, type MessageSummary, type Page } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, apiKeys, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { handleInbound } from '../src/services/inbound.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';

const app = createApp();
const DOMAIN = 'adminread.test';

async function request(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
function auth(token: string, ip = '203.0.113.9') { return { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': ip }; }
function json(token: string, body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { ...auth(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
async function errorCode(response: Response, status: number) {
  const body = await response.json() as { error?: { code: string; message: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.error?.code;
}

async function account(username: string, role: 'admin' | 'user') {
  const [user] = await createDb(env).insert(users)
    .values({ username, role, passwordHash: 'x', status: 'active', authVersionMigrated: true }).returning();
  const sid = await createSession(env, user!.id);
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid, epoch: 0, uepoch: 0 });
  return { id: user!.id, username, jwt };
}
async function createKey(jwt: string, name: string, scopes: ApiScope[], status = 201) {
  const response = await request('/api/api-keys', json(jwt, { name, scopes, rateLimit: 120 }));
  if (status !== 201) return { response, key: null };
  return { response, key: await data<CreatedApiKey>(response, 201) };
}
async function receive(address: string, subject: string) {
  const id = `${subject.replace(/\W+/g, '-')}-${crypto.randomUUID()}`;
  const raw = `From: Sender <sender@example.net>\r\nTo: ${address}\r\nMessage-ID: <${id}@example.net>\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nbody ${subject}\r\n`;
  const ctx = createExecutionContext();
  await handleInbound({ to: address, from: 'sender@example.net', headers: new Headers(), raw: new Response(raw).body!,
    forward: async () => {}, setReject: () => {} } as unknown as ForwardableEmailMessage, env, ctx);
  await waitOnExecutionContext(ctx);
  const row = await createDb(env).select().from(messages).where(eq(messages.messageId, `<${id}@example.net>`)).get();
  return row!.id;
}
async function adminReadAudits(actorId: number) {
  return createDb(env).select().from(adminAuditLogs).where(eq(adminAuditLogs.actorId, actorId)).all()
    .then(rows => rows.filter(row => row.action === 'api_key.admin_read'));
}

let admin: Awaited<ReturnType<typeof account>>;
let member: Awaited<ReturnType<typeof account>>;
let memberKey: string;
let memberBox: Mailbox;
let memberMessageId: number;
let unclaimedMessageId: number;

beforeAll(async () => {
  await updateSettings(env, {
    domains: { list: [{ domain: DOMAIN, public: true, perUserLimit: 0 }] },
    code_extract: { enabled: false, aiEnabled: false },
    quota: { dailyOutbound: 0, dailyRecipients: 0 },
    security: { require2fa: false },
    api: { enabled: true },
  });
  admin = await account('ar-admin', 'admin');
  member = await account('ar-member', 'user');
  memberKey = (await createKey(member.jwt, 'member-full', [...API_SCOPES])).key!.key;
  memberBox = await data<Mailbox>(await request('/v1/mailboxes', json(memberKey, { localPart: 'ar-member-box', domain: DOMAIN })), 201);
  memberMessageId = await receive(memberBox.address, 'Member private mail');
  unclaimedMessageId = await receive(`ar-nobody@${DOMAIN}`, 'Unclaimed mail');
});

describe('admin.read API Key 权限', () => {
  it('管理员 Key 带 admin.read 可只读全站：用户、邮箱、共享、未认领、审阅他人、域名统计、审计', async () => {
    const { key } = await createKey(admin.jwt, 'admin-reader', ['admin.read']);
    expect(key!.scopes).toEqual(['admin.read']);
    const token = key!.key;

    const userList = await data<AdminUser[]>(await request('/v1/admin/users', { headers: auth(token) }));
    expect(userList.map(u => u.username)).toEqual(expect.arrayContaining(['ar-admin', 'ar-member']));
    const search = await data<{ items: { username: string }[] }>(await request('/v1/admin/users/search?q=ar-mem', { headers: auth(token) }));
    expect(search.items.map(u => u.username)).toContain('ar-member');

    const boxes = await data<Mailbox[]>(await request('/v1/admin/mailboxes', { headers: auth(token) }));
    expect(boxes.find(box => box.id === memberBox.id)).toMatchObject({ address: memberBox.address, ownerUsername: 'ar-member' });
    expect(await data<Mailbox>(await request(`/v1/admin/mailboxes/${memberBox.id}`, { headers: auth(token) }))).toMatchObject({ address: memberBox.address });
    expect(await data<unknown[]>(await request('/v1/admin/mailbox-shares', { headers: auth(token) }))).toEqual(expect.any(Array));

    const unclaimed = await data<Page<MessageSummary>>(await request('/v1/admin/messages?scope=unclaimed', { headers: auth(token) }));
    expect(unclaimed.items.map(m => m.id)).toContain(unclaimedMessageId);
    expect(unclaimed.items.map(m => m.id)).not.toContain(memberMessageId);

    const review = await data<Page<MessageSummary>>(await request(`/v1/admin/messages?scope=user&userId=${member.id}`, { headers: auth(token) }));
    expect(review.items.map(m => m.id)).toEqual([memberMessageId]);
    const detail = await data<MessageDetail>(await request(`/v1/admin/messages/${memberMessageId}?scope=user&userId=${member.id}`, { headers: auth(token) }));
    expect(detail.subject).toBe('Member private mail');
    // 只读审阅不改所有者的已读状态
    expect((await createDb(env).select().from(messages).where(eq(messages.id, memberMessageId)).get())!.isRead).toBe(false);

    expect(await errorCode(await request('/v1/admin/messages', { headers: auth(token) }), 400)).toBe('validation_failed');
    const stats = await data<{ domain: string }[]>(await request('/v1/admin/domain-stats', { headers: auth(token) }));
    expect(stats.map(s => s.domain)).toEqual([DOMAIN]);

    const audit = await data<Page<AdminAuditLogEntry>>(await request('/v1/admin/audit-logs?limit=100', { headers: auth(token) }));
    expect(audit.items.some(row => row.action === 'api_key.admin_read' && row.target === 'GET /v1/admin/users')).toBe(true);
  });

  it('每次使用 admin.read 都写一条管理审计：操作者、路径、Key、状态码与来源 IP', async () => {
    const reader = await account('ar-audit-admin', 'admin');
    const { key } = await createKey(reader.jwt, 'audit-reader', ['admin.read', 'mail.read']);
    expect(await adminReadAudits(reader.id)).toHaveLength(0);
    await data(await request('/v1/admin/mailboxes', { headers: auth(key!.key, '198.51.100.7') }));
    await data(await request(`/v1/admin/messages?scope=user&userId=${member.id}&limit=5`, { headers: auth(key!.key, '198.51.100.7') }));
    expect(await errorCode(await request('/v1/admin/mailboxes/999999', { headers: auth(key!.key, '198.51.100.7') }), 404)).toBe('not_found');
    const rows = await adminReadAudits(reader.id);
    expect(rows.map(row => row.target)).toEqual(['GET /v1/admin/mailboxes', 'GET /v1/admin/messages', 'GET /v1/admin/mailboxes/999999']);
    expect(rows.every(row => row.actorName === 'ar-audit-admin' && row.ip === '198.51.100.7')).toBe(true);
    expect(rows[0]!.detail).toBe(`key #${key!.id} · 200`);
    expect(rows[1]!.detail).toBe(`key #${key!.id} · 200 · ?scope=user&userId=${member.id}&limit=5`);
    expect(rows[2]!.detail).toBe(`key #${key!.id} · 404`);
    // 普通 /v1 接口不写管理审计
    await data(await request('/v1/messages', { headers: auth(key!.key) }));
    expect(await adminReadAudits(reader.id)).toHaveLength(3);
  });

  it('普通用户申请或追加 admin.read 直接 403；伪造进库的 admin.read 也读不到，且不写管理审计', async () => {
    const user = await account('ar-plain', 'user');
    const denied = await createKey(user.jwt, 'sneaky', ['mail.read', 'admin.read'], 403);
    expect(await errorCode(denied.response, 403)).toBe('forbidden');
    const { key } = await createKey(user.jwt, 'plain', ['mail.read']);
    expect(await errorCode(await request(`/api/api-keys/${key!.id}`, json(user.jwt, { scopes: ['mail.read', 'admin.read'] }, 'PUT')), 403)).toBe('forbidden');
    expect((await data<ApiKeySummary>(await request(`/api/api-keys/${key!.id}`, { headers: auth(user.jwt) }))).scopes).toEqual(['mail.read']);

    // 绕过接口直接写库，模拟伪造
    await createDb(env).update(apiKeys).set({ scopes: ['mail.read', 'admin.read'] }).where(eq(apiKeys.id, key!.id));
    for (const path of ['/v1/admin/users', '/v1/admin/mailboxes', '/v1/admin/messages?scope=unclaimed', '/v1/admin/audit-logs']) {
      expect(await errorCode(await request(path, { headers: auth(key!.key) }), 403), path).toBe('forbidden');
    }
    // 普通用户的 /v1 原有越权拒绝不变
    expect((await request('/v1/messages?scope=unclaimed', { headers: auth(key!.key) })).status).toBe(403);
    expect(await adminReadAudits(user.id)).toHaveLength(0);
  });

  it('管理员被降级后，其 Key 上的 admin.read 立即失效', async () => {
    const demoted = await account('ar-demoted', 'admin');
    const { key } = await createKey(demoted.jwt, 'soon-demoted', ['admin.read']);
    await data(await request('/v1/admin/users', { headers: auth(key!.key) }));
    await createDb(env).update(users).set({ role: 'user' }).where(eq(users.id, demoted.id));
    expect(await errorCode(await request('/v1/admin/users', { headers: auth(key!.key) }), 403)).toBe('forbidden');
    expect(await adminReadAudits(demoted.id)).toHaveLength(1);
  });

  it('没带 admin.read 的管理员 Key 行为与原来一致：/v1/admin 拒绝，原有 all=1 与 scope 照旧且不写管理审计', async () => {
    const legacy = await account('ar-legacy-admin', 'admin');
    const { key } = await createKey(legacy.jwt, 'legacy', [...API_SCOPES]);
    expect(key!.scopes).toEqual([...API_SCOPES]);
    expect(await errorCode(await request('/v1/admin/users', { headers: auth(key!.key) }), 403)).toBe('forbidden');
    const all = await data<Mailbox[]>(await request('/v1/mailboxes?all=1', { headers: auth(key!.key) }));
    expect(all.map(box => box.id)).toContain(memberBox.id);
    const unclaimed = await data<Page<MessageSummary>>(await request('/v1/messages?scope=unclaimed', { headers: auth(key!.key) }));
    expect(unclaimed.items.map(m => m.id)).toContain(unclaimedMessageId);
    const review = await data<Page<MessageSummary>>(await request(`/v1/messages?scope=user&userId=${member.id}`, { headers: auth(key!.key) }));
    expect(review.items.map(m => m.id)).toEqual([memberMessageId]);
    const status = await data<{ scopes: string[] }>(await request('/v1/status', { headers: auth(key!.key) }));
    expect(status.scopes).toEqual([...API_SCOPES]);
    expect(await adminReadAudits(legacy.id)).toHaveLength(0);
  });

  it('admin.read 不开放写操作：/v1/admin 下非 GET 一律不存在', async () => {
    const writer = await account('ar-writer', 'admin');
    const { key } = await createKey(writer.jwt, 'writer', ['admin.read']);
    for (const [method, path] of [['POST', '/v1/admin/users'], ['PUT', `/v1/admin/mailboxes/${memberBox.id}`], ['DELETE', `/v1/admin/mailboxes/${memberBox.id}`],
      ['POST', `/v1/admin/mailboxes/${memberBox.id}/transfer`], ['PUT', '/v1/admin/mailbox-shares']] as const) {
      const response = await request(path, json(key!.key, {}, method));
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect((await createDb(env).select().from(users).where(eq(users.id, member.id)).get())!.role).toBe('user');
    // 管理员 JWT 仍可在 /api/api-keys 自行增删 admin.read
    const updated = await data<ApiKeySummary>(await request(`/api/api-keys/${key!.id}`, json(writer.jwt, { scopes: ['mail.read'] }, 'PUT')));
    expect(updated.scopes).toEqual(['mail.read']);
    expect(await errorCode(await request('/v1/admin/users', { headers: auth(key!.key) }), 403)).toBe('forbidden');
    const restored = await data<ApiKeySummary>(await request(`/api/api-keys/${key!.id}`, json(writer.jwt, { scopes: ['mail.read', 'admin.read'] }, 'PUT')));
    expect(restored.scopes).toEqual(['mail.read', 'admin.read']);
    await data(await request('/v1/admin/users', { headers: auth(key!.key) }));
  });
});
