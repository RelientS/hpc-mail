import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/api/client', () => ({ api: mocks }));
import { TemporaryAccessDialog } from './temporary-access-dialog';
const status = { enabled: false, maxLogins: 0, usedLogins: 0, remainingLogins: 0 };
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><TemporaryAccessDialog mailbox={{ id: 7, address: 'guest@example.com' }} onClose={() => {}} /></QueryClientProvider>);
  return client;
}
beforeEach(() => { vi.clearAllMocks(); mocks.get.mockResolvedValue(status); });
describe('临时密码管理', () => {
  it('提交选择次数，明文只在弹窗显示且不进入查询缓存', async () => {
    mocks.put.mockResolvedValue({ enabled: true, password: 'test-only-password', maxLogins: 3, usedLogins: 0, remainingLogins: 3 });
    const client = setup();
    await screen.findByText('尚未启用临时登录');
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '生成临时密码' }));
    await screen.findByText('test-only-password');
    expect(mocks.put).toHaveBeenCalledWith('/mailboxes/7/temp-access', { maxLogins: 3 });
    expect(JSON.stringify(client.getQueryData(['mailbox-temp-access', 7]))).not.toContain('test-only-password');
    client.clear();
  });
  it('拒绝超范围次数，可撤销已有授权', async () => {
    mocks.get.mockResolvedValue({ enabled: true, maxLogins: 3, usedLogins: 1, remainingLogins: 2 });
    mocks.delete.mockResolvedValue({ success: true });
    const client = setup();
    await screen.findByText('已使用 1 / 3 次，剩余 2 次');
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '101' } });
    fireEvent.click(screen.getByRole('button', { name: '重新生成密码' }));
    await screen.findByRole('alert');
    expect(mocks.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '撤销临时登录' }));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('/mailboxes/7/temp-access'));
    client.clear();
  });
});
