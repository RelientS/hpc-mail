import type { CreatedMailboxAccess, MailboxAccessStatus } from '@hpc-mail/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';

export function TemporaryAccessDialog({ mailbox, onClose }: {
  mailbox: { id: number; address: string }; onClose: () => void;
}) {
  const path = `/mailboxes/${mailbox.id}/temp-access`;
  const status = useQuery({ queryKey: ['mailbox-temp-access', mailbox.id], queryFn: () => api.get<MailboxAccessStatus>(path), staleTime: 0, gcTime: 0 });
  const [maxLogins, setMaxLogins] = useState('1');
  const [password, setPassword] = useState('');
  const [issuedLogins, setIssuedLogins] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loginUrl = `${window.location.origin}/mailbox-login`;
  async function change(revoke = false) {
    const count = Number(maxLogins);
    if (!revoke && (!Number.isInteger(count) || count < 1 || count > 100)) {
      setError('登录次数请输入 1～100 之间的整数');
      return;
    }
    setBusy(true);
    setError('');
    setPassword('');
    try {
      if (revoke) await api.delete(path);
      else {
        const result = await api.put<CreatedMailboxAccess>(path, { maxLogins: count });
        setPassword(result.password);
        setIssuedLogins(result.maxLogins);
      }
      await status.refetch();
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败，请重试'); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
    <DialogContent className="max-w-md">
      <DialogHeader title="邮箱临时登录" description={mailbox.address} />
      <DialogBody className="space-y-4">
        <p className="text-sm text-ink-secondary">使用邮箱地址和临时密码，只能查看这个邮箱的历史与新来信、验证码和附件。不能发信、删除邮件或访问账号设置。</p>
        {status.isPending ? <p>正在读取设置…</p> : status.isError ? <p role="alert">读取设置失败，请重新打开。</p>
          : <p className="text-sm text-ink-secondary">{status.data.enabled
            ? `已使用 ${status.data.usedLogins} / ${status.data.maxLogins} 次，剩余 ${status.data.remainingLogins} 次`
            : '尚未启用临时登录'}</p>}
        <FormField label="允许登录次数" required>{(field) => <Input {...field} type="number" min={1} max={100} step={1}
          value={maxLogins} onChange={(e) => setMaxLogins(e.target.value)} />}</FormField>
        <p className="text-xs text-ink-tertiary">成功登录扣 1 次，刷新不扣；每次会话有效 24 小时。重新生成或撤销后，旧密码和已登录会话立即失效。</p>
        {password && <div className="space-y-3 rounded-lg border border-line bg-canvas p-3">
          <p className="text-sm font-medium">临时密码（只显示这一次）</p>
          <code className="block break-all select-all text-ink">{password}</code>
          <CopyButton label="复制登录信息" value={`登录地址：${loginUrl}\n邮箱：${mailbox.address}\n临时密码：${password}\n允许登录 ${issuedLogins} 次`} />
        </div>}
        <a href={loginUrl} target="_blank" rel="noreferrer" className="text-sm text-accent underline">打开邮箱临时登录页</a>
        {error && <p role="alert" className="text-sm text-critical">{error}</p>}
      </DialogBody>
      <DialogFooter>
        {status.data?.enabled && <Button variant="danger" disabled={busy} onClick={() => void change(true)}>撤销临时登录</Button>}
        <Button disabled={busy || status.isPending || status.isError} loading={busy} onClick={() => void change()}>
          {status.data?.enabled ? '重新生成密码' : '生成临时密码'}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
