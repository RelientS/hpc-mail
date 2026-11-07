import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { attachments, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { createMailboxAccess, mailboxAccessStatus } from '../src/services/mailbox-access.js';
import { createSession } from '../src/services/session.js';
import type { AuthUser } from '../src/types.js';

const app = createApp();
const db = createDb(env);
const unique = () => crypto.randomUUID();
async function request(path: string, method = 'GET', body?: unknown, cookie?: string, jwt?: string, headers?: Record<string, string>) {
  const ctx = createExecutionContext();
  const res = await app.request(`https://mail.test/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': unique(),
      ...(cookie ? { Cookie: cookie } : {}), ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
async function fixture(count = 2, role: 'admin' | 'user' = 'user') {
  const [user] = await db.insert(users).values({ username: unique(), passwordHash: 'x', role, authVersionMigrated: true }).returning();
  const actor: AuthUser = { ...user!, twoFactorEnabled: false };
  const [box] = await db.insert(mailboxes).values({ userId: actor.id, domain: 'example.test', address: `${unique()}@example.test` }).returning();
  const grant = await createMailboxAccess(env, actor, box!.id, count);
  const sid = await createSession(env, actor.id);
  const jwt = await signToken(env.jwt_secret, { sub: actor.id, sid, epoch: 0, uepoch: 0 });
  return { actor, box: box!, grant, jwt };
}
async function login(f: Awaited<ReturnType<typeof fixture>>, password = f.grant.password) {
  const res = await request('/mailbox-access/login', 'POST', { email: f.box.address, password });
  return { res, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
async function mail(address: string, direction: 'inbound' | 'outbound' = 'inbound', deletedAt?: Date) {
  const [row] = await db.insert(messages).values({ address, direction, domain: 'example.test', subject: 'Test mail',
    bodyText: 'private body', verificationCode: '837261', status: 'received', deletedAt }).returning();
  return row!;
}

describe('单邮箱临时登录', () => {
  it('密码只返回一次且哈希存储，错误密码不扣次数，刷新与读取不扣次数', async () => {
    const f = await fixture();
    const stored = await env.db.prepare('SELECT password_hash FROM mailbox_access_grants WHERE mailbox_id = ?').bind(f.box.id).first<{ password_hash: string }>();
    expect(stored!.password_hash).not.toBe(f.grant.password);
    expect((await login(f, 'incorrect')).res.status).toBe(401);
    expect((await mailboxAccessStatus(env, f.actor, f.box.id)).usedLogins).toBe(0);
    const { res, cookie } = await login(f);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(res.headers.get('set-cookie')).toMatch(/Secure/);
    expect(res.headers.get('set-cookie')).toMatch(/SameSite=Strict/);
    for (let i = 0; i < 3; i++) {
      const me = await request('/mailbox-access/session', 'GET', undefined, cookie);
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ data: { address: f.box.address, remainingLogins: 1 } });
    }
    expect((await mailboxAccessStatus(env, f.actor, f.box.id)).usedLogins).toBe(1);
    const status = await request(`/mailboxes/${f.box.id}/temp-access`, 'GET', undefined, undefined, f.jwt);
    expect(JSON.stringify(await status.json())).not.toContain(f.grant.password);
  });

  it('十个并发请求争抢最后一次，恰好一个成功；次数耗尽仍保留已签发会话', async () => {
    const f = await fixture(1);
    const results = await Promise.all(Array.from({ length: 10 }, () => login(f)));
    expect(results.filter((r) => r.res.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.res.status === 401)).toHaveLength(9);
    expect((await mailboxAccessStatus(env, f.actor, f.box.id)).usedLogins).toBe(1);
    expect((await request('/mailbox-access/session', 'GET', undefined, results.find((r) => r.cookie)!.cookie)).status).toBe(200);
  });

  it('仅列出本邮箱未删除来信，猜其他邮箱/同所有者邮箱/已发送/回收站 ID 均拒绝', async () => {
    const f = await fixture(1, 'admin');
    const mine = await mail(f.box.address);
    const [otherBox] = await db.insert(mailboxes).values({ userId: f.actor.id, address: `${unique()}@example.test`, domain: 'example.test' }).returning();
    const hidden = [await mail(otherBox!.address), await mail(`${unique()}@example.test`),
      await mail(f.box.address, 'outbound'), await mail(f.box.address, 'inbound', new Date())];
    const { cookie } = await login(f);
    const list = await request('/mailbox-access/messages', 'GET', undefined, cookie);
    expect(await list.json()).toMatchObject({ data: { items: [{ id: mine.id }], nextBefore: null } });
    const detail = await request(`/mailbox-access/messages/${mine.id}`, 'GET', undefined, cookie);
    const payload = await detail.json() as { data: Record<string, unknown> };
    expect(payload.data.bodyText).toBe('private body');
    expect(payload.data).not.toHaveProperty('notifyOwnerIds');
    for (const row of hidden) {
      expect((await request(`/mailbox-access/messages/${row.id}`, 'GET', undefined, cookie)).status).toBe(404);
      expect((await request(`/mailbox-access/messages/${row.id}/raw`, 'GET', undefined, cookie)).status).toBe(404);
    }
    for (const query of ['scope=all', `address=${otherBox!.address}`, `userId=${f.actor.id}`, 'before=-1'])
      expect((await request(`/mailbox-access/messages?${query}`, 'GET', undefined, cookie)).status).toBe(400);
    for (const path of ['/auth/me', '/mailboxes', '/admin/users', '/api-keys', '/messages'])
      expect((await request(path, 'GET', undefined, cookie)).status).toBe(401);
    expect((await request('/messages/delete', 'POST', { ids: [mine.id] }, cookie)).status).toBe(401);
    expect((await request('/mailbox-access/messages/send', 'POST', {}, cookie)).status).toBe(404);
  });

  it('附件、原始邮件和 R2 完整正文使用相同边界，撤销后链接也失效', async () => {
    const f = await fixture();
    const mine = await mail(f.box.address);
    const other = await mail(`${unique()}@example.test`);
    const key = unique();
    await env.r2.put(key, 'download payload');
    await env.r2.put(`${key}-body`, JSON.stringify({ text: 'full body', html: '<b>full body</b>' }));
    await db.update(messages).set({ rawR2Key: key, bodyR2Key: `${key}-body` }).where(eq(messages.id, mine.id));
    const ats = await db.insert(attachments).values([mine, other].map((m) => ({ messageId: m.id, r2Key: key, size: 16, filename: 'hello.txt' }))).returning();
    const { cookie } = await login(f);
    const detail = await request(`/mailbox-access/messages/${mine.id}`, 'GET', undefined, cookie);
    expect(await detail.json()).toMatchObject({ data: { bodyText: 'full body', hasRaw: true,
      attachments: [{ url: `/api/mailbox-access/attachments/${ats[0]!.id}` }] } });
    expect((await request(`/mailbox-access/messages/${mine.id}/raw`, 'GET', undefined, cookie)).status).toBe(200);
    expect((await request(`/mailbox-access/attachments/${ats[0]!.id}`, 'GET', undefined, cookie)).status).toBe(200);
    expect((await request(`/mailbox-access/attachments/${ats[1]!.id}`, 'GET', undefined, cookie)).status).toBe(404);
    await request(`/mailboxes/${f.box.id}/temp-access`, 'DELETE', undefined, undefined, f.jwt);
    expect((await request(`/mailbox-access/attachments/${ats[0]!.id}`, 'GET', undefined, cookie)).status).toBe(401);
    expect((await login(f)).res.status).toBe(401);
  });

  it('只有所有者或管理员可创建和撤销，临时会话不能管理授权', async () => {
    const f = await fixture();
    const other = await fixture();
    const { cookie } = await login(f);
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const body = method === 'PUT' ? { maxLogins: 2 } : undefined;
      expect((await request(`/mailboxes/${f.box.id}/temp-access`, method, body, undefined, other.jwt)).status).toBe(403);
      expect((await request(`/mailboxes/${f.box.id}/temp-access`, method, body, cookie)).status).toBe(401);
    }
    for (const maxLogins of [0, 101, 1.5, '2'])
      expect((await request(`/mailboxes/${f.box.id}/temp-access`, 'PUT', { maxLogins }, undefined, f.jwt)).status).toBe(400);
    const admin = await fixture(1, 'admin');
    expect((await request(`/mailboxes/${f.box.id}/temp-access`, 'PUT', { maxLogins: 3 }, undefined, admin.jwt)).status).toBe(200);
  });

  it('重置密码立即撤销旧密码和会话，新密码从新额度开始', async () => {
    const f = await fixture();
    const { cookie } = await login(f);
    const next = await createMailboxAccess(env, f.actor, f.box.id, 3);
    expect((await request('/mailbox-access/session', 'GET', undefined, cookie)).status).toBe(401);
    expect((await login(f)).res.status).toBe(401);
    expect((await login(f, next.password)).res.status).toBe(200);
    expect((await mailboxAccessStatus(env, f.actor, f.box.id)).remainingLogins).toBe(2);
  });

  it('所有者禁用/改密、过户、释放和到期都即时失效，过户后转回也不恢复旧凭据', async () => {
    for (const action of ['disable', 'password', 'transfer', 'release', 'expiry']) {
      const f = await fixture();
      const { cookie } = await login(f);
      if (action === 'disable') await db.update(users).set({ status: 'disabled', authVersion: 1 }).where(eq(users.id, f.actor.id));
      if (action === 'password') await db.update(users).set({ authVersion: 1 }).where(eq(users.id, f.actor.id));
      if (action === 'transfer') {
        await db.update(mailboxes).set({ userId: f.actor.id + 100000 }).where(eq(mailboxes.id, f.box.id));
        await db.update(mailboxes).set({ userId: f.actor.id }).where(eq(mailboxes.id, f.box.id));
      }
      if (action === 'release') await db.delete(mailboxes).where(eq(mailboxes.id, f.box.id));
      if (action === 'expiry') await env.db.prepare('UPDATE mailbox_access_sessions SET expires_at = 0 WHERE grant_id IN (SELECT id FROM mailbox_access_grants WHERE mailbox_id = ?)').bind(f.box.id).run();
      expect((await request('/mailbox-access/session', 'GET', undefined, cookie)).status, action).toBe(401);
      if (action !== 'expiry') expect((await login(f)).res.status, action).toBe(401);
    }
  });

  it('退出撤销会话，跨站请求、错邮箱绑定及普通 JWT 无法冒充临时会话', async () => {
    const f = await fixture();
    const { cookie } = await login(f);
    expect((await request('/mailbox-access/session', 'GET', undefined, undefined, f.jwt)).status).toBe(401);
    expect((await request('/mailbox-access/session', 'GET', undefined, cookie, undefined, { 'X-Mailbox-Address': 'other@example.test' })).status).toBe(401);
    expect((await request('/mailbox-access/logout', 'POST', undefined, cookie, undefined, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await request('/mailbox-access/logout', 'POST', undefined, cookie)).status).toBe(200);
    expect((await request('/mailbox-access/session', 'GET', undefined, cookie)).status).toBe(401);
  });

  it('分页仍限制在当前地址，不能利用游标越界', async () => {
    const f = await fixture();
    await env.db.batch(Array.from({ length: 32 }, () => env.db.prepare(
      "INSERT INTO messages(address,direction,domain,status) VALUES (?,'inbound','example.test','received')").bind(f.box.address)));
    const { cookie } = await login(f);
    const first = await (await request('/mailbox-access/messages', 'GET', undefined, cookie)).json() as { data: { items: { id: number }[]; nextBefore: number } };
    expect(first.data.items).toHaveLength(30);
    const second = await (await request(`/mailbox-access/messages?before=${first.data.nextBefore}`, 'GET', undefined, cookie)).json() as { data: { items: { id: number }[] } };
    expect(second.data.items).toHaveLength(2);
  });

  it('登录尝试按 IP 原子限流，不消耗邮箱成功登录额度', async () => {
    const ip = unique();
    await env.db.prepare('DELETE FROM rate_counters WHERE scope = ?').bind('mailbox-login').run();
    const results = await Promise.all(Array.from({ length: 31 }, () => request('/mailbox-access/login', 'POST',
      { email: 'missing@example.test', password: 'incorrect' }, undefined, undefined, { 'CF-Connecting-IP': ip })));
    expect(results.filter((r) => r.status === 429)).toHaveLength(1);
  });
});
