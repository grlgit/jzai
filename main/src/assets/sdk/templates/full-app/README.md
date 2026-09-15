# full-app — 完整型模板（备忘本）

覆盖 APP 全部要素的最小完整样本：面板 + agent + skill + 数据库迁移 + backend controller。

## 结构

```
manifest.json                     # 声明全部要素（database/migrations/backend/agents/skills/panels）
migrations/001_create_notes.sql   # 建表 fa_notes
migrations/002_seed_notes.sql     # 种子两条示例
backend/index.ts                  # FullAppModule：NoteToolProvider(fa_note_add) + NoteController
pages/NotePanel.tsx               # 列表 + 新增 + 删除（经 invoke 调 controller）
agents/fa_assistant.yaml          # 助手，tools 含 fa_note_add
skills/fa-format/SKILL.md         # 纯提示规范：教 agent 把笔记整理为 Markdown 清单（无 handler）
types/ sdk-lib/                   # 从 SDK 拷入，勿改
tsconfig.backend.json             # build.mjs 用它编译 backend → dist/backend
```

## 使用

```bash
cp -r templates/full-app my-app && cd my-app
# 改 manifest 的 appId/shortName/nsPrefix 及全部 fa 前缀标识符（fa_*/fa:*/faXxx）
node ../../build.mjs && node ../../package-app.mjs
```

## 要点

- 数据库：manifest 声明 `database.schemaName` 后，迁移按 `migrations[]` 版本顺序执行；SQL 用裸表名（search_path 已固定到本应用 schema）。
- 双通道数据流：面板 → `NoteController`（invoke 白名单）；agent → `fa_note_add` 工具。两侧写同一张表，面板经 `initialData`/轮询刷新。
- skill 目录经 `skills[]` 声明即随包安装，无需代码。
- `nsPrefix: fa` —— 工具 `fa_note_add`、agent `fa_assistant`、权限 `fa:use`、面板 `faMain`，改包时须全局同步替换。
