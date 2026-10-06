/**
 * Mistral OCR 路径（可选，移植自 kbs/src/processor/mistral.ts）。
 */
import * as fs from 'fs';
import { PageContents } from './pdf';

export async function extractPdfViaMistral(pdfPath: string, apiKey: string): Promise<PageContents> {
  const b64 = fs.readFileSync(pdfPath).toString('base64');
  const resp = await fetch('https://api.mistral.ai/v1/ocr', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'mistral-ocr-latest',
      document: { type: 'document_url', document_url: `data:application/pdf;base64,${b64}` },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!resp.ok) {
    throw new Error(`Mistral OCR failed: HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  }
  const result = (await resp.json()) as { pages?: Array<{ markdown?: string }> };
  return (result.pages || []).map((p, i) => [i + 1, p.markdown || ''] as [number, string]);
}
