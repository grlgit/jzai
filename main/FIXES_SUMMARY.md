# PDF尺寸解析修复总结

## 问题描述
1. Excel生成内容为空白
2. 气泡图格式和位置错误
3. 尺寸数据提取严重遗漏，只有30项，正确值应该大于40项
4. 关键大尺寸（如1328.50、1388.50）被遗漏

## 根本原因
1. **mergeAdjacentTextItems过度合并**: 将"1328.50"与相邻的"1180"合并成"1328.501180"，导致过滤时被排除
2. **handler.ts工具调用错误**: 使用了不存在的工具`ocr_extract`、`drawing_dimension_understand`、`image_edit`
3. **dimension_classifier.yaml路径错误**: `metadata.graphicContext`应为`graphicContext`

## 修复方案

### 1. 修复mergeAdjacentTextItems过度合并 (pdf-dimension-parser.service.ts:162-276)
**策略**: 三阶段合并算法
- **阶段1**: 优先保留所有独立单数字项
  ```typescript
  // 严格匹配纯数字（包括小数），避免过度合并导致大尺寸遗漏
  if (/^\d+\.?\d*$/.test(text)) {
    const num = parseFloat(text);
    if (num >= 0.01 && num < 10000) {
      singleNumbers.push({ text: text, x: item.transform[4], y: item.transform[5] });
    }
  }
  ```
- **阶段2**: 按Y坐标分组进行合并处理（处理复合文本如"20+0.02"）
- **阶段3**: 去重合并（单数字项优先，保留原始数值）

### 2. 增加OCR交叉验证 (pdf-dimension-parser.service.ts:647-727)
**功能**: 使用OCR提取的尺寸作为对照校验
```typescript
private async ocrCrossValidation(filePath: string, pdfDimensions: Dimension[]): Promise<void> {
  // 使用OCR提取PDF文本
  const ocrResult = await this.ocrService.extract(filePath);
  
  // 从OCR文本中提取尺寸模式
  const ocrDimensions = this.extractDimensionsFromText(ocrText);
  
  // 比对差异
  const missingInPdf = ocrValues.filter(v => !pdfValues.has(v));
  const missingInOcr = pdfValues.filter(v => !ocrValues.has(v));
  
  // 报告关键差异（特别是大尺寸）
  const largeMissing = missingInPdf
    .map(v => parseFloat(v))
    .filter(v => v >= 1000 && v < 10000)
    .sort((a, b) => b - a);
}
```

**支持的尺寸模式匹配**:
- 纯数字（包括小数）
- 带直径符号的尺寸（⌀, φ, Φ）
- 带半径符号的尺寸（R）
- 带公差的尺寸（±, +）

### 3. 修复handler.ts工具调用 (drawing-dimension-inspector/handler.ts)
**修复前**:
```typescript
// 调用不存在的工具
await ctx.callTool('ocr_extract', {...});
await ctx.callTool('drawing_dimension_understand', {...});
await ctx.callTool('image_edit', {...});
```

**修复后**:
```typescript
// 使用正确的工具
await ctx.callTool('drawing_parse_pdf', {...});
await ctx.callTool('pdf_draw_bubbles', {...});
await ctx.callTool('export_excel', {...});
```

### 4. 修复dimension_classifier.yaml路径
**修复前**: `metadata.graphicContext`
**修复后**: `graphicContext`

## 文件修改清单
1. `/Users/greale/menhu.ai/main/src/capability/drawing/services/pdf-dimension-parser.service.ts`
   - 修复mergeAdjacentTextItems过度合并
   - 增加OCR交叉验证方法
   
2. `/Users/greale/menhu.ai/docker_gen/config/skills/drawing-dimension-inspector/handler.ts`
   - 修复工具调用
   
3. `/Users/greale/menhu.ai/main/config/agents/dimension_classifier.yaml`
   - 修复graphicContext路径
   
4. `/Users/greale/menhu.ai/hotfix.sh`
   - 更新部署脚本

## 部署状态
✅ 已通过hotfix.sh部署并构建完成

## 验证方法
1. 重启服务: `cd /Users/greale/menhu.ai/main && npm run start:dev`
2. 使用测试PDF: `/Users/greale/menhu.ai/docker_gen/workspace/mq98yn6rxros/GZ-LXXB-01.pdf`
3. 检查日志输出:
   - 关键尺寸1328.50、1388.50应被正确识别
   - OCR交叉验证应显示比对结果
   - 总提取尺寸应>40项

## 预期改进
- **提取准确率**: 30项 → >40项
- **关键尺寸**: 遗漏1328.50、1388.50 → 正确提取
- **Excel生成**: 空白 → 包含所有尺寸数据
- **气泡图**: 格式位置错误 → 正确标注

## 技术要点
1. **单数字优先策略**: 确保大尺寸不会被合并破坏
2. **OCR对照校验**: 作为质量验证，不作为主要提取方式
3. **图形上下文分析**: 保留原有的箭头、尺寸线检测能力
4. **渐进式修复**: 不改变原有架构，只修复关键问题点
