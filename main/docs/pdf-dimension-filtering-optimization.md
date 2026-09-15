# PDF尺寸标注过滤优化

**日期**: 2026-07-14
**状态**: 已部署 (hotfix.sh)

## 问题描述

用户反馈：气泡标注数量远超Excel中的检验项目数量。

**问题分析**：
- PDF解析识别了125个文本项
- Excel生成正确地过滤出真正的检验项目
- 但气泡标注给所有识别出的文本都加了气泡（包括非检验项目）

## 根本原因

`isDimensionText()` 函数对纯数字的判断过于宽松：

```typescript
// 旧代码 - 太宽松
if (isNumber) {
  const num = parseFloat(trimmed);
  return num >= 0.1 && num < 5000;  // 任何0.1-5000的数字都被认为是尺寸！
}
```

这导致以下非检验项目被错误识别：
- 图号中的数字（如801、102、110等）
- 零件编号
- 序号和计数（1、2、3等）
- 比例和数量标注

## 实施的优化

**位置**: `/Users/greale/menhu.ai/main/src/capability/drawing/services/pdf-dimension-parser.service.ts`

### 优化1：增强非尺寸文本排除

```typescript
// 新增排除模式
const nonDimPatterns = [
  /^(图号|零件号|编号|代号|数量|比例|日期|设计师|审核)/,
  /^(GZ-|JHJM)/,           // 图号前缀
  /^(NO|No\.|编号)/,
  /^(\d{4,}|\d{2,}-\d{2,})$/,  // 长数字或日期格式
  /^(第.*页|共.*页|Page|P\.).*\d+$/,
];
```

### 优化2：严格的纯数字判断

```typescript
// 新代码 - 严格过滤
if (isNumber) {
  const num = parseFloat(trimmed);
  // 基本范围检查
  if (num < 0.1 || num >= 5000) return false;

  // 排除整数百位/千位（可能是图号或数量）
  if (num >= 100 && Number.isInteger(num)) return false;

  // 排除特别小的数字（可能是序号）
  if (num < 1 && num > 0) return false;

  // 排除常见特殊数字
  if ([1, 2, 3, 4, 5, 10, 20, 30, 40, 50].includes(num)) return false;

  // 只允许：小数 或 10-99的整数
  return !Number.isInteger(num) || (num >= 10 && num < 100);
}
```

### 优化3：混合文本判断

```typescript
// 混合文本（如"17.5025平底"）必须有小数部分
const mixedMatch = trimmed.match(/^(\d+\.?\d*)/);
if (mixedMatch) {
  const num = parseFloat(mixedMatch[1]);
  return !Number.isInteger(num) && num >= 0.1 && num < 5000;
}
```

## 预期效果

### 过滤效果对比

| 类别 | 旧逻辑 | 新逻辑 | 说明 |
|-----|-------|-------|------|
| 纯整数1-9 | ✓ 识别 | ✗ 排除 | 常见序号 |
| 纯整数10-99 | ✓ 识别 | ✓ 识别 | 可能是尺寸 |
| 纯整数≥100 | ✓ 识别 | ✗ 排除 | 图号或数量 |
| 小数 | ✓ 识别 | ✓ 识别 | 典型尺寸 |
| 带符号数字 | ✓ 识别 | ✓ 识别 | 公差标注 |
| 图号格式 | ✗ 排除 | ✗ 排除 | 保持原有 |

### 预期改进

- ✅ 气泡数量大幅减少（125个 → 约20-40个）
- ✅ 气泡数量与Excel检验项目数量基本一致
- ✅ 减少误识别，提高标注准确性

## 部署状态

已通过 `./hotfix.sh build` 热部署完成。

## 测试建议

使用相同的PDF文件重新测试：
1. 对比气泡数量与Excel检验项目数量
2. 确认气泡只标注在真正的尺寸标注上
3. 检查是否有遗漏的真实检验项目

## 可调参数

如果需要进一步调整，可以修改以下参数：

1. **整数范围**: `num >= 10 && num < 100` (当前10-99)
2. **排除数字**: `[1, 2, 3, 4, 5, 10, 20, 30, 40, 50]` (可增减)
3. **大整数阈值**: `num >= 100` (当前≥100排除)
