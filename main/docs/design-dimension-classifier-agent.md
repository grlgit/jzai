# 尺寸分类：System Prompt vs 独立智能体

## 架构对比

### 方案 A: System Prompt 增强
```
主 Agent (当前)
  ↓
System prompt 注入工程符号知识
  ↓
同时处理：解析 + 分类 + 过滤
```

**优势：**
- 实现简单，只需修改提示词
- 无需额外组件
- 快速迭代

**劣势：**
- 提示词膨胀，主 Agent 承担多重职责
- Token 消耗增加（每次调用都带完整知识）
- 知识与任务耦合，难以复用
- 主 Agent 的其他任务受影响

### 方案 B: 独立智能体
```
尺寸分类 Agent (domain_classifier)
  ↓
专注：文本项 → 尺寸/非尺寸
  ↓
主 Agent 调用 → 获得分类结果
  ↓
主 Agent 专注：尺寸 → 检验项目
```

**优势：**
- **职责分离**：分类 Agent 专注符号识别，主 Agent 专注工程判断
- **知识隔离**：工程符号知识只在分类 Agent 中，不影响其他任务
- **Token 高效**：分类 Agent 只在需要时调用，不增加主 Agent 提示词
- **可复用**：PDF、DXF、图像（未来）都用同一个分类器
- **独立测试**：可单独优化分类准确率

**劣势：**
- 需要新增 Agent 配置
- 略微增加调用复杂度

## 推荐方案：独立智能体

### 理由

1. **任务性质适合专业化**
   - 分类任务是二分类（尺寸 vs 非尺寸）
   - 需要深厚的工程制图领域知识
   - 与"筛选检验项目"是不同层级的任务

2. **知识注入的隔离性**
   - 工程符号知识表（200+ tokens）
   - Few-shot 示例（500+ tokens）
   - 放在主 Agent 会与其他任务冲突

3. **可扩展性**
   ```
   分类 Agent (当前)
     ↓ 文本分类
   视觉 Agent (未来)
     ↓ 图像识别
   多模态融合 Agent (未来)
     ↓ 综合判断
   ```

4. **测试与优化便利**
   - 可以单独测试分类准确率
   - 可以 A/B 测试不同提示词
   - 不影响主 Agent 的稳定性

## 实施设计

### 新增 Agent: `dimension_classifier`

**定位：** 尺寸标注分类专家

**职责：**
- 判断文本项是否为尺寸标注
- 识别工程符号（⌀, R, ⊥, H7 等）
- 给出分类理由和置信度

**System Prompt 结构：**
```
你是机械图纸尺寸标注分类专家。

## 工程符号知识库
- 直径/半径: ⌀ φ Φ, R
- 形位公差: ⊥ ∥ ▭ ◯ ⌖
- 配合代号: H7, k6, JS7
- ...

## 分类标准
1. 有数字 + 符号 → 尺寸
2. 纯数字 + 合理范围 → 可能尺寸
3. 图号/技术要求 → 非尺寸
4. ...

## Few-shot 示例
[输入: "⌀50±0.1"] → [输出: DIMENSION, 理由: 有直径符号和公差]
[输入: "技术要求"] → [输出: NON_DIMENSION, 理由: 标题文本]
```

**输入输出：**
```json
输入: {
  "textItems": [
    { "text": "⌀50±0.1", "x": 100, "y": 200 },
    { "text": "图号", "x": 50, "y": 50 }
  ]
}

输出: {
  "classifications": [
    { "text": "⌀50±0.1", "category": "DIMENSION", "confidence": 0.95, "reasoning": "..." },
    { "text": "图号", "category": "NON_DIMENSION", "confidence": 0.99, "reasoning": "..." }
  ]
}
```

### 集成方式

**在 Skill 中调用：**
```javascript
// handler.ts (generate_bubbles 模式)
if (mode === 'generate_bubbles') {
  // 1. 解析 PDF 获取所有文本项
  var rawTexts = await ctx.callTool('pdf_extract_all_texts', { filePath });

  // 2. 调用分类 Agent
  var classification = await ctx.callAgent('dimension_classifier', {
    textItems: rawTexts
  });

  // 3. 过滤出尺寸标注
  var dimensions = classification.classifications
    .filter(c => c.category === 'DIMENSION' && c.confidence > 0.7)
    .map(c => createDimension(c));

  // 4. 后续流程不变...
}
```

### Agent 配置结构

```
workspace/config/agents/
  dimension_classifier/
    AGENT.md
    system.prompt
    (可选) examples.md
```

### 工作流变化

**当前：**
```
PDF → 规则提取尺寸 → Agent LLM 过滤 → 检验项目
```

**改进后：**
```
PDF → 提取所有文本 → 分类 Agent → 尺寸标注 → 主 Agent 过滤 → 检验项目
```

## 实施步骤

### Step 1: 创建 Agent 配置
- `workspace/config/agents/dimension_classifier/AGENT.md`
- 定义职责、输入输出格式

### Step 2: 实现 System Prompt
- 工程符号知识库
- 分类标准
- Few-shot 示例

### Step 3: 注册 Agent
- 在 `main/src/agent/agent-registry.service.ts` 中注册
- 或在 workspace/config/agents/registry.json 中配置

### Step 4: Skill 集成
- 修改 `drawing-dimension-inspector` handler
- 在解析阶段调用分类 Agent

### Step 5: 测试优化
- 用真实图纸测试分类准确率
- 调整 System Prompt
- 优化置信度阈值

## 预期效果

| 指标 | 当前 | 改进后 |
|------|------|--------|
| 分类准确率 | ~70% (规则) | ~90% (LLM) |
| 检验项目遗漏率 | 50% | <20% |
| 主 Agent Token 消耗 | 基准 | 不变 |
| 可测试性 | 低 | 高 |
| 可复用性 | 低 | 高 |

## 总结

**推荐独立智能体方案**，因为：

1. ✅ 职责清晰：分类 vs 过滤是不同任务
2. ✅ 知识隔离：工程符号知识不影响其他任务
3. ✅ Token 高效：只在需要时调用
4. ✅ 可扩展：未来可加视觉能力
5. ✅ 可测试：独立优化分类准确率

实施复杂度适中，效果显著，是更优的架构选择。
