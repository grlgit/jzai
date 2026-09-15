# 见智 CoWorker - Electron 客户端

见智 CoWorker Windows 原生应用 - Electron 工程骨架。

## 目录结构

```
coworker-app/
├── main.js           # Electron 主进程
├── renderer/         # 渲染进程
│   ├── index.html    # 品牌壳页面
│   └── renderer.js  # 渲染进程逻辑
├── resources/        # 打包资源 (TODO)
│   ├── openclaw/     # OpenClaw 运行时
│   └── extensions/   # jianzhi-bridge 插件
└── package.json
```

## 开发模式运行

```bash
cd coworker-app
npm install
npm run dev
```

## 打包 Windows 安装器

```bash
npm run build:win
```

产出: `dist/见智CoWorker-Setup-x64.exe`

## 功能 (P1)

- ✅ 品牌窗口 (见智 UI)
- ✅ 托盘图标
- ✅ Gateway 子进程管理
- ✅ 激活流程 (token 输入 / jzai:// 深链)
- 🔄 webview → control-ui
- ⏳ 微信插件扫码

## 待完成 (P1)

1. **资源打包**: OpenClaw 运行时 + jianzhi-bridge 插件
2. **图标资源**: 托盘图标、应用图标
3. **C.2**: Gateway 崩溃重启逻辑
4. **C.3**: 激活后插件复制逻辑完善
