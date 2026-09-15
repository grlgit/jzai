import { Controller, All, Post, Body, Req, Res, Headers, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import * as express from 'express';
import { KbService } from './kb.service';
import { KbAccessService } from './kb-access.service';
import { KbSignatureService, KbSignedHeaders } from './kb-signature.service';
import { UserService } from '../../user/user.service';

@SkipThrottle()
@Controller('api/kb')
export class KbController {
  constructor(
    private readonly kbService: KbService,
    private readonly kbAccess: KbAccessService,
    private readonly signatureService: KbSignatureService,
    private readonly userService: UserService,
  ) {}

  private resolveCaller(auth: string): { userId: string; permissions: string[]; token: string } | null {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return null;
    const user = this.userService.verifyToken(token);
    if (!user) return null;
    return { userId: user.id, permissions: user.role.permissions || [], token };
  }

  private async signForUser(
    method: string, path: string, body: any, userId: string, permissions: string[],
  ): Promise<KbSignedHeaders> {
    const scopes = await this.kbAccess.getAccessibleScopesForUser(userId);
    return this.signatureService.signRequest(method, path, body, userId, scopes);
  }

  /**
   * Manually trigger personal knowledge compilation for the current user.
   */
  @Post('personal-knowledge/compile')
  async compilePersonalKnowledge(@Headers('authorization') auth: string) {
    const caller = this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();

    // Get KB
    const kbPath = '/v1/knowledge-bases';
    const kbHeaders = await this.signForUser('GET', kbPath, undefined, caller.userId, caller.permissions);
    const kbListResult = await this.kbService.proxy('/v1/knowledge-bases', 'GET', undefined, kbHeaders, caller.token);
    const kbs = Array.isArray(kbListResult.data) ? kbListResult.data : [];
    const kb = kbs[0];
    if (!kb) return { success: false, error: '企业心智未初始化' };

    // Get user's raw docs
    const docsPath = `/v1/knowledge-bases/${kb.id}/documents`;
    const docsHeaders = await this.signForUser('GET', docsPath, undefined, caller.userId, caller.permissions);
    const docsResult = await this.kbService.proxy(docsPath, 'GET', undefined, docsHeaders, caller.token);
    const docs = Array.isArray(docsResult.data) ? docsResult.data : [];
    const rawDocs = docs.filter((d: any) =>
      d.path?.includes(`/_personal/${caller.userId}/raw/`) && d.status === 'ready' && d.file_type === 'md',
    );

    if (rawDocs.length === 0) return { success: false, error: '没有待整理的原始资料' };

    await (this.kbService as any).compileUserKnowledge(kb.id, caller.userId, rawDocs);
    return { success: true, message: `已整理 ${rawDocs.length} 篇原始资料` };
  }

  @Post('personal-knowledge')
  async savePersonalKnowledge(
    @Body() body: { content: string; title?: string; tags?: string[] },
    @Headers('authorization') auth: string,
  ) {
    const caller = this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();

    // Get llm_wiki KB id
    const kbPath = '/v1/knowledge-bases';
    const kbHeaders = await this.signForUser('GET', kbPath, undefined, caller.userId, caller.permissions);
    const kbListResult = await this.kbService.proxy('/v1/knowledge-bases', 'GET', undefined, kbHeaders, caller.token);
    const kbs = Array.isArray(kbListResult.data) ? kbListResult.data : [];
    const kb = kbs[0];
    if (!kb) return { success: false, error: '企业心智未初始化' };

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const title = body.title || `知识笔记 ${timestamp.slice(0, 10)}`;
    const tags = body.tags || ['personal'];
    const filename = `${timestamp}.md`;

    const frontmatter = [
      '---',
      `title: ${title}`,
      'description: 个人知识',
      'tags:',
      ...tags.map(t => `  - ${t}`),
      '---',
      '',
    ].join('\n');

    const noteBody = { filename, path: `/wiki/_personal/${caller.userId}/raw/`, content: frontmatter + body.content };
    const notePath = `/v1/knowledge-bases/${kb.id}/documents/note`;
    const noteHeaders = await this.signForUser('POST', notePath, noteBody, caller.userId, caller.permissions);
    const result = await this.kbService.proxy(
      notePath,
      'POST',
      noteBody,
      noteHeaders,
      caller.token,
    );

    return { success: result.status < 400, data: result.data };
  }

  /**
   * Proxy all /api/kb/* requests to the llm_wiki API.
   * Read operations require kb:read, write operations require kb:write.
   * Each forwarded request carries HMAC-signed internal headers that tell
   * llm_wiki the caller's identity and accessible category scopes.
   */
  @All('*')
  async proxy(@Req() req: express.Request, @Res() res: express.Response, @Headers('authorization') auth: string) {
    const caller = this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();

    // Check permissions based on HTTP method
    const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const requiredPerm = isWrite ? 'kb:write' : 'kb:read';
    if (!this.userService.hasPermission(caller.token, requiredPerm as any)) {
      throw new ForbiddenException('权限不足');
    }

    // Build the sub-path: req.originalUrl contains full path, strip /api/kb prefix
    const subPath = req.originalUrl.replace(/^\/api\/kb/, '');
    // Sign using the path only (no query string), matching llm_wiki's middleware
    const signPath = req.path.replace(/^\/api\/kb/, '');

    const signed = await this.signForUser(req.method, signPath, req.body, caller.userId, caller.permissions);
    const result = await this.kbService.proxy(subPath, req.method, req.body, signed, caller.token);

    res.status(result.status);
    if (result.contentType) res.type(result.contentType);
    res.json(result.data);
  }
}
