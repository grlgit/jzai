import { Injectable, Logger } from '@nestjs/common';
import { KbSignatureService } from './kb-signature.service';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @deprecated T0 重构：kbs 服务已并入主台（见 src/knowledge/）。
 * 本类仅为 distill（专家蒸馏，将来重组到专用 APP）保留编译兼容的 proxy 存根；
 * 知识库能力请使用 src/knowledge/ 下的服务。定时编译已废弃（U3），proxy 目标
 * 服务（kbs:8000）已不再部署，distill 运行时调用将失败——预期行为。
 */
@Injectable()
export class KbService {
  private readonly logger = new Logger(KbService.name);

  constructor(
    private readonly signatureService: KbSignatureService,
  ) {}

  getConfig(): { apiEndpoint: string; mcpEndpoint: string; slug: string } {
    try {
      const cfgPath = path.join(process.cwd(), 'config', 'system.json');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      return {
        apiEndpoint: cfg.knowledgeBase?.apiEndpoint || 'http://localhost:8000',
        mcpEndpoint: cfg.knowledgeBase?.mcpEndpoint || 'http://localhost:3011',
        slug: cfg.knowledgeBase?.slug || 'default',
      };
    } catch {
      return { apiEndpoint: 'http://localhost:8000', mcpEndpoint: 'http://localhost:3011', slug: 'default' };
    }
  }

  /**
   * @deprecated kbs 已并入主台；此代理保留仅为 distill 编译兼容。
   */
  async proxy(
    subPath: string, method: string, body?: any,
    headers?: Record<string, string>, authToken?: string,
  ): Promise<{ status: number; data: any; contentType?: string }> {
    const { apiEndpoint } = this.getConfig();
    const url = `${apiEndpoint}${subPath}`;

    try {
      const fetchHeaders: Record<string, string> = { ...headers };
      if (body && typeof body === 'object' && !(body instanceof Buffer)) {
        fetchHeaders['Content-Type'] = 'application/json';
      }
      if (authToken && !fetchHeaders['Authorization']) {
        fetchHeaders['Authorization'] = `Bearer ${authToken}`;
      }
      if (!fetchHeaders['Authorization'] && !fetchHeaders['X-JZ-Signature']) {
        const signPath = subPath.split('?')[0];
        const signed = this.signatureService.signInternalRequest(method, signPath, body);
        Object.assign(fetchHeaders, signed);
      }

      const resp = await fetch(url, {
        method,
        headers: fetchHeaders,
        body: body ? (typeof body === 'string' || body instanceof Buffer ? body : JSON.stringify(body)) : undefined,
        signal: AbortSignal.timeout(30000),
      });

      const contentType = resp.headers.get('content-type') || '';
      let data: any;
      if (contentType.includes('json')) {
        data = await resp.json();
      } else {
        data = await resp.text();
      }

      return { status: resp.status, data, contentType };
    } catch (err: any) {
      this.logger.error(`KB proxy error (deprecated path): ${method} ${url} — ${err.message}`);
      return { status: 502, data: { error: '企业心智服务不可用', detail: err.message } };
    }
  }
}
