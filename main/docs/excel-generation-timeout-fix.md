# Excel生成卡死问题修复

**日期**: 2026-07-14
**状态**: 已部署 (hotfix.sh)

## 问题症状

用户报告最近一次调用生成Excel时出现异常缓慢和卡死状态。

## 诊断过程

通过分析后端日志发现：

1. **1:27:42 PM (成功案例)**: `export_excel`调用成功，耗时0.5秒
2. **2:40:44 PM (失败案例)**: 智能体说"现在我来生成检验报告Excel。"但从未实际调用工具
3. **2:52:00 PM**: 180秒超时，显示"Inactivity timeout: 180s since last event"

## 根本原因

**不是Excel生成慢，而是智能体响应中断**。

**关键发现**：
```
[ToolBridgeService] Tool skill_drawing-dimension-inspector: result truncated 24446 → 20022ch
```

`skill_drawing-dimension-inspector` 返回24KB数据（125个尺寸标注），超过默认的20KB限制。智能体在处理截断的大结果时卡住，未能继续生成`export_excel`工具调用。

**数据流**：
1. `skill_drawing-dimension-inspector` 返回125个尺寸标注数据（24KB）
2. ToolBridge截断到20KB（默认限制）
3. 智能体处理截断结果时卡住
4. 180秒后超时

## 实施的修复

**位置**: `/Users/greale/menhu.ai/main/src/agent/tool-bridge/tool-bridge.service.ts`

### 修复1: 增加图纸相关工具的结果大小限制
```typescript
const limits: Record<string, number> = {
  document_extract: 20000, read: 20000, ocr: 20000,
  knowledge: 15000, kb_mcp: 15000, web_search: 15000,
  fetch_url: 15000, firecrawl: 15000, web_fetch: 15000,
  skill_drawing_dimension_inspector: 50000,  // 图纸检验数据较大，允许50KB
  drawing_parse_dxf: 30000,                  // DXF解析结果较大
  drawing_parse_pdf: 30000,                  // PDF解析结果较大
  bash: 10000,
};
```

### 修复2: 为skill前缀添加默认限制
```typescript
// Skill prefix for drawing tools defaults to 50KB
else if (toolName.startsWith('skill_drawing') || toolName.startsWith('skill_pdf')) {
  maxChars = 50000;
}
```

## 预期效果

1. **不再截断**: 图纸检验技能的完整结果（24KB）将不被截断
2. **正常流程**: 智能体能接收完整的尺寸标注数据，正常调用export_excel
3. **快速响应**: Excel生成恢复到正常的0.5秒响应时间

## 相关问题

此修复与之前的PDF图纸解析修复是关联的：
- PDF解析修复提高了识别准确性（125个尺寸）
- 这导致了结果数据量增加（24KB）
- 触发了默认的20KB截断限制
- 本次修复解决了截断导致的卡死问题

## 部署方式

热部署: `./hotfix.sh build` (已部署)
