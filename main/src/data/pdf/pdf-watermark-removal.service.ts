import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface WatermarkDetectionResult {
  hasWatermark: boolean;
  watermarkTypes: string[];
  annotations: number;
  ocgLayers: number;
  xObjects: number;
  details: string[];
  removalCandidates: RemovalCandidate[];
}

export interface RemovalCandidate {
  type: 'annotation' | 'ocg' | 'xobject';
  id: string;
  description: string;
  confidence: number;
}

export interface WatermarkRemovalResult {
  success: boolean;
  outputPath: string;
  removed: string[];
  removedCount: number;
  detection: WatermarkDetectionResult;
}

export interface WatermarkRemovalOptions {
  detectOnly?: boolean;
  removeAnnotations?: boolean;
  removeOcgLayers?: boolean;
  removeXObjects?: boolean;
  outputPath?: string;
  preserveMetadata?: boolean;
}

/**
 * PDF去水印服务
 *
 * 支持检测和删除以下类型的水印：
 * - Annotation: 文本/图像注释型水印
 * - OCG Layer: 可选内容组图层水印
 * - XObject: 嵌入的图像/表单对象
 */
@Injectable()
export class PdfWatermarkRemovalService {
  private readonly logger = new Logger(PdfWatermarkRemovalService.name);

  // 水印关键词（用于文本内容匹配）
  private readonly WATERMARK_KEYWORDS = [
    '水印', 'watermark', 'confidential', 'draft', 'secret',
    '内部', '机密', '仅供参考', '副本', 'sample',
    'do not copy', 'preliminary', 'unauthorized'
  ];

  // Helper to get PDF Name object
  private pdfName(name: string): any {
    const { PDFDocument } = require('pdf-lib');
    return PDFDocument.Name(name);
  }

  /**
   * 检测PDF中的水印
   */
  async detectWatermarks(filePath: string): Promise<WatermarkDetectionResult> {
    const { PDFDocument } = require('pdf-lib');

    if (!fs.existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }

    const pdfBytes = fs.readFileSync(filePath);
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

    const result: WatermarkDetectionResult = {
      hasWatermark: false,
      watermarkTypes: [],
      annotations: 0,
      ocgLayers: 0,
      xObjects: 0,
      details: [],
      removalCandidates: [],
    };

    const pages = pdfDoc.getPages();

    // Phase 1: Detect annotations
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const pageIdx = i + 1;

      try {
        const pageNode = page.node;
        const annotsRef = pageNode.get(PDFDocument.Name('Annots'));

        if (annotsRef) {
          const annots = annotsRef.asPDFArray();
          result.annotations += annots.size();

          for (let j = 0; j < annots.size(); j++) {
            try {
              const annot = annots.getAsDict(j);
              if (!annot) continue;

              const subtype = annot.get(PDFDocument.Name('Subtype'));
              const contents = annot.get(PDFDocument.Name('Contents'));

              if (subtype) {
                const subtypeName = this.getNameValue(subtype);
                const contentText = contents ? this.getStringValue(contents) : '';

                const confidence = this.isAnnotationWatermark(subtypeName, contentText);
                if (confidence > 0.5) {
                  result.hasWatermark = true;
                  if (!result.watermarkTypes.includes('Annotation')) {
                    result.watermarkTypes.push('Annotation');
                  }
                  result.removalCandidates.push({
                    type: 'annotation',
                    id: `page_${pageIdx}_annot_${j}`,
                    description: `第${pageIdx}页注释: ${subtypeName}${contentText ? ` (${contentText.slice(0, 20)})` : ''}`,
                    confidence,
                  });
                  result.details.push(`检测到水印注释: ${subtypeName} 于第 ${pageIdx} 页 (置信度: ${confidence.toFixed(2)})`);
                }
              }
            } catch (annotErr) {
              // Skip individual annotation errors
            }
          }
        }
      } catch (pageErr) {
        this.logger.debug(`Annotation detection on page ${pageIdx}: ${pageErr.message}`);
      }
    }

