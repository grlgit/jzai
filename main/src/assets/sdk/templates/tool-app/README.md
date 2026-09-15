# tool-app — 平台工具复用模板

展示复用平台已有工具的**双通道**（PDF 报表场景）：

- **通道①（优先）**：`agents/ta_assistant.yaml` 的 `tools:` 直接列 `generate_pdf`、`dashboard_widget`——agent 即可用自然语言生成报表，零新代码。
- **通道②**：manifest 声明 `usesPlatformTools`，backend 经 `ctx.tools.call('generate_pdf', …)` 在代码中调用（见 `backend/index.ts` 的 `ReportController.makePdf`）。

另含一个自定义工具示例：`ta_text_summary`（借 `ctx.llm.call` 做文本摘要）。

## 使用

```bash
cp -r templates/tool-app my-app && cd my-app
# 改 manifest 的 appId/shortName/nsPrefix 及全部 ta 前缀标识符
node ../../build.mjs && node ../../package-app.mjs
```

注意：usesPlatformTools 白名单分 L1（数据生成）/L2（连接器只读）/L3（界面控制）级，
shell/文件/凭据类工具永不放行。
