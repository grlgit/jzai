import { EmailToolProvider } from './email.tools';
import { EmailService } from './email.service';

describe('EmailToolProvider', () => {
  let provider: EmailToolProvider;
  let mockEmailService: Partial<EmailService>;

  beforeAll(() => {
    mockEmailService = {
      getUserAccounts: jest.fn().mockResolvedValue([
        { id: 'acc1', email_address: 'user@test.com', is_default: true },
      ]),
      sendMail: jest.fn().mockResolvedValue({ messageId: '<abc123@test.com>' }),
    };

    provider = new EmailToolProvider(mockEmailService as EmailService);
  });

  it('should have correct toolIds', () => {
    expect(provider.toolIds).toEqual(['email_send']);
  });

  it('should return catalog entries', () => {
    const catalog = provider.getCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toEqual({ id: 'email_send', label: '发送邮件', group: 'email' });
  });

  it('should create tools with piAi.Type', async () => {
    const Type = {
      Object: (schema: any) => ({ type: 'object', properties: schema }),
      String: (opts?: any) => ({ type: 'string', ...opts }),
      Optional: (t: any) => ({ ...t, optional: true }),
      Array: (t: any, opts?: any) => ({ type: 'array', items: t, ...opts }),
    };

    const tools = await provider.createTools({ piAi: { Type }, userId: 'user1' });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('email_send');
  });

  it('should return empty tools without piAi.Type', async () => {
    const tools = await provider.createTools({});
    expect(tools).toHaveLength(0);
  });

  it('should return empty tools without userId', async () => {
    const Type = {
      Object: (s: any) => s, String: (o?: any) => o,
      Optional: (t: any) => t, Array: (t: any) => t,
    };
    const tools = await provider.createTools({ piAi: { Type } });
    expect(tools).toHaveLength(0);
  });

  it('should return empty tools when user has no email accounts', async () => {
    const svc = { ...mockEmailService, getUserAccounts: jest.fn().mockResolvedValue([]) } as any;
    const p = new EmailToolProvider(svc);
    const Type = {
      Object: (s: any) => s, String: (o?: any) => o,
      Optional: (t: any) => t, Array: (t: any) => t,
    };
    const tools = await p.createTools({ piAi: { Type }, userId: 'user1' });
    expect(tools).toHaveLength(0);
  });

  it('should execute email_send via EmailService.sendMail', async () => {
    const Type = {
      Object: (s: any) => s, String: (o?: any) => o,
      Optional: (t: any) => t, Array: (t: any) => t,
    };
    const tools = await provider.createTools({ piAi: { Type }, userId: 'user1' });
    const sendTool = tools[0];

    const result = await sendTool.execute('call-id-1', {
      to: 'recipient@example.com',
      subject: '测试主题',
      body: '邮件正文',
      attachmentFileIds: ['1_abc_report.xlsx'],
    });

    expect(mockEmailService.sendMail).toHaveBeenCalledWith('user1', {
      to: 'recipient@example.com',
      subject: '测试主题',
      body: '邮件正文',
      html: undefined,
      cc: undefined,
      bcc: undefined,
      attachmentFileIds: ['1_abc_report.xlsx'],
    });

    expect(result.content[0].text).toContain('邮件已发送');
    expect(result.content[0].text).toContain('recipient@example.com');
    expect(result.details.messageId).toBe('<abc123@test.com>');
  });

  it('execute 在 sendMail 失败时返回结构化错误', async () => {
    const failSvc = {
      ...mockEmailService,
      sendMail: jest.fn().mockRejectedValue(new Error('SMTP auth failed')),
    } as any;
    const p = new EmailToolProvider(failSvc);
    const Type = {
      Object: (s: any) => s, String: (o?: any) => o,
      Optional: (t: any) => t, Array: (t: any) => t,
    };
    const tools = await p.createTools({ piAi: { Type }, userId: 'user1' });
    const result = await tools[0].execute('call-1', { to: 'a@b.c', subject: 's', body: 'b' });
    expect(result.content[0].text).toContain('[EXECUTION_ERROR]');
    expect(result.details.__error).toBe('EMAIL_SEND_FAILED');
  });

  it('execute receives (_id, args) signature — call id does NOT end up in email fields', async () => {
    const Type = {
      Object: (s: any) => s, String: (o?: any) => o,
      Optional: (t: any) => t, Array: (t: any) => t,
    };
    const tools = await provider.createTools({ piAi: { Type }, userId: 'user1' });
    const sendTool = tools[0];

    await sendTool.execute('some-call-id', { to: 'a@b.c', subject: 's', body: 'b' });

    const call = (mockEmailService.sendMail as jest.Mock).mock.calls.at(-1)!;
    expect(call[1].to).toBe('a@b.c');
    expect(call[1].to).not.toBe('some-call-id');
  });
});
