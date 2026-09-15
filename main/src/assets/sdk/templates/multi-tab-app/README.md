# multi-tab-app — 多页签面板模板

单面板内 3 页签（概览 / 明细 / 设置），页签间共享一个 `useState` store。无 backend、无数据库——纯面板模式。

## 要点

- **多页签在单面板组件内实现，不注册多个面板**：manifest 只声明一个 `mtMain`，页签是组件内部的本地状态（`tab`）。多个面板入口用于"多个独立功能页面"，页签切换用本模式。
- **共享 store**：三个页签读写同一个 `useState<Store>`——"设置"里改项目名/预算，"概览"卡片立即联动。
- **keepAlive: true**：面板切到后台再回来不卸载重挂载，store 与页签位置都保留。多页签面板务必开启，否则切走即丢状态。
- 页签内容示例有区分度：概览=卡片、明细=表格、设置=表单——可直接替换成业务组件。

## 使用

```bash
cp -r templates/multi-tab-app my-app && cd my-app
# 改 manifest 的 appId/shortName/nsPrefix（mt）及面板 id mtMain
node ../../build.mjs && node ../../package-app.mjs
```
