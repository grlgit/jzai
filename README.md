# 见智·企业AI（JianZhi Enterprise AI）

> 开门见智，工作省事。

见智·企业AI 是一个可私有部署的企业级 AI 平台：以**主智能体**为核心入口，将企业知识、业务系统与行业方法论连接成可调用的能力，并通过**扩展包（APP）机制**把行业能力产品化分发。

## 核心能力

- **主智能体对话**：多智能体协作（数据大师、连接大师、技能大师、图纸大师、知识蒸馏师等），支持工具调用流式呈现、思考过程展示、委派路由
- **企业心智（知识库）**：企业知识架构管理、文档解析与检索、个人知识、分类级权限（ACL）
- **技能（Skills）**：HAR 分析 / API 文档 / 网页录屏自动生成业务操作技能，人机协同确认执行
- **连接（Connectors）**：MCP Server 与自定义工具的可视化管理，数据库直连与 Schema 发现
- **数据仪表**：自然语言生成图表与仪表盘（SQL / API / MCP 数据源）
- **扩展包（APP）**：`.jzapp` 应用包机制——面板 / 智能体 / 技能 / 工具 / 后端控制器一体交付，支持安装、升级、卸载、授权与审计（per-app PostgreSQL schema 隔离）
- **开发 MCP**：运行实例即开发环境——外部 IDE（Cursor / Claude Code / CodeBuddy）经 MCP 完成 APP 脚手架、校验、安装与调试
- **CoWorker（AI 员工）**：Electron 桌面端数字员工，独立部署、远程构建与升级

## 技术架构

```
coworker-app (Electron)  →  web (Next.js)  →  main (NestJS + PostgreSQL + Redis)
                                                 ↓
                                          llm_wiki (FastAPI 知识库服务)
```

| 目录 | 说明 | 技术栈 |
|------|------|--------|
| `main/` | 平台后端（API / 智能体运行时 / 扩展包框架） | NestJS 11 · Node 22 · PostgreSQL · socket.io |
| `web/` | 主台前端 | Next.js 16 · React 19 · Tailwind CSS 4 |
| `llm_wiki/` | 企业心智知识库服务 | FastAPI · SQLite/PostgreSQL · 向量检索 |
| `coworker-app/` | AI 员工桌面端 | Electron · electron-builder |

## 快速开始（开发环境）

**前置**：Node.js 22+、Python 3.11+、PostgreSQL 15+、Redis 7+

```bash
# 1. 后端（端口 18789）
cd main && npm install
cp .env.example .env   # 配置 DATABASE_URL 等
npm run start:dev

# 2. 知识库服务（端口 8000）
cd llm_wiki && pip install -r requirements.txt
uvicorn api.main:app --reload --port 8000

# 3. 前端（端口 3000）
cd web && npm install
npm run dev

# 4. CoWorker 桌面端（可选）
cd coworker-app && npm install && npm start
```

生产部署使用 Docker Compose（部署脚本与编排文件随发行包单独提供）。

## 扩展包（APP）开发

平台能力以 `.jzapp` 扩展包形式分发。开发者**无需本平台源码**：

1. 从运行实例下载 SDK：`GET /api/app-store/sdk.tgz`（类型 / 构建脚本 / 6 个模板，源码见 `main/src/assets/sdk/`）
2. 或连接实例的开发 MCP（`POST /api/dev/mcp`），让 AI 编程助手完成脚手架、校验、安装与调试
3. 安装管理：主台 → 设置 → 应用管理

## 测试

```bash
cd main && npm test          # 后端 Jest 单元测试
cd web && npm run lint       # 前端 ESLint
```

## 许可证

本项目采用 **Business Source License 1.1（BSL 1.1）**，详见 [LICENSE](LICENSE)。

要点：

- **许可方（Licensor）**：见智（menhu.ai）
- **附加使用授权（Additional Use Grant）**：允许为**企业内部业务目的**在生产环境使用；**不得**将本软件以托管服务（SaaS）形式向第三方提供
- **变更日期（Change Date）**：每个版本发布满 **4 年** 之日
- **变更许可证（Change License）**：变更日期起该版本转为 **Apache License 2.0**

> 上述四个变量为当前设定，许可方可按需调整并以仓库 LICENSE 文件为准。

## 商标

「见智」及相关标识为许可方商标，BSL 许可证不构成商标使用授权。
