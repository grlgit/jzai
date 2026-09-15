import { AppInstallOperationService } from './app-install-operation.service';

describe('AppInstallOperationService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('exposes a staged package only after validation succeeds', () => {
    const service = new AppInstallOperationService();
    const operation = service.create();

    expect(() => service.getReadyStageDir(operation.stageId)).toThrow('尚未完成校验');

    service.setStageDir(operation.stageId, '/tmp/jzapp-stage');
    service.setReady(
      operation.stageId,
      { appId: 'com.menhu.drawing.dimtuner', version: '1.0.0', name: { zh: '图纸识别' } },
      ['示例警告'],
    );

    expect(service.getReadyStageDir(operation.stageId)).toBe('/tmp/jzapp-stage');
    expect(service.get(operation.stageId)).toMatchObject({
      phase: 'ready',
      percent: 45,
      warnings: ['示例警告'],
    });
  });

  it('keeps validation errors available to polling clients', () => {
    const service = new AppInstallOperationService();
    const operation = service.create();

    service.fail(
      operation.stageId,
      ['manifest.json 缺失', '工具命名空间冲突'],
      '应用包校验失败，请修正后重新上传',
    );

    expect(service.get(operation.stageId)).toMatchObject({
      phase: 'failed',
      message: '应用包校验失败，请修正后重新上传',
      errors: ['manifest.json 缺失', '工具命名空间冲突'],
    });
  });

  it('permits a retry only for confirmed orphaned-data recovery', () => {
    const service = new AppInstallOperationService();
    const operation = service.create();
    service.setStageDir(operation.stageId, '/tmp/jzapp-stage');
    service.fail(
      operation.stageId,
      '发现遗留数据库',
      '发现遗留数据库',
      'purge-orphaned-data',
    );

    expect(() => service.getInstallStageDir(operation.stageId)).toThrow('尚未完成校验');
    expect(service.getInstallStageDir(operation.stageId, true)).toBe('/tmp/jzapp-stage');
    expect(service.get(operation.stageId).recovery).toBe('purge-orphaned-data');
  });
});