    // Phase 1: Detect OCG (Optional Content Groups) layers
    try {
      const catalog = pdfDoc.catalog;
      const ocProperties = catalog.get(PDFDocument.Name('OCProperties'));

      if (ocProperties) {
        const ocgs = ocProperties.get(PDFDocument.Name('OCGs'));
        if (ocgs) {
          const ocgArray = ocgs.asPDFArray();
          result.ocgLayers = ocgArray.size();

          for (let i = 0; i < ocgArray.size(); i++) {
            try {
              const ocg = ocgArray.getAsDict(i);
              if (!ocg) continue;

              const name = ocg.get(PDFDocument.Name('Name'));
              const nameStr = name ? this.getStringValue(name) : '';

              const confidence = this.isOcgWatermark(nameStr);
              if (confidence > 0.5) {
                result.hasWatermark = true;
                if (!result.watermarkTypes.includes('OCG Layer')) {
                  result.watermarkTypes.push('OCG Layer');
                }
                result.removalCandidates.push({
                  type: 'ocg',
                  id: `ocg_${i}`,
                  description: `图层: ${nameStr || '未命名'}`,
                  confidence,
                });
                result.details.push(`检测到水印图层: ${nameStr || '未命名'} (置信度: ${confidence.toFixed(2)})`);
              }
            } catch (ocgErr) {
              // Skip individual OCG errors
            }
          }
        }
      }
    } catch (err) {
      this.logger.debug(`OCG detection skipped: ${err.message}`);
    }

    // Phase 2: Detect XObjects (images and forms)
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const pageIdx = i + 1;

