# 见智 APP 开发 SDK（jz-sdk）

无需见智源码，开发、调试、打包见智 APP（扩展包）。完整文档见《见智 APP 开发者手册》。

## 内容

- `types/` — manifest / 面板 / 后端契约类型（与平台同版本）
- `lib/` — react-shim（共享宿主 React）、jsx-runtime-shim、panel-api（invoke/fetch 助手）
- `build.mjs` — 通用构建（backend tsc → CJS；pages esbuild → ESM）
- `package-app.mjs` — 通用打包（npm ci 生产依赖 → 裁剪 → zip 为 .jzapp）
- `templates/` — 6 个模板：
  - `panel-app` 最小面板型
  - `tool-app` 平台工具复用（双通道）
  - `full-app` 完整型（面板+agent+skill+migrations+controller）
  - `multi-tab-app` 多页签面板
  - `async-job-app` 异步任务模式
  - `external-svc-app` 外部服务模式（CP-SAT 排程 + 求解伴侣容器）

## 快速开始

```bash
cp -r templates/panel-app my-app && cd my-app
# 1) 改 manifest.json：appId / shortName / nsPrefix 必须全局唯一，
#    并同步改所有 nsPrefix 前缀标识符（面板/工具/agent/权限）
# 2) 把 SDK 的 build.mjs、package-app.mjs 拷到工程根（或直接用相对路径调用）
npm install esbuild typescript   # 构建依赖
node build.mjs                   # 产出 dist/
node package-app.mjs             # 产出 <shortName>-<version>.jzapp
```

安装：主台 设置 → 应用管理 → 安装应用；或经见智开发 MCP 让 AI 助手安装调试。

## 约束速记

1. 标识符一律 ASCII 且以 nsPrefix 开头；工具名总长 ≤ 64。
2. 面板共享宿主 React（shim 已配好），禁止打包自己的 React。
3. 运行时依赖：仅纯 JS 且在平台白名单内，打包期 npm ci 随包分发；原生模块禁止（重计算走外部服务模式，见 external-svc-app）。
4. 同步工具调用 ≤ 30s；长任务用异步任务模式（async-job-app）。
5. 密钥走 configSchema 的 secret 字段，运行时 ctx.config 取真值。
