import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/api/client', () => ({ api: { post: mocks.post } }));
import { MailboxLoginPage } from './mailbox-login-page';
beforeEach(() => vi.clearAllMocks());
function setup() {
  render(<MemoryRouter initialEntries={['/mailbox-login']}><Routes>
    <Route path="/mailbox-login" element={<MailboxLoginPage />} />
    <Route path="/mailbox-inbox" element={<p>限定邮箱收件箱</p>} />
  </Routes></MemoryRouter>);
}
describe('临时登录入口', () => {
  it('使用独立登录接口，不携带主账号令牌，成功后进入限定邮箱', async () => {
    mocks.post.mockResolvedValue({ success: true });
    setup();
    fireEvent.change(screen.getByLabelText(/邮箱地址/), { target: { value: 'guest@example.com' } });
    fireEvent.change(screen.getByLabelText(/临时密码/), { target: { value: 'test-password' } });
    fireEvent.click(screen.getByRole('button', { name: '进入这个邮箱' }));
    await screen.findByText('限定邮箱收件箱');
    expect(mocks.post).toHaveBeenCalledWith('/mailbox-access/login', { email: 'guest@example.com', password: 'test-password' }, { token: null });
  });
  it('次数耗尽时保留登录页并显示错误', async () => {
    mocks.post.mockRejectedValue(new Error('登录次数已用完'));
    setup();
    fireEvent.change(screen.getByLabelText(/邮箱地址/), { target: { value: 'guest@example.com' } });
    fireEvent.change(screen.getByLabelText(/临时密码/), { target: { value: 'test-password' } });
    fireEvent.click(screen.getByRole('button', { name: '进入这个邮箱' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('登录次数已用完'));
    expect(screen.queryByText('限定邮箱收件箱')).not.toBeInTheDocument();
  });
});
