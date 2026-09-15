import { Test } from '@nestjs/testing';
import { MediaToolProvider } from './media.tools';
import { OcrService } from './ocr.service';

describe('MediaToolProvider', () => {
  let provider: MediaToolProvider;

  const mockOcrService = {
    extract: jest.fn(),
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        MediaToolProvider,
        { provide: OcrService, useValue: mockOcrService },
      ],
    }).compile();

    provider = module.get(MediaToolProvider);
  });

  afterEach(() => jest.clearAllMocks());

  describe('createTools', () => {
    it('should return 6 tools with correct names', async () => {
      const ctx = {
        piAi: {
          Type: {
            Object: (props: any) => props,
            String: (opts?: any) => ({ type: 'string', ...opts }),
            Number: (opts?: any) => ({ type: 'number', ...opts }),
            Optional: (schema: any) => ({ ...schema, optional: true }),
            Array: (items: any, opts?: any) => ({ type: 'array', items, ...opts }),
          },
        },
      };

      const tools = await provider.createTools(ctx);

      expect(tools).toHaveLength(6);
      const names = tools.map(t => t.name);
      expect(names).toContain('ocr_extract');
      expect(names).toContain('document_extract');
      expect(names).toContain('image_understand');
      expect(names).toContain('image_edit');
      expect(names).toContain('whisper_transcribe');
      expect(names).toContain('summarize');
    });

    it('should return empty array when Type is not available', async () => {
      const tools = await provider.createTools({});
      expect(tools).toHaveLength(0);
    });
  });

  describe('getCatalog', () => {
    it('should return 6 entries with group 资料处理', () => {
      const catalog = provider.getCatalog();

      expect(catalog).toHaveLength(6);
      for (const entry of catalog) {
        expect(entry.group).toBe('资料处理');
      }

      const ids = catalog.map(e => e.id);
      expect(ids).toEqual(['ocr', 'document_extract', 'image_understand', 'image_edit', 'whisper', 'summarize']);
    });
  });
});
