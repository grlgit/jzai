# PDF图纸解析和标注问题修复总结

**日期**: 2026-07-14
**状态**: 已部署 (hotfix.sh)

## 诊断结果

通过PDF诊断工具分析了问题PDF文件，发现以下问题：

1. **水印检测**: 该PDF无水印（注释=0，OCG=不存在），水印去除失败不是根本问题
2. **文本合并失败**: 维度文本被分离为独立项（"102", " ", "110", " ", "120"）
3. **坐标漂移严重**: 气泡位置与原始维度文本位置偏差达86px

## 根本原因分析

### 问题1: 文本合并失败
- **位置**: `pdf-dimension-parser.service.ts` `isDimensionText()`
- **原因**: 正则表达式 `/^\d+\.?\d*$/` 不允许空格
- **影响**: 合并后的带空格文本（如"102 "）被判定为非尺寸文本而丢弃

### 问题2: 坐标计算错误
- **位置**: `pdf-dimension-parser.service.ts` `mergeAdjacentTextItems()`
- **原因**: 使用合并组第一项的X坐标，而非组的中心点
- **影响**: 气泡位置偏离维度文本中心

### 问题3: 碰撞避让过度
- **位置**: `bubble-generator.service.ts` `avoidCollision()`
- **原因**: 无最大偏移限制，气泡可大幅移动
- **影响**: 气泡从预期位置移动86px，远超40px的默认偏移

## 实施的修复

### 修复1: 改进isDimensionText接受带空格的数字
```typescript
// 旧代码
const isNumber = /^\d+\.?\d*$/.test(text);

// 新代码
const trimmed = text.trim();
const isNumber = /^\d+\.?\d*$/.test(trimmed);
```

### 修复2: 文本合并使用组中心点
```typescript
// 旧代码
currentX = x;  // 使用第一项坐标

// 新代码
const centerX = (currentGroup[0].transform[4] + currentGroup[currentGroup.length - 1].transform[4]) / 2;
merged.push({ text: mergedText, x: centerX, y: parseFloat(y.toString()) });
```

### 修复3: 碰撞避让限制最大偏移
```typescript
// 新增参数
maxOffset: number = 80,  // 最大允许偏移距离

// 检查是否超过最大偏移
const distFromOriginal = originalDistance(testX, testY);
if (distFromOriginal > maxOffset) {
  continue; // 跳过超出范围的偏移
}
```

## 验证测试结果

全部测试通过：
- ✓ isDimensionText修复: 8/8 (100%)
- ✓ 文本合并坐标修复: 通过
- ✓ 碰撞避让限制修复: 通过

## 预期效果

1. **水印检测**: 能正确识别无水印PDF，跳过不必要的处理
2. **文本识别**: 合并相邻文本项，提高尺寸标注识别率
3. **坐标精度**: 气泡位置偏差从86px降低到4-80px范围内

## 修改的文件

1. `/Users/greale/menhu.ai/main/src/capability/drawing/services/pdf-dimension-parser.service.ts`
2. `/Users/greale/menhu.ai/main/src/capability/drawing/services/bubble-generator.service.ts`

## 部署方式

热部署: `./hotfix.sh build` (已部署)
