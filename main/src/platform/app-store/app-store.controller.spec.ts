import { BadRequestException } from '@nestjs/common';
import { AppStoreController } from './app-store.controller';
import { ORPHANED_DATABASE_RESOURCES_ERROR } from './services/app-install.service';
import { APP_CONFIG_ARTIFACT_PERMISSION } from './services/app-activation.service';

describe('AppStoreController', () => {
  const controller = new AppStoreController(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  const failureMessage = (error: unknown): string =>
    (controller as any).getInstallFailureMessage(error);

  it('maps invalid database URLs to actionable configuration guidance', () => {
    expect(failureMessage(new TypeError('Invalid URL'))).toBe(
      '平台数据库连接配置无效，请检查数据库主机、端口和数据库名称。',
    );
  });

  it('maps backend activation failures without exposing raw internals', () => {
    const message = failureMessage(new Error('Backend entry not found for probe: /tmp/probe.js'));

    expect(message).toBe('应用后端激活失败，请检查应用包的后端入口和工具配置后重新上传。');
    expect(message).not.toContain('/tmp/probe.js');
  });

  it('retains safe validation errors for the uploader', () => {
    expect(failureMessage(new BadRequestException('Package validation failed: manifest.json missing'))).toBe(
      'Package validation failed: manifest.json missing',
    );
  });

  it('maps orphaned database resources to a confirmed recovery action', () => {
    const message = failureMessage(new BadRequestException(ORPHANED_DATABASE_RESOURCES_ERROR));

    expect(message).toBe('发现同名应用的遗留数据库。请确认清除遗留数据后重试；此操作会永久删除旧应用数据。');
    expect(message).not.toContain(ORPHANED_DATABASE_RESOURCES_ERROR);
  });

  it('maps configuration artifact permission failures separately from database permissions', () => {
    const message = failureMessage(new Error(`${APP_CONFIG_ARTIFACT_PERMISSION}: /app/main/config/agents/dt_dimension_classifier.yaml`));

    expect(message).toBe('应用配置目录权限不足。请由管理员清理或修复旧的挂载配置文件后重试。');
    expect(message).not.toContain('数据库权限');
  });
});
