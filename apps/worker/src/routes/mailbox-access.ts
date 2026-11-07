import { mailboxAccessListSchema, mailboxLoginSchema, type MailboxAccessMessage, type MailboxAccessMessageDetail, type MailboxAccessMessagePage } from '@hpc-mail/shared';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createDb } from '../db/client.js';
import { attachments, messages } from '../db/schema.js';
import { buildSecureHeaders } from '../lib/attachment-security.js';
import { AppError } from '../lib/errors.js';
import { clientIp, ok, parseBody, parseId, parseQuery } from '../lib/http.js';
import { loginMailbox, logoutMailbox, mailboxSession, MAILBOX_SESSION_SECONDS } from '../services/mailbox-access.js';
import { getJson } from '../services/storage.js';
import type { AppContext, Env } from '../types.js';

const app = new Hono<AppContext>();
const COOKIE = '__Secure-hpc_mailbox';
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'Strict' as const, path: '/api/mailbox-access' };
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  const origin = c.req.header('Origin');
  if (c.req.header('Sec-Fetch-Site') === 'cross-site' || (origin && origin !== new URL(c.req.url).origin)) {
    throw new AppError('forbidden', '请从本站操作邮箱临时登录');
  }
  await next();
});

app.post('/login', async (c) => {
  const req = await parseBody(c, mailboxLoginSchema);
  const { token } = await loginMailbox(c.env, req.email, req.password, clientIp(c), getCookie(c, COOKIE));
  setCookie(c, COOKIE, token, { ...cookieOptions, maxAge: MAILBOX_SESSION_SECONDS });
  return ok(c, { success: true });
});
app.post('/logout', async (c) => {
  await logoutMailbox(c.env, getCookie(c, COOKIE));
  deleteCookie(c, COOKIE, cookieOptions);
  return ok(c, { success: true });
});

// Never populate the ordinary user context or accept its JWT here. All remaining
// routes are an explicit read-only allowlist, scoped by a server-side mailbox.
app.use('*', async (c, next) => {
  const session = await mailboxSession(c.env, getCookie(c, COOKIE));
  if (c.req.header('X-Mailbox-Address') && c.req.header('X-Mailbox-Address') !== session.address) {
    throw new AppError('unauthorized', '当前邮箱已变化，请重新登录');
  }
  c.set('mailboxSession', session);
  await next();
});
app.get('/session', (c) => ok(c, c.get('mailboxSession')));

const summaryColumns = {
  id: messages.id, address: messages.address, subject: messages.subject,
  fromAddress: messages.fromAddress, fromName: messages.fromName,
  preview: messages.preview, verificationCode: messages.verificationCode, createdAt: messages.createdAt,
};
const visible = (address: string) => and(eq(messages.address, address), eq(messages.direction, 'inbound'), isNull(messages.deletedAt));
function summary(row: { createdAt: Date } & Omit<MailboxAccessMessage, 'createdAt'>): MailboxAccessMessage {
  return { ...row, createdAt: row.createdAt.toISOString() };
}
async function loadMessage(env: Env, address: string, id: number) {
  const row = await createDb(env).select().from(messages).where(and(eq(messages.id, id), visible(address))).get();
  if (!row) throw new AppError('not_found', '邮件不存在');
  return row;
}

app.get('/messages', async (c) => {
  const { before } = parseQuery(c, mailboxAccessListSchema);
  const rows = await createDb(c.env).select(summaryColumns).from(messages)
    .where(and(visible(c.get('mailboxSession')!.address), before ? lt(messages.id, before) : undefined))
    .orderBy(desc(messages.id)).limit(31).all();
  const items = rows.slice(0, 30).map(summary);
  const result: MailboxAccessMessagePage = { items, nextBefore: rows.length > 30 ? items.at(-1)!.id : null };
  return ok(c, result);
});

app.get('/messages/:id', async (c) => {
  const row = await loadMessage(c.env, c.get('mailboxSession')!.address, parseId(c.req.param('id')));
  const [full, attRows] = await Promise.all([
    row.bodyR2Key ? getJson<{ text?: string; html?: string }>(c.env, row.bodyR2Key) : null,
    createDb(c.env).select().from(attachments).where(eq(attachments.messageId, row.id)).all(),
  ]);
  let bodyHtml = full?.html ?? row.bodyHtml;
  const metas = attRows.map((a) => {
    const url = `/api/mailbox-access/attachments/${a.id}`;
    if (a.contentId) bodyHtml = bodyHtml.replace(new RegExp(`cid:${a.contentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi'), url);
    return { id: a.id, filename: a.filename, size: a.size, url };
  });
  // Pick fields explicitly: never return R2 keys, owner/notification ids or unrelated account data.
  const detail: MailboxAccessMessageDetail = {
    id: row.id, address: row.address, subject: row.subject, fromAddress: row.fromAddress,
    fromName: row.fromName, preview: row.preview, verificationCode: row.verificationCode,
    createdAt: row.createdAt.toISOString(), bodyText: full?.text ?? row.bodyText,
    bodyHtml, hasRaw: !!row.rawR2Key, attachments: metas,
  };
  return ok(c, detail);
});

app.get('/messages/:id/raw', async (c) => {
  const row = await loadMessage(c.env, c.get('mailboxSession')!.address, parseId(c.req.param('id')));
  const obj = row.rawR2Key ? await c.env.r2.get(row.rawR2Key) : null;
  if (!obj) throw new AppError('not_found', '该邮件无原始存档');
  return new Response(obj.body, { headers: buildSecureHeaders('message/rfc822', `message-${row.id}.eml`) });
});

app.get('/attachments/:id', async (c) => {
  const row = await createDb(c.env).select({ attachment: attachments }).from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(and(eq(attachments.id, parseId(c.req.param('id'))), visible(c.get('mailboxSession')!.address))).get();
  const obj = row ? await c.env.r2.get(row.attachment.r2Key) : null;
  if (!row || !obj) throw new AppError('not_found', '附件不存在');
  return new Response(obj.body, { headers: buildSecureHeaders(row.attachment.mimeType, row.attachment.filename) });
});

export default app;
