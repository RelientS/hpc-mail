import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { mailboxes, messages, users } from '../src/db/schema.js';
import { handleInbound } from '../src/services/inbound.js';
import { getUserNotifyPrefs, updateUserNotifyPrefs } from '../src/services/notify-prefs.js';
import { updateSettings } from '../src/services/setting.js';

async function setup() {
  const id = crypto.randomUUID();
  const [user] = await createDb(env).insert(users).values({ username: id, passwordHash: 'x', role: 'user' }).returning();
  const source = `source-${id}@example.com`, other = `other-${id}@example.com`;
  await createDb(env).insert(mailboxes).values([source, other].map(address => ({ address, domain: 'example.com', userId: user!.id })));
  await updateSettings(env, { code_extract: { enabled: true, aiEnabled: false } });
  return { userId: user!.id, source, other };
}

async function incoming(to: string) {
  const forward = vi.fn(async (_target: string) => {});
  const raw = ['From: sender@example.net', `To: ${to}`, 'Subject: scope-test',
    `Message-ID: <${crypto.randomUUID()}@example.net>`, 'Content-Type: text/plain; charset=utf-8', '', 'scope test'].join('\r\n');
  const ctx = createExecutionContext();
  await handleInbound({ to, from: 'sender@example.net', headers: new Headers(), raw: new Response(raw).body!,
    forward, setReject: vi.fn() } as unknown as ForwardableEmailMessage, env, ctx);
  await waitOnExecutionContext(ctx);
  return forward;
}

describe('forwarding source scope', () => {
  it('forwards one address to both targets, retains its mail, and excludes the same owner’s other address', async () => {
    const { userId, source, other } = await setup();
    await updateUserNotifyPrefs(env, userId, { forward: { enabled: true, addresses: ['first@example.net', 'second@example.net'], sourceAddresses: [source] } });
    const sent = await incoming(source);
    expect(sent.mock.calls.map(call => call[0])).toEqual(['first@example.net', 'second@example.net']);
    expect((await incoming(other)).mock.calls).toHaveLength(0);
    const stored = await createDb(env).select().from(messages).where(eq(messages.address, source)).get();
    expect(stored?.bodyText).toContain('scope test');
    expect(stored?.rawR2Key).toBeTruthy();
  });

  it('keeps the source scope when older clients omit it; explicit [] clears it', async () => {
    const { userId, source, other } = await setup();
    await updateUserNotifyPrefs(env, userId, { forward: { enabled: true, addresses: ['first@example.net'], sourceAddresses: [source] } });
    await updateUserNotifyPrefs(env, userId, { forward: { enabled: true, addresses: ['second@example.net'] } });
    expect((await getUserNotifyPrefs(env, userId)).forward.sourceAddresses).toEqual([source]);
    expect((await incoming(other)).mock.calls).toHaveLength(0);
    await updateUserNotifyPrefs(env, userId, { forward: { enabled: true, addresses: ['second@example.net'], sourceAddresses: [] } });
    expect(await incoming(other)).toHaveBeenCalledWith('second@example.net');
  });

  it('stops applying the old owner’s rule after transfer and respects the off switch', async () => {
    const { userId, source } = await setup();
    await updateUserNotifyPrefs(env, userId, { forward: { enabled: false, addresses: ['first@example.net'], sourceAddresses: [source] } });
    expect((await incoming(source)).mock.calls).toHaveLength(0);
    await updateUserNotifyPrefs(env, userId, { forward: { enabled: true, addresses: ['first@example.net'], sourceAddresses: [source] } });
    const next = await setup();
    await createDb(env).update(mailboxes).set({ userId: next.userId }).where(eq(mailboxes.address, source));
    expect((await incoming(source)).mock.calls).toHaveLength(0);
  });
});
