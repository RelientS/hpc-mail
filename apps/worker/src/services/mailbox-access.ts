import type { CreatedMailboxAccess, MailboxAccessSession, MailboxAccessStatus } from '@hpc-mail/shared';
import { sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { genRandomPassword, hashPassword, verifyPassword } from '../lib/password.js';
import type { AuthUser, Env } from '../types.js';
import { bumpCounter, minuteWindow } from './rate-counter.js';

export const MAILBOX_SESSION_SECONDS = 24 * 60 * 60;
const liveGrant = `FROM mailbox_access_grants g
  JOIN mailboxes m ON m.id = g.mailbox_id AND m.user_id = g.owner_id
  JOIN users u ON u.id = g.owner_id AND u.status = 'active' AND u.auth_version = g.owner_auth_version`;

async function managedMailbox(env: Env, actor: AuthUser, id: number) {
  const box = await env.db.prepare(`SELECT m.id, m.user_id AS ownerId, u.auth_version AS version
    FROM mailboxes m JOIN users u ON u.id = m.user_id
    WHERE m.id = ? AND (m.user_id = ? OR ?) AND u.status = 'active'`)
    .bind(id, actor.id, actor.role === 'admin' ? 1 : 0).first<{ id: number; ownerId: number; version: number }>();
  if (!box) throw new AppError('forbidden', '只能管理自己拥有的邮箱，管理员可管理全站邮箱');
  return box;
}

export async function mailboxAccessStatus(env: Env, actor: AuthUser, id: number): Promise<MailboxAccessStatus> {
  await managedMailbox(env, actor, id);
  const row = await env.db.prepare(`SELECT g.max_logins AS maxLogins, g.used_logins AS usedLogins ${liveGrant} WHERE m.id = ?`)
    .bind(id).first<{ maxLogins: number; usedLogins: number }>();
  return row ? { enabled: true, ...row, remainingLogins: row.maxLogins - row.usedLogins }
    : { enabled: false, maxLogins: 0, usedLogins: 0, remainingLogins: 0 };
}

export async function createMailboxAccess(env: Env, actor: AuthUser, id: number, maxLogins: number): Promise<CreatedMailboxAccess> {
  const box = await managedMailbox(env, actor, id);
  const password = genRandomPassword(20);
  const passwordHash = await hashPassword(password);
  // Delete + create in one transaction. A reset also deletes all old sessions via FK.
  const guard = `EXISTS (SELECT 1 FROM mailboxes m JOIN users u ON u.id = m.user_id
    WHERE m.id = ? AND m.user_id = ? AND u.status = 'active' AND u.auth_version = ?)`;
  const results = await env.db.batch([
    env.db.prepare(`DELETE FROM mailbox_access_grants WHERE mailbox_id = ? AND ${guard}`)
      .bind(id, id, box.ownerId, box.version),
    env.db.prepare(`INSERT INTO mailbox_access_grants
      (id, mailbox_id, owner_id, owner_auth_version, password_hash, max_logins)
      SELECT ?, ?, ?, ?, ?, ? WHERE ${guard} RETURNING id`)
      .bind(crypto.randomUUID(), id, box.ownerId, box.version, passwordHash, maxLogins, id, box.ownerId, box.version),
  ]);
  if (!results[1]?.results.length) throw new AppError('conflict', '邮箱所有者已改变，请刷新后重试');
  return { enabled: true, password, maxLogins, usedLogins: 0, remainingLogins: maxLogins };
}

export async function revokeMailboxAccess(env: Env, actor: AuthUser, id: number): Promise<void> {
  const box = await managedMailbox(env, actor, id);
  await env.db.prepare(`DELETE FROM mailbox_access_grants WHERE mailbox_id = ? AND owner_id = ?`).bind(id, box.ownerId).run();
}

export async function loginMailbox(env: Env, email: string, password: string, ip: string, previousToken?: string) {
  // Count every attempt atomically before password hashing; avoid a parallel guessing bypass.
  const counter = await bumpCounter(env, 'mailbox-login', await sha256Hex(ip), minuteWindow(15));
  if (counter.count > 30) throw new AppError('rate_limited', '登录尝试过于频繁，请稍后再试');
  const grant = await env.db.prepare(`SELECT g.id, g.password_hash AS passwordHash ${liveGrant}
    WHERE m.address = ? AND g.used_logins < g.max_logins`).bind(email)
    .first<{ id: string; passwordHash: string }>();
  // Keep the expensive check on misses too; don't expose mailbox/grant existence by timing.
  const valid = grant ? await verifyPassword(password, grant.passwordHash) : (await hashPassword(password), false);
  if (!grant || !valid) throw new AppError('bad_credentials', '邮箱或临时密码无效，或登录次数已用完');
  const token = genRandomPassword(48);
  const tokenHash = await sha256Hex(token);
  const expiresAt = Date.now() + MAILBOX_SESSION_SECONDS * 1000;
  // The INSERT and its quota trigger are one SQLite statement/transaction. Concurrent
  // requests cannot share the last use; failed inserts never consume an allowance.
  const insert = env.db.prepare(`INSERT INTO mailbox_access_sessions (token_hash, grant_id, expires_at)
    SELECT ?, g.id, ? ${liveGrant} WHERE g.id = ? AND g.password_hash = ? AND g.used_logins < g.max_logins
    RETURNING token_hash`).bind(tokenHash, expiresAt, grant.id, grant.passwordHash);
  const results = await env.db.batch([
    insert,
    env.db.prepare(`DELETE FROM mailbox_access_sessions WHERE token_hash = ?
      AND EXISTS (SELECT 1 FROM mailbox_access_sessions WHERE token_hash = ?)`)
      .bind(previousToken ? await sha256Hex(previousToken) : '', tokenHash),
  ]);
  if (!results[0]?.results.length) throw new AppError('bad_credentials', '邮箱或临时密码无效，或登录次数已用完');
  return { token };
}

export async function mailboxSession(env: Env, token: string | undefined): Promise<MailboxAccessSession> {
  if (!token || !/^[A-Za-z0-9]{48}$/.test(token)) throw new AppError('unauthorized', '请使用邮箱和临时密码登录');
  const row = await env.db.prepare(`SELECT m.address, m.display_name AS displayName,
    s.expires_at AS expiresAt, g.max_logins - g.used_logins AS remainingLogins
    ${liveGrant} JOIN mailbox_access_sessions s ON s.grant_id = g.id
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await sha256Hex(token), Date.now())
    .first<{ address: string; displayName: string; expiresAt: number; remainingLogins: number }>();
  if (!row) throw new AppError('unauthorized', '临时登录已失效，请重新登录');
  return { ...row, expiresAt: new Date(row.expiresAt).toISOString() };
}

export async function logoutMailbox(env: Env, token: string | undefined): Promise<void> {
  if (token) await env.db.prepare('DELETE FROM mailbox_access_sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}