      try {
        const resources = page.node.get(PDFDocument.Name('Resources'));
        if (!resources) continue;

        const xObjectRef = resources.get(PDFDocument.Name('XObject'));
        if (!xObjectRef) continue;

        const xObject = xObjectRef.asPDFDict();
        if (!xObject) continue;

        const entries = Object.entries(xObject.entries());
        result.xObjects += entries.length;

        for (const [key, objRef] of entries) {
          try {
            const obj: any = objRef;
            // Check if it's a stream object (XObject)
            if (!obj || !obj.context) continue;

            const subtype = obj.get(PDFDocument.Name('Subtype'));
            if (!subtype) continue;

            const subtypeName = this.getNameValue(subtype);

            if (subtypeName === 'Image' || subtypeName === 'Form') {
              const opacity = this.extractOpacity(obj);
              const bbox = this.extractBBox(obj);
              const nameStr = key.toLowerCase();

              const confidence = this.isXObjectWatermark(subtypeName, opacity, bbox, nameStr);
              if (confidence > 0.5) {
                result.hasWatermark = true;
                if (!result.watermarkTypes.includes('XObject')) {
                  result.watermarkTypes.push('XObject');
                }
                result.removalCandidates.push({
                  type: 'xobject',
                  id: `page_${pageIdx}_xobj_${key}`,
                  description: `第${pageIdx}页XObject: ${subtypeName}${opacity !== null ? ` (透明度: ${opacity.toFixed(2)})` : ''}`,
                  confidence,
                });
                result.details.push(`检测到水印XObject: ${key} 于第 ${pageIdx} 页 (置信度: ${confidence.toFixed(2)})`);
              }
            }
          } catch (xobjErr) {
            // Skip individual XObject errors
          }
        }
      } catch (pageErr) {
        this.logger.debug(`XObject detection on page ${pageIdx}: ${pageErr.message}`);
      }
    }

    this.logger.log(`水印检测完成: ${filePath}, 水印=${result.hasWatermark}, 类型=${result.watermarkTypes.join(', ')}, 候选=${result.removalCandidates.length}`);

    return result;
  }

  /**
   * 删除PDF中的水印
   */
  async removeWatermarks(
    filePath: string,
    options: WatermarkRemovalOptions = {},
  ): Promise<WatermarkRemovalResult> {
    const {
      detectOnly = false,
      removeAnnotations = true,
      removeOcgLayers = true,
      removeXObjects = true,
      preserveMetadata = true,
    } = options;

    // First, detect watermarks
    const detection = await this.detectWatermarks(filePath);

    if (!detection.hasWatermark) {
      return {
        success: true,
        outputPath: filePath,
        removed: [],
        removedCount: 0,
        detection,
      };
    }

    if (detectOnly) {
      return {
        success: true,
        outputPath: filePath,
        removed: [],
        removedCount: 0,
        detection,
      };
    }

    // Perform removal
    const { PDFDocument } = require('pdf-lib');
    const pdfBytes = fs.readFileSync(filePath);
    const pdfDoc = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });

    const removed: string[] = [];

    // Remove annotations
    if (removeAnnotations) {
      const annotCandidates = detection.removalCandidates.filter((c) => c.type === 'annotation');
      for (const candidate of annotCandidates) {
        try {
          const match = candidate.id.match(/page_(\d+)_annot_(\d+)/);
          if (match) {
            const pageNum = parseInt(match[1]) - 1;
            const pages = pdfDoc.getPages();
            if (pageNum >= 0 && pageNum < pages.length) {
              const page = pages[pageNum];
              const pageNode = page.node;
              const annotsRef = pageNode.get(PDFDocument.Name('Annots'));

              if (annotsRef) {
                const annots = annotsRef.asPDFArray();
                const annotIdx = parseInt(match[2]);

                if (annotIdx < annots.size()) {
                  // Remove by clearing the annotation
                  // pdf-lib doesn't have direct delete, so we set to null
                  try {
                    annots.delete(annotIdx);
                    removed.push(candidate.description);
                  } catch (delErr) {
                    // Try alternative: set to empty dict
                    annots.set(annotIdx, pdfDoc.context.object({}));
                    removed.push(candidate.description);
                  }
                }
              }
            }
          }
        } catch (err) {
          this.logger.warn(`Failed to remove annotation ${candidate.id}: ${err.message}`);
        }
      }
    }

    // Remove OCG layers
    if (removeOcgLayers) {
      const ocgCandidates = detection.removalCandidates.filter((c) => c.type === 'ocg');
      for (const candidate of ocgCandidates) {
        try {
          const catalog = pdfDoc.catalog;
          const ocProperties = catalog.get(PDFDocument.Name('OCProperties'));

          if (ocProperties) {
            const ocgs = ocProperties.get(PDFDocument.Name('OCGs'));
            if (ocgs) {
              const ocgArray = ocgs.asPDFArray();
              const match = candidate.id.match(/ocg_(\d+)/);
              if (match) {
                const idx = parseInt(match[1]);
                if (idx < ocgArray.size()) {
                  try {
                    ocgArray.delete(idx);
                    removed.push(candidate.description);
                  } catch (delErr) {
                    ocgArray.set(idx, null);
                    removed.push(candidate.description);
                  }
                }
              }
            }
          }
        } catch (err) {
          this.logger.warn(`Failed to remove OCG ${candidate.id}: ${err.message}`);
        }
      }
    }

    // Remove XObjects (more complex - requires resource modification)
    if (removeXObjects) {
      const xobjCandidates = detection.removalCandidates.filter((c) => c.type === 'xobject');
      for (const candidate of xobjCandidates) {
        try {
          const match = candidate.id.match(/page_(\d+)_xobj_(.+)/);
          if (match) {
            const pageNum = parseInt(match[1]) - 1;
            const xobjKey = match[2];
            const pages = pdfDoc.getPages();

            if (pageNum >= 0 && pageNum < pages.length) {
              const page = pages[pageNum];
              const resources = page.node.get(PDFDocument.Name('Resources'));

              if (resources) {
                const xObjectRef = resources.get(PDFDocument.Name('XObject'));
                if (xObjectRef) {
                  const xObject = xObjectRef.asPDFDict();
                  if (xObject && xObject.dict[xobjKey]) {
                    delete xObject.dict[xobjKey];
                    removed.push(candidate.description);
                  }
                }
              }
            }
          }
        } catch (err) {
          this.logger.warn(`Failed to remove XObject ${candidate.id}: ${err.message}`);
        }
      }
    }

    // Save the modified PDF
    const outputBytes = await pdfDoc.save();

    // Determine output path
    let outputPath = options.outputPath;
    if (!outputPath) {
      const ext = path.extname(filePath);
      const base = filePath.slice(0, -ext.length);
      outputPath = `${base}_cleaned${ext}`;
    }

    // Ensure output directory exists
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, outputBytes);

    this.logger.log(`PDF水印清理完成: ${outputPath}, 已删除 ${removed.length} 项`);

    return {
      success: true,
      outputPath,
      removed,
      removedCount: removed.length,
      detection,
    };
  }

  /**
   * 判断注释是否为水印
   */
  private isAnnotationWatermark(subtype: string, content: string): number {
    // Subtype 'Watermark' is definitive
    if (subtype === 'Watermark') {
      return 0.95;
    }

    // Check content for watermark keywords
    if (content) {
      const lowerContent = content.toLowerCase();
      for (const keyword of this.WATERMARK_KEYWORDS) {
        if (lowerContent.includes(keyword.toLowerCase())) {
          return 0.80;
        }
      }
    }

    // Stamp subtype with suspicious content
    if (subtype === 'Stamp' && content && content.length < 50) {
      return 0.60;
    }

    return 0;
  }

  /**
   * 判断OCG是否为水印图层
   */
  private isOcgWatermark(name: string): number {
    if (!name) return 0;

    const lowerName = name.toLowerCase();

    // Direct name match
    for (const keyword of this.WATERMARK_KEYWORDS) {
      if (lowerName.includes(keyword.toLowerCase())) {
        return 0.85;
      }
    }

    // Layer naming patterns
    if (/^(watermark|background|bg|overlay|stamp)/.test(lowerName)) {
      return 0.75;
    }

    return 0;
  }

  /**
   * 判断XObject是否为水印
   */
  private isXObjectWatermark(
    subtype: string,
    opacity: number | null,
    bbox: { x: number; y: number; width: number; height: number } | null,
    name: string,
  ): number {
    let confidence = 0;

    // Semi-transparent is strong indicator
    if (opacity !== null && opacity < 0.6 && opacity > 0.1) {
      confidence += 0.4;
      if (opacity < 0.3) {
        confidence += 0.2; // Very transparent = more likely watermark
      }
    }

    // Large size coverage
    if (bbox) {
      const area = bbox.width * bbox.height;
      if (area > 100000) {
        // Large object
        confidence += 0.2;
      }
    }

    // Name contains watermark keywords
    for (const keyword of this.WATERMARK_KEYWORDS) {
      if (name.includes(keyword.toLowerCase())) {
        confidence += 0.3;
        break;
      }
    }

    // Form XObjects are often used for watermarks
    if (subtype === 'Form') {
      confidence += 0.1;
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * Extract opacity from XObject graphics state
   */
  private extractOpacity(xObj: any): number | null {
    try {
      const gsEntry = xObj.get(this.pdfName('GS'));
      if (gsEntry) {
        const gsDict = gsEntry.asDict();
        if (gsDict) {
          const ca = gsDict.get(this.pdfName('ca')); // Non-stroking alpha
          if (ca !== null && ca !== undefined) {
            const numVal = ca.asNumber();
            return numVal !== null ? numVal : null;
          }
        }
      }

      // Try direct ca property
      const ca = xObj.get(this.pdfName('ca'));
      if (ca !== null && ca !== undefined) {
        const numVal = ca.asNumber();
        return numVal !== null ? numVal : null;
      }
    } catch (err) {
      // Ignore extraction errors
    }
    return null;
  }

  /**
   * Extract bounding box from XObject
   */
  private extractBBox(xObj: any): { x: number; y: number; width: number; height: number } | null {
    try {
      const bbox = xObj.get(this.pdfName('BBox'));
      if (bbox) {
        const bboxArray = bbox.asPDFArray();
        if (bboxArray && bboxArray.size() >= 4) {
          const x0 = bboxArray.getAsNumber(0) ?? 0;
          const y0 = bboxArray.getAsNumber(1) ?? 0;
          const x1 = bboxArray.getAsNumber(2) ?? 0;
          const y1 = bboxArray.getAsNumber(3) ?? 0;
          return {
            x: x0,
            y: y0,
            width: Math.abs(x1 - x0),
            height: Math.abs(y1 - y0),
          };
        }
      }
    } catch (err) {
      // Ignore extraction errors
    }
    return null;
  }

  /**
   * Helper: Get string value from PDF name or string object
   */
  private getNameValue(obj: any): string {
    try {
      if (obj && obj.name) {
        return obj.name;
      }
      if (obj && obj.asName) {
        return obj.asName();
      }
      return String(obj);
    } catch {
      return '';
    }
  }

  /**
   * Helper: Get string value from PDF string object
   */
  private getStringValue(obj: any): string {
    try {
      if (typeof obj === 'string') return obj;
      if (obj && obj.value) return obj.value;
      if (obj && obj.asString) return obj.asString();
      return String(obj);
    } catch {
      return '';
    }
  }
}
