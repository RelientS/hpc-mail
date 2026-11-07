import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/api/client', () => ({ api: mocks }));
import { ApiError } from '@/api/errors';
import { MailboxInboxPage } from './mailbox-inbox-page';
const mail = { id: 42, address: 'guest@example.com', subject: '测试来信', fromAddress: 'sender@example.org', fromName: '',
  preview: 'hello', createdAt: '2026-10-30T00:00:00Z', verificationCode: '123456' };
function setup() {
  render(<MemoryRouter initialEntries={['/mailbox-inbox']}><Routes>
    <Route path="/mailbox-inbox" element={<MailboxInboxPage />} />
    <Route path="/mailbox-login" element={<p>返回临时登录</p>} />
  </Routes></MemoryRouter>);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (path: string) => {
    if (path.endsWith('/session')) return { address: mail.address, displayName: '', expiresAt: '2026-10-31T00:00:00Z', remainingLogins: 0 };
    if (path.endsWith('/messages')) return { items: [mail], nextBefore: null };
    return { ...mail, bodyText: '只属于这个邮箱的正文', bodyHtml: '', attachments: [], hasRaw: false };
  });
  mocks.post.mockResolvedValue({ success: true });
});
describe('独立的只读邮箱页面', () => {
  it('只展示对应邮箱，读详情不调用主账号接口或修改已读状态', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /测试来信/ }));
    await screen.findByText('只属于这个邮箱的正文');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(mail.address);
    expect(screen.queryByText('全站地址')).not.toBeInTheDocument();
    expect(screen.queryByText('个人设置')).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
    for (const [path, options] of mocks.get.mock.calls) {
      expect(path).toMatch(/^\/mailbox-access\//);
      expect(options.token).toBeNull();
    }
    expect(mocks.get).toHaveBeenCalledWith('/mailbox-access/messages/42', expect.objectContaining({ headers: { 'X-Mailbox-Address': mail.address } }));
    fireEvent.click(screen.getByRole('button', { name: '退出邮箱' }));
    await screen.findByText('返回临时登录');
    expect(screen.queryByText('只属于这个邮箱的正文')).not.toBeInTheDocument();
  });
  it('撤销或到期返回临时登录，不保留邮件内容', async () => {
    setup();
    await screen.findByText('测试来信');
    mocks.get.mockRejectedValue(new ApiError('临时登录已失效', { code: 'unauthorized', httpStatus: 401 }));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(screen.getByText('返回临时登录')).toBeInTheDocument());
    expect(screen.queryByText('测试来信')).not.toBeInTheDocument();
  });
});
