# panel-app — 最小面板型模板

包含：单面板 + agent 绑定。无后端、无数据库——理解面板契约的最小样本。

## 使用

```bash
cp -r templates/panel-app my-app && cd my-app
# 修改 manifest.json 的 appId/shortName/nsPrefix（必须全局唯一）
node ../../build.mjs       # 或把 build.mjs 拷进工程后 node build.mjs
node ../../package-app.mjs # 产出 .jzapp
```

然后经设置页"安装应用"或 Dev MCP 的 `jd_install_app` 安装。

## 要点

- `nsPrefix: pa` —— 改包时必须同步改 manifest 中所有 `pa`/`pa:`/`pa_` 前缀
- 面板经 `onMessage` 与 agent 对话；`initialData` 接收 agent 推送
- 面板没有 backend 时也可以调平台 REST（`sdk-lib/panel-api.ts` 的 `platformFetch`）
