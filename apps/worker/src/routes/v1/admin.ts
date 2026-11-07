import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  listMessagesQuerySchema,
  messageViewQuerySchema,
  searchUsersQuerySchema,
} from '@hpc-mail/shared';
import { Hono, type MiddlewareHandler } from 'hono';
import { AppError } from '../../lib/errors.js';
import { execCtx, ok, parseId, parseQuery } from '../../lib/http.js';
import { apiKeyAuth, requireScope } from '../../middleware/api-key-auth.js';
import { listAdminAuditLogs, logAdminAction } from '../../services/audit.js';
import { getDomainClaudeStats } from '../../services/claim-plan.js';
import { getMailbox, listMailboxes } from '../../services/mailbox.js';
import { listMailboxShares } from '../../services/mailbox-share.js';
import { getMessageDetail, listMessages, type Viewer } from '../../services/message.js';
import { listUsers, searchUsers } from '../../services/user.js';
import type { AppContext } from '../../types.js';

/**
 * /v1/admin：管理员 API Key 的只读管理接口。
 * 需要 Key 带 admin.read 且所属用户此刻仍是管理员；只开放 GET，写操作仍只走 JWT 的 /api/admin。
 * 每次通过校验的调用（含业务报错）都写一条管理审计 api_key.admin_read。
 */
const AUDIT_QUERY_MAX = 300;

const adminReadGuard: MiddlewareHandler<AppContext> = async (c, next) => {
  requireScope(c, 'admin.read');
  const key = c.get('apiKey')!;
  let status = 500;
  try {
    await next();
    status = c.res.status;
  } catch (error) {
    status = error instanceof AppError ? error.status : 500;
    throw error;
  } finally {
    const search = new URL(c.req.url).search;
    const detail = `key #${key.id} · ${status}${search ? ` · ${search.slice(0, AUDIT_QUERY_MAX)}` : ''}`;
    const audit = logAdminAction(c.env, { id: key.userId, username: key.username }, 'api_key.admin_read',
      `${c.req.method} ${c.req.path}`, detail, c.get('apiClientIp') ?? '');
    const ctx = execCtx(c);
    if (ctx) ctx.waitUntil(audit);
    else await audit;
  }
};

const app = new Hono<AppContext>();
app.use('*', apiKeyAuth, adminReadGuard);

function adminViewer(key: { userId: number }, query: { scope?: Viewer['scope']; userId?: number }): Viewer {
  if (query.scope !== 'unclaimed' && query.scope !== 'user') {
    throw new AppError('validation_failed', '需要 scope=unclaimed，或 scope=user 加 userId');
  }
  return { userId: key.userId, role: 'admin', scope: query.scope, targetUserId: query.userId };
}

/** 全站用户（与 /api/admin/users 同一返回） */
app.get('/users', async (c) => ok(c, await listUsers(c.env)));
app.get('/users/search', async (c) => ok(c, await searchUsers(c.env, parseQuery(c, searchUsersQuerySchema))));

/** 全站已认领邮箱（等同 /v1/mailboxes?all=1） */
app.get('/mailboxes', async (c) => ok(c, await listMailboxes(c.env, { all: true })));
app.get('/mailboxes/:id', async (c) => ok(c, await getMailbox(c.env, parseId(c.req.param('id')))));

/** 全站邮箱共享名单；?mailboxId= 只看一个 */
app.get('/mailbox-shares', async (c) => {
  const raw = c.req.query('mailboxId');
  const mailboxId = raw === undefined ? undefined : Number(raw);
  if (raw !== undefined && !(/^[1-9]\d*$/.test(raw) && Number.isSafeInteger(mailboxId))) {
    throw new AppError('validation_failed', 'mailboxId 需为正整数');
  }
  return ok(c, await listMailboxShares(c.env, c.get('apiKey')!.userId, true, mailboxId));
});

/** 未认领邮件（scope=unclaimed）或只读审阅指定用户（scope=user&userId=） */
app.get('/messages', async (c) => {
  const query = parseQuery(c, listMessagesQuerySchema);
  return ok(c, await listMessages(c.env, adminViewer(c.get('apiKey')!, query), query));
});
app.get('/messages/:id', async (c) => {
  const viewer = adminViewer(c.get('apiKey')!, parseQuery(c, messageViewQuerySchema));
  return ok(c, await getMessageDetail(c.env, viewer, parseId(c.req.param('id'))));
});

/** 每个系统域名的 Claude 账号/封号统计（与 /api/admin/settings/domain-claude-stats 同一返回） */
app.get('/domain-stats', async (c) => ok(c, await getDomainClaudeStats(c.env)));

/** 管理审计（含本接口自己的 api_key.admin_read 记录） */
app.get('/audit-logs', async (c) => {
  const limitRaw = Number(c.req.query('limit'));
  const limit = Number.isInteger(limitRaw) ? Math.min(MAX_PAGE_SIZE, Math.max(1, limitRaw)) : DEFAULT_PAGE_SIZE;
  return ok(c, await listAdminAuditLogs(c.env, c.req.query('cursor'), limit));
});

export default app;
