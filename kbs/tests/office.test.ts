/**
 * Office 管线测试：JSZip 生成最小 docx/pptx，验证纯 TS 提取。
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { processOfficeDocument, UnsupportedOfficeFormatError } from '../src/processor/office';

async function makeDocx(outPath: string): Promise<void> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>麒麟芯片出货检验规范</w:t></w:r></w:p>
    <w:p><w:r><w:t>IQC 来料检验按 AQL2.5 抽样</w:t></w:r></w:p>
    <w:p><w:r><w:t>玄武架构产品全检外观</w:t></w:r></w:p>
  </w:body>
</w:document>`,
  );
  fs.writeFileSync(outPath, await zip.generateAsync({ type: 'nodebuffer' }));
}

async function makePptx(outPath: string): Promise<void> {
  const zip = new JSZip();
  const slide = (texts: string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    ${texts.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('\n    ')}
  </p:spTree></p:cSld>
</p:sld>`;
  zip.file('ppt/slides/slide1.xml', slide(['麒麟芯片良率分析', '玄武架构介绍']));
  zip.file('ppt/slides/slide2.xml', slide(['出货检验流程', 'AQL 抽样标准']));
  fs.writeFileSync(outPath, await zip.generateAsync({ type: 'nodebuffer' }));
}

describe('Office 管线（纯 TS）', () => {
  it('docx → mammoth 提取正文（单页语义）', async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kbs-docx-')), 'test.docx');
    await makeDocx(tmp);
    const { pages, parser } = await processOfficeDocument('docx', tmp);
    expect(parser).toBe('mammoth');
    expect(pages.length).toBe(1);
    expect(pages[0][1]).toContain('麒麟芯片出货检验规范');
    expect(pages[0][1]).toContain('AQL2.5');
    expect(pages[0][1]).toContain('玄武架构');
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  });

  it('pptx → slide XML 提取（每 slide 一页）', async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kbs-pptx-')), 'test.pptx');
    await makePptx(tmp);
    const { pages, parser } = await processOfficeDocument('pptx', tmp);
    expect(parser).toBe('pptx-xml');
    expect(pages.length).toBe(2);
    expect(pages[0][0]).toBe(1);
    expect(pages[0][1]).toContain('麒麟芯片良率分析');
    expect(pages[1][0]).toBe(2);
    expect(pages[1][1]).toContain('出货检验流程');
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  });

  it('legacy doc → 明确报错提示转换', async () => {
    await expect(processOfficeDocument('doc', '/nonexistent.doc')).rejects.toThrow(UnsupportedOfficeFormatError);
    await expect(processOfficeDocument('doc', '/nonexistent.doc')).rejects.toThrow(/请转换为/);
  });
});
