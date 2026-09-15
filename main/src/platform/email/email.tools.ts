import { Injectable, Logger } from '@nestjs/common';
import { ToolProvider, ToolContext, ToolCatalogEntry, ToolInstance } from '../../agent/tool-bridge/tool-provider.interface';
import { EmailService } from './email.service';

@Injectable()
export class EmailToolProvider implements ToolProvider {
  private readonly logger = new Logger(EmailToolProvider.name);
  readonly toolIds = ['email_send'];

  constructor(private readonly emailService: EmailService) {}

  getCatalog(): ToolCatalogEntry[] {
    return [
      { id: 'email_send', label: '发送邮件', group: 'email' },
    ];
  }

  async createTools(ctx: ToolContext): Promise<ToolInstance[]> {
    const userId = ctx.userId;
    if (!userId) {
      this.logger.warn('EmailToolProvider: No userId in context');
      return [];
    }

    const accounts = await this.emailService.getUserAccounts(userId);
    const defaultAccount = accounts.find((a: any) => a.is_default) || accounts[0];
    if (!defaultAccount) {
      this.logger.warn(`EmailToolProvider: No email account for user ${userId}`);
      return [];
    }

    const Type = ctx.piAi?.Type;
    if (!Type) return [];

    return [{
      name: 'email_send',
      label: '发送邮件',
      description: `通过 SMTP 发送邮件（使用账号 ${defaultAccount.email_address}）。可附带导出文件作为附件。`,
      parameters: Type.Object({
        to: Type.String({ description: '收件人邮箱地址（多个用逗号分隔）' }),
        subject: Type.String({ description: '邮件主题' }),
        body: Type.String({ description: '邮件正文（纯文本）' }),
        html: Type.Optional(Type.String({ description: 'HTML 正文（可选，有值时优先展示）' })),
        cc: Type.Optional(Type.String({ description: '抄送地址（可选）' })),
        bcc: Type.Optional(Type.String({ description: '密送地址（可选）' })),
        attachmentFileIds: Type.Optional(Type.Array(Type.String(), { description: '附件文件 ID 列表（从 export_excel / generate_pdf 等工具的 fileId 获取）' })),
      }),
      execute: async (_id: string, args: any) => {
        try {
          const result = await this.emailService.sendMail(userId, {
            to: args.to,
            subject: args.subject,
            body: args.body,
            html: args.html,
            cc: args.cc,
            bcc: args.bcc,
            attachmentFileIds: args.attachmentFileIds,
          });

          return {
            content: [{ type: 'text' as const, text: `邮件已发送: ${args.subject} → ${args.to}\nMessage-ID: ${result.messageId}` }],
            details: { messageId: result.messageId },
          };
        } catch (err: any) {
          this.logger.error(`邮件发送失败: ${err.message}`);
          return {
            content: [{ type: 'text' as const, text: `[EXECUTION_ERROR] 邮件发送失败: ${err.message}` }],
            details: { __error: 'EMAIL_SEND_FAILED', message: err.message },
          };
        }
      },
    }];
  }
}
