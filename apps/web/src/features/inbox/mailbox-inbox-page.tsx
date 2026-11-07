import type { MailboxAccessMessageDetail, MailboxAccessMessagePage, MailboxAccessSession } from '@hpc-mail/shared';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/api/client';
import { ApiError } from '@/api/errors';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { EmailHtml, PlainTextBody } from '@/lib/email-html';
import { formatDateTime } from '@/lib/format';

/** Dedicated shell and component-local data: no account sidebar, owner token or persisted query cache. */
export function MailboxInboxPage() {
  const navigate = useNavigate();
  const [session, setSession] = useState<MailboxAccessSession | null>(null);
  const [page, setPage] = useState<MailboxAccessMessagePage | null>(null);
  const [before, setBefore] = useState<number | undefined>();
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<MailboxAccessMessageDetail | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const addressRef = useRef<string | null>(null);

  function failure(e: unknown) {
    if (e instanceof ApiError && e.unauthorized) {
      setSession(null); setPage(null); setDetail(null);
      navigate('/mailbox-login', { replace: true });
    } else setError(e instanceof Error ? e.message : '读取失败，请重试');
  }
  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    let inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      setBusy(true);
      try {
        const next = await api.get<MailboxAccessSession>('/mailbox-access/session', { token: null, signal });
        const result = await api.get<MailboxAccessMessagePage>('/mailbox-access/messages', {
          token: null, signal, headers: { 'X-Mailbox-Address': next.address }, query: { before },
        });
        if (!signal.aborted) {
          if (addressRef.current && addressRef.current !== next.address) { setSelected(null); setDetail(null); }
          addressRef.current = next.address;
          setSession(next);
          setPage(result); setError('');
        }
      } catch (e) { if (!signal.aborted) failure(e); }
      finally { inFlight = false; if (!signal.aborted) setBusy(false); }
    }
    void load();
    const interval = setInterval(() => void load(), 20_000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [before, refresh, navigate]);

  useEffect(() => {
    setDetail(null);
    if (!selected || !session) return;
    const controller = new AbortController();
    api.get<MailboxAccessMessageDetail>(`/mailbox-access/messages/${selected}`, {
      token: null, signal: controller.signal, headers: { 'X-Mailbox-Address': session.address },
    }).then((value) => { if (!controller.signal.aborted) setDetail(value); })
      .catch((e: unknown) => { if (!controller.signal.aborted) failure(e); });
    return () => controller.abort();
  }, [selected, session?.address, refresh, navigate]);

  async function logout() {
    setLoggingOut(true);
    try {
      await api.post('/mailbox-access/logout', undefined, { token: null });
      setSession(null); setPage(null); setDetail(null);
      navigate('/mailbox-login', { replace: true });
    } catch (e) { failure(e); }
    finally { setLoggingOut(false); }
  }
  return <main className="min-h-dvh bg-canvas px-4 py-6 text-ink">
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-5">
        <div className="min-w-0">
          <p className="text-xs text-ink-tertiary">邮箱临时登录 · 只读</p>
          <h1 className="mt-1 break-all text-xl font-semibold">{session?.address ?? '正在读取邮箱…'}</h1>
          {session && <p className="mt-1 text-xs text-ink-secondary">本次登录有效至 {formatDateTime(session.expiresAt)} · 密码还可登录 {session.remainingLogins} 次</p>}
        </div>
        <div className="flex gap-2"><Button variant="secondary" disabled={busy} onClick={() => setRefresh((v) => v + 1)}>刷新</Button>
          <Button variant="secondary" loading={loggingOut} onClick={() => void logout()}>退出邮箱</Button></div>
      </header>
      {error && <p role="alert" className="mb-4 text-sm text-critical">{error}</p>}
      {selected ? <section className="rounded-lg border border-line bg-surface p-4 sm:p-6">
        <Button variant="secondary" size="sm" onClick={() => { setSelected(null); setDetail(null); }}>返回来信列表</Button>
        {!detail ? <p className="mt-6 text-sm text-ink-secondary">正在读取邮件…</p> : <>
          <h2 className="mt-5 break-words text-lg font-semibold">{detail.subject || '（无主题）'}</h2>
          <p className="mb-4 mt-2 break-all text-sm text-ink-secondary">{detail.fromName} &lt;{detail.fromAddress}&gt; · {formatDateTime(detail.createdAt)}</p>
          {detail.verificationCode && <div className="mb-4 flex items-center gap-3 rounded-md bg-canvas p-3"><span>验证码：<b>{detail.verificationCode}</b></span>
            <CopyButton value={detail.verificationCode} label="复制验证码" size="sm" /></div>}
          {detail.bodyHtml ? <EmailHtml html={detail.bodyHtml} allowRemoteImages={false} /> : <PlainTextBody text={detail.bodyText || '（无正文）'} />}
          <div className="mt-6 flex flex-wrap gap-4 text-sm text-accent">
            {detail.attachments.map((a) => <a key={a.id} href={a.url} download className="underline">{a.filename}</a>)}
            {detail.hasRaw && <a href={`/api/mailbox-access/messages/${detail.id}/raw`} download className="underline">下载原始邮件</a>}
          </div>
        </>}
      </section> : <section aria-label="这个邮箱的来信" className="overflow-hidden rounded-lg border border-line bg-surface">
        {!page ? <p className="p-6 text-sm text-ink-secondary">正在加载来信…</p>
          : !page.items.length ? <p className="p-8 text-center text-sm text-ink-secondary">暂无来信，每 20 秒自动刷新。</p>
          : <ul className="divide-y divide-line">{page.items.map((mail) => <li key={mail.id}>
            <button className="block w-full px-5 py-4 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => setSelected(mail.id)}>
              <div className="flex flex-wrap justify-between gap-2 text-xs text-ink-secondary"><span>{mail.fromName || mail.fromAddress}</span><time>{formatDateTime(mail.createdAt)}</time></div>
              <p className="mt-2 truncate font-medium">{mail.subject || '（无主题）'}</p><p className="mt-1 truncate text-sm text-ink-tertiary">{mail.preview}</p>
            </button>
          </li>)}</ul>}
        <div className="flex gap-3 border-t border-line p-4">
          {before && <Button variant="secondary" size="sm" onClick={() => { setPage(null); setBefore(undefined); }}>最新来信</Button>}
          {page?.nextBefore && <Button variant="secondary" size="sm" onClick={() => { setBefore(page.nextBefore!); setPage(null); }}>更早的来信</Button>}
        </div>
      </section>}
    </div>
  </main>;
}
