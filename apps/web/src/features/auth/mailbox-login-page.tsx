import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';

export function MailboxLoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      const { mailboxLoginSchema } = await import('@hpc-mail/shared');
      const parsed = mailboxLoginSchema.safeParse({ email, password });
      if (!parsed.success) { setError('请输入完整邮箱地址和临时密码'); return; }
      await api.post('/mailbox-access/login', parsed.data, { token: null });
      setPassword('');
      navigate('/mailbox-inbox', { replace: true });
    } catch (e) { setError(e instanceof Error ? e.message : '登录失败，请重试'); }
    finally { setPending(false); }
  }
  return <main className="grid min-h-dvh place-items-center bg-canvas px-4 py-10">
    <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6 shadow-xs">
      <h1 className="text-xl font-semibold text-ink">邮箱临时登录</h1>
      <p className="mb-6 mt-2 text-sm text-ink-secondary">使用邮箱所有者提供的临时密码，只查看这一邮箱的来信。</p>
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <FormField label="邮箱地址" required>{(field) => <Input {...field} type="email" autoComplete="username"
          value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@relient.fun" required />}</FormField>
        <FormField label="临时密码" required>{(field) => <PasswordInput {...field} autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)} required />}</FormField>
        {error && <p role="alert" className="text-sm text-critical">{error}</p>}
        <Button type="submit" loading={pending} className="w-full">进入这个邮箱</Button>
      </form>
      <p className="mt-4 text-xs text-ink-tertiary">成功登录扣 1 次，刷新不扣；登录后可使用 24 小时。</p>
      <Link to="/login" className="mt-5 block text-center text-sm text-accent">返回账号登录</Link>
    </div>
  </main>;
}
