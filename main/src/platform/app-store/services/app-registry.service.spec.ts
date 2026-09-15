import { AppRegistryService } from './app-registry.service';

describe('AppRegistryService', () => {
  it('reads database.schemaName through JSONB before text extraction', async () => {
    const db = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            app_id: 'com.menhu.drawing.dimtuner',
            short_name: 'dimension-tuner',
            ns_prefix: 'dt',
            schema_name: 'app_dim_tuner',
            panels: [{ id: 'dimensionTuner' }],
            tool_providers: [{ toolIds: ['dt_parse_pdf'] }],
          },
        ],
      }),
    };
    const service = new AppRegistryService(db as any);

    const ids = await service.getExistingIds();

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("manifest->'database'->>'schemaName'"),
    );
    expect(ids.schemaNames).toEqual(new Set(['app_dim_tuner']));
    expect(ids.panelIds).toEqual(new Set(['dimensionTuner']));
    expect(ids.toolIds).toEqual(new Set(['dt_parse_pdf']));
  });

  it('maps the persisted installed path to installDir', async () => {
    const db = {
      query: jest.fn().mockResolvedValue({ rows: [{ appId: 'com.menhu.drawing.dimtuner', installDir: '/workspace/app-store/dimension-tuner' }] }),
    };
    const service = new AppRegistryService(db as any);

    const app = await service.findOne('com.menhu.drawing.dimtuner');

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('extract_dir as "installDir"'),
      ['com.menhu.drawing.dimtuner'],
    );
    expect(app?.installDir).toBe('/workspace/app-store/dimension-tuner');
  });

  it('restores only an existing uninstalled app record', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const service = new AppRegistryService(db as any);
    const manifest = {
      appId: 'com.menhu.drawing.dimtuner',
      shortName: 'dimension-tuner',
      nsPrefix: 'dt',
      version: '1.1.0',
      name: { zh: '图纸识别' },
    } as any;

    await service.restore(manifest, { enabled: true }, '/workspace/app-store/dimension-tuner');

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE app_id=$1 AND status='uninstalled'"),
      expect.arrayContaining(['com.menhu.drawing.dimtuner', 'dimension-tuner', 'dt', '1.1.0']),
    );
  });
});
