# LLM Wiki 企业知识库 — 部署与运维手册

## 目录

- [架构概览](#架构概览)
- [镜像生成](#镜像生成)
- [部署](#部署)
- [初始化配置](#初始化配置)
- [Obsidian 兼容格式](#obsidian-兼容格式)
- [搜索模式](#搜索模式)
- [日常使用](#日常使用)
- [运维管理](#运维管理)
- [故障排查](#故障排查)

---

## 架构概览

```
┌─────────────────────────────────────────────────────┐
│                    Docker 容器                        │
│                                                     │
│  ┌─────────┐   ┌─────────┐   ┌──────────────────┐  │
│  │ Web UI  │   │  API    │   │   MCP Server     │  │
│  │ :3000   │   │ :8000   │   │   :8080          │  │
│  │ Next.js │   │ FastAPI │   │   FastMCP (HTTP)  │  │
│  └────┬────┘   └────┬────┘   └────────┬─────────┘  │
│       │              │                 │            │
│       └──────────────┼─────────────────┘            │
│                      │                              │
│              ┌───────┴───────┐                      │
│              │   /workspace  │  ← 挂载卷            │
│              │               │                      │
│              │  SCHEMA.md    │  ← 企业配置          │
│              │  /raw/...     │  ← 源文件            │
│              │  /wiki/...    │  ← 生成的Wiki        │
│              │  /.llmwiki/   │  ← SQLite索引        │
│              └───────────────┘                      │
└─────────────────────────────────────────────────────┘
         │
         │  MCP (HTTP JSON)
         ▼
┌─────────────────┐
│  Claude / Agent  │  ← 外部AI代理
└─────────────────┘
```

**核心组件：**

| 组件 | 端口 | 功能 |
|------|------|------|
| Web UI | 3000 | 文件浏览、Wiki 查看、知识图谱 |
| API | 8000 | REST API、文件索引、内容提取 |
| MCP | 8080 | AI Agent 工具接口（search/read/write/query） |

---

## 镜像生成

### 前提条件

- Docker 20.10+
- 构建机器至少 4GB 内存

### 构建命令

```bash
# 进入镜像生成目录
cd img_gen

# 构建镜像
docker build -t llmwiki:latest .

# 带版本标签
docker build -t llmwiki:1.0.0 -t llmwiki:latest .
```

### Dockerfile 说明

镜像包含三个服务（Web + API + MCP），通过 `docker-entrypoint.sh` 统一启动。

```bash
# 查看镜像大小
docker images llmwiki
```

### 多平台构建（可选）

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t llmwiki:latest --push .
```

---

## 部署

### 方式一：Docker Compose（推荐）

```yaml
# docker-compose.yml
version: '3.8'
services:
  llmwiki:
    image: llmwiki:latest
    ports:
      - "3000:3000"   # Web UI
      - "8000:8000"   # API
      - "8080:8080"   # MCP
    volumes:
      - ./workspace:/workspace    # 知识库数据（持久化）
    environment:
      - WORKSPACE_PATH=/workspace
      - WIKI_LANGUAGE=zh
      # 可选：PDF OCR 后端
      # - PDF_BACKEND=mistral
      # - MISTRAL_API_KEY=your-key
    restart: unless-stopped
```

启动：

```bash
# 首次启动
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止
docker-compose down
```

### 方式二：Docker Run

```bash
docker run -d \
  --name llmwiki \
  -p 3000:3000 \
  -p 8000:8000 \
  -p 8080:8080 \
  -v $(pwd)/workspace:/workspace \
  -e WORKSPACE_PATH=/workspace \
  -e WIKI_LANGUAGE=zh \
  --restart unless-stopped \
  llmwiki:latest
```

### 方式三：本地开发模式（无 Docker）

```bash
# 启动 MCP 服务
cd mcp
source ../api/.venv/bin/activate
python -m local_server --workspace /path/to/workspace --http --port 8080

# 启动 API（另一个终端）
cd api
source .venv/bin/activate
WORKSPACE_PATH=/path/to/workspace python -m uvicorn main:app --port 8000

# 启动 Web（另一个终端）
cd web
npm run dev
```

### 端口说明

| 端口 | 服务 | 外部访问 |
|------|------|----------|
| 3000 | Web UI | 浏览器访问 |
| 8000 | API | 前端调用，可选暴露 |
| 8080 | MCP | AI Agent 连接 |

如果只需 MCP（无 Web UI），可只映射 8080 端口。

---

## 初始化配置

### 1. 创建 SCHEMA.md

在 workspace 根目录创建 `SCHEMA.md`，定义企业组织架构：

```bash
# 复制样本
cp SCHEMA.md.sample workspace/SCHEMA.md

# 编辑配置
vim workspace/SCHEMA.md
```

### 2. SCHEMA.md 结构

```markdown
---
organization:
  name: 公司名称
  slug: company-slug
  language: zh              # Wiki 生成语言

roles:
  admin:                    # 超级管理员
    - admin@company.com
  members:                  # 普通成员
    - user1@company.com
    - user2@company.com

departments:
  销售部:
    slug: sales
    members:
      - user1@company.com
    editors:
      - user1@company.com
    head: user1@company.com
    subdirectory_attribute: customer    # 子目录代表客户名
    subdirectory_label: 客户

  技术研发:
    slug: tech
    members:
      - user2@company.com
    editors:
      - user2@company.com
    subdirectory_attribute: product_line
    subdirectory_label: 产品线

workgroups:                 # 跨部门工作组（可选）
  项目组A:
    slug: project-a
    members:
      - user1@company.com
      - user2@company.com
    grant_access:
      - path: /raw/技术研发/
        role: viewer

directories:
  /raw/销售部:
    scope: department
    department: 销售部
    subdirectories:
      - 客户A
      - 客户B

  /raw/技术研发:
    scope: department
    department: 技术研发
    subdirectories:
      - 产品线1
      - 产品线2

  /raw/个人:
    scope: personal
    auto_create: true
    naming: email_prefix

global_resources:
  description: 根目录存放全局文档
  expected_files:
    - 企业文化手册.pdf
    - 管理制度.pdf

wiki:
  mirror_raw_structure: true

agent:
  email_style_sources:
    - /企业文化手册.pdf
  customer_query_priority:
    - /raw/销售部/{customer}/
    - /
---

# 公司名称 知识库

知识库描述内容...
```

### 3. 目录结构规划

```
/workspace/
├── SCHEMA.md                   ← 必须：企业配置
├── GUIDE.md                    ← 可选：自定义 Agent 指南（个人模式）
├── 企业文化手册.pdf              ← 全局资源（所有人可读）
├── 管理制度.pdf
├── /raw/                       ← 受控资源根目录
│   ├── /raw/销售部/
│   │   ├── /客户A/             ← 子目录名 = 客户名
│   │   └── /客户B/
│   ├── /raw/技术研发/
│   │   ├── /产品线1/
│   │   └── /产品线2/
│   └── /raw/个人/               ← 自动创建
│       ├── /user1/
│       └── /user2/
├── /wiki/                      ← AI 生成（自动）
└── /.llmwiki/                  ← 索引数据（自动）
    └── index.db
```

### 4. 启动/重启生效

```bash
# 修改 SCHEMA.md 后重启容器
docker-compose restart

# 查看初始化日志
docker-compose logs llmwiki | grep "Enterprise init"
```

初始化是**幂等**的：重复启动只做增量更新，不会删除数据。

### 5. 首次安装行为

首次启动时（无 `.initialized` 标记）：
1. 清空旧索引数据库
2. 解析 SCHEMA.md，创建组织/部门/成员
3. 创建物理目录结构
4. 启动文件监控（Watcher）
5. 索引已有文件，标记 access_scope

---

## Obsidian 兼容格式

生成的 Wiki 页面完全兼容 [Obsidian](https://obsidian.md) 的 Properties 和搜索语法。可以直接将 `/wiki/` 目录作为 Obsidian Vault 打开使用。

### Frontmatter 规范

每个 Wiki 页面的 YAML frontmatter 遵循 Obsidian Properties 格式：

```yaml
---
title: LC-Waikiki 包装标准
description: LC Waikiki 客户的包装和标签要求
date: 2025-03-15
aliases:
  - LW包装标准
  - LC Waikiki Packaging
tags:
  - 销售部/LC-Waikiki
  - 包装标准
  - 客户标准
customer: LC-Waikiki
department: 销售部
product_line: 外套
source_files:
  - LC.LUK.ST.001_EN_1.pdf
---
```

**字段说明：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | text | 是 | 页面标题 |
| `description` | text | 是 | 一句话摘要，显示在搜索结果和图谱 |
| `date` | date | 是 | 创建或最后修改日期 (YYYY-MM-DD) |
| `aliases` | list | 否 | 别名，Obsidian 搜索可匹配 |
| `tags` | list | 是 | 标签，至少 2 个。支持嵌套标签 |
| `source_files` | list | 推荐 | 来源文件列表，便于溯源 |
| `customer` | text | 自动 | 客户名（从目录属性提取） |
| `product_line` | text | 自动 | 产品线（从目录属性提取） |
| `department` | text | 自动 | 所属部门 |

### 嵌套标签

使用 `/` 分隔的嵌套标签建立层级关系，符合 Obsidian 的标签语义：

```
tags:
  - 销售部/LC-Waikiki/包装标准
  - 技术研发/外套
  - 品质管理/国标
```

在 Obsidian 中搜索 `tag:销售部` 会同时匹配 `销售部`、`销售部/LC-Waikiki`、`销售部/LC-Waikiki/包装标准`。

### 目录属性

SCHEMA.md 中定义的 `subdirectory_attribute`（如 `customer`、`product_line`）会自动成为 Wiki 页面的 frontmatter 属性：

```
/raw/销售部/LC-Waikiki/包装标准.pdf
                ↓ 生成 Wiki
/wiki/销售部/LC-Waikiki/包装标准.md
  → frontmatter 自动包含: customer: LC-Waikiki
```

在 Obsidian 中使用 `[customer:LC-Waikiki]` 即可搜索该客户的所有页面。

### 交叉引用

Wiki 页面中同时使用 Obsidian wikilink 和标准 markdown 链接：

```markdown
详见 [[concepts/scaling-laws|缩放定律]]（[链接](concepts/scaling-laws.md)）
```

- `[[...]]` — Obsidian 原生链接，支持图谱可视化
- `[text](path.md)` — 标准 markdown，Web UI 可渲染

### 行内标签

在正文中使用 `#标签` 增强 Obsidian 可发现性：

```markdown
本文档涵盖 #包装标准 和 #发货要求 相关规范。
```

### 将 Wiki 目录作为 Obsidian Vault

```bash
# 直接用 Obsidian 打开 wiki 目录
open /path/to/workspace/wiki    # macOS

# 或在 Obsidian 中选择 "Open folder as vault" → 指向 workspace/wiki/
```

Obsidian 会自动识别所有 frontmatter 属性、标签和链接关系。

---

## 搜索模式

系统支持两种搜索后端，通过全局配置切换：

### 配置方式

**方式一：环境变量 / .env**

```bash
SEARCH_MODE=file    # 或 "db"
```

**方式二：SCHEMA.md**

```yaml
organization:
  name: 公司名称
  search_mode: file    # 或 "db"
```

SCHEMA.md 中的设置优先级高于环境变量。

### DB 模式（默认）

```
SEARCH_MODE=db
```

使用 SQLite FTS5 全文搜索引擎：
- 依赖 `.llmwiki/index.db` 数据库
- 搜索对象：文档 chunks（分块索引）
- 优点：速度快，支持语义排序，适合大量文档
- 适用于：完整部署、需要 Web UI、API 驱动的场景

### File 模式（Obsidian 兼容）

```
SEARCH_MODE=file
```

纯文件系统搜索，不依赖数据库：
- 直接扫描 `/wiki/` 目录下的 `.md` 文件
- 解析 YAML frontmatter + 全文内容匹配
- 支持 Obsidian 搜索语法
- 优点：零依赖，与 Obsidian 行为一致，wiki 文件即数据源
- 适用于：轻量部署、与 Obsidian 协同、仅 MCP 访问的场景

### 搜索语法对比

| 语法 | DB 模式 | File 模式 | 说明 |
|------|---------|-----------|------|
| 关键词 | ✅ FTS5 | ✅ 全文匹配 | `包装标准` |
| `tag:xxx` | ✅ 标签过滤 | ✅ Obsidian 嵌套标签 | `tag:销售部` 匹配 `销售部/LC-Waikiki` |
| `path:xxx` | ✅ 路径过滤 | ✅ 路径匹配 | `path:LC-Waikiki` |
| `[prop:val]` | ❌ | ✅ 属性搜索 | `[customer:LC-Waikiki]` |
| `file:xxx` | ❌ | ✅ 文件名匹配 | `file:包装` |
| `-keyword` | ❌ | ✅ 排除 | `标准 -外套` |
| 组合查询 | ✅ 有限 | ✅ 完整 | `tag:销售部 [customer:LC-Waikiki] 包装` |

### MCP 调用示例

两种模式下 MCP 工具调用方式完全相同，系统自动路由到对应后端：

```
# 关键词搜索
search(knowledge_base="xxx", mode="search", query="包装标准")

# 按客户搜索（File 模式最佳）
search(knowledge_base="xxx", mode="search", query="[customer:LC-Waikiki]")
query(knowledge_base="xxx", query="[customer:LC-Waikiki] 发货要求")

# 按标签搜索
search(knowledge_base="xxx", mode="search", query="tag:销售部/LC-Waikiki")
query(knowledge_base="xxx", query="tag:技术研发 工艺参数")

# 按部门搜索
query(knowledge_base="xxx", query="[department:销售部]")

# 组合搜索
search(knowledge_base="xxx", mode="search", query="tag:包装标准 path:LC-Waikiki 外箱")

# 排除搜索
search(knowledge_base="xxx", mode="search", query="标准 -外套 -针织")
```

### 注意事项

- `mode="list"` 和 `mode="references"` 始终使用 DB 模式（需要索引数据）
- File 模式仅对 `mode="search"` 和 `query` 工具生效
- 切换模式后无需重启，下次调用立即生效（SCHEMA.md 修改需重启）
- 两种模式可并存测试：先用 File 模式验证 Obsidian 兼容性，再切回 DB 模式获得更好性能

---

## 日常使用

### 上传文件

**通过 Web UI：**
1. 打开 http://localhost:3000
2. 进入对应知识库
3. 导航到目标目录
4. 点击上传或拖拽文件

**通过文件系统：**
```bash
# 直接复制文件到 workspace 目录
cp 新标准.pdf workspace/raw/销售部/客户A/

# Watcher 自动检测并索引（~500ms）
```

**支持的文件格式：**

| 类型 | 格式 | 处理方式 |
|------|------|----------|
| PDF | .pdf | OCR 提取文字+图片 |
| Office | .docx, .pptx, .doc, .ppt | 转 PDF 后提取 |
| 表格 | .xlsx, .xls | 按 sheet 提取 |
| 文本 | .md, .txt, .csv, .html | 直接索引 |
| 图片 | .png, .jpg, .webp | 标记存储 |

### MCP Agent 连接

**Claude Code / Claude Desktop：**

```json
{
  "mcpServers": {
    "llmwiki": {
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

**通过 stdio（本地直连）：**

```json
{
  "mcpServers": {
    "llmwiki": {
      "command": "bash",
      "args": ["/path/to/mcp/start_mcp.sh"]
    }
  }
}
```

### Agent 常用调用

```
# 查看知识库概览
guide()

# 浏览文件
search(knowledge_base="xxx", mode="list", path="*")

# 按客户搜索
search(knowledge_base="xxx", mode="search", query="客户A 包装标准")

# 按目录搜索
search(knowledge_base="xxx", mode="search", path="/raw/销售部/客户A/")

# 检索完整内容
query(knowledge_base="xxx", query="发货要求", scope="wiki")

# 读取文件
read(knowledge_base="xxx", path="raw/销售部/客户A/标准.pdf", pages="1-10")

# 创建 Wiki
write(knowledge_base="xxx", command="create", path="/wiki/销售部/客户A/",
      title="包装标准.md", content="...", tags=["包装", "客户A"])

# 查找未处理的新文件
search(knowledge_base="xxx", mode="references", query="uncited")

# 查找需要更新的 Wiki
search(knowledge_base="xxx", mode="references", query="stale")
```

### 自动同步（定时任务）

配置 Agent 定时任务（如 OpenClaw）每 5 分钟检查并更新：

**Prompt：**
> 请先调用 guide() 了解工作区配置。然后用 search(mode="references", query="uncited") 查找未处理的新文件，用 search(mode="references", query="stale") 查找需刷新的Wiki页面。如果都没有变更，回复"无变更"即可。如果有变更，按 guide 中的规则读取源文件、创建或更新对应Wiki页面，最后更新 overview 和 log。

**调度：** `*/5 * * * *`

---

## 运维管理

### 数据备份

```bash
# 备份整个 workspace（包含源文件 + Wiki + 索引）
tar czf backup_$(date +%Y%m%d).tar.gz workspace/

# 仅备份索引（可重建）
cp workspace/.llmwiki/index.db backup_index_$(date +%Y%m%d).db
```

### 重建索引

索引是派生数据，可安全删除重建：

```bash
# 停止服务
docker-compose stop

# 删除索引
rm workspace/.llmwiki/index.db
rm workspace/.llmwiki/.initialized

# 重启（自动重建）
docker-compose start
```

### 添加/修改部门

1. 编辑 `workspace/SCHEMA.md`
2. 在 `departments:` 下添加新部门
3. 在 `directories:` 下添加对应目录
4. 重启服务：`docker-compose restart`

```yaml
# 新增部门示例
departments:
  # ...现有部门...
  设计部:
    slug: design
    members:
      - designer@company.com
    editors:
      - designer@company.com
    subdirectory_attribute: brand
    subdirectory_label: 品牌

directories:
  /raw/设计部:
    scope: department
    department: 设计部
    subdirectories:
      - 品牌A
      - 品牌B
```

### 添加/移除成员

1. 编辑 `workspace/SCHEMA.md`
2. 在 `roles.members` 和对应 `departments.*.members` 中增删 email
3. 重启服务

### 权限变更

| 操作 | 修改位置 |
|------|----------|
| 提升为管理员 | `roles.admin` 添加 email |
| 加入部门 | `departments.<部门>.members` 添加 |
| 授权编辑 | `departments.<部门>.editors` 添加 |
| 跨部门授权 | `workgroups` 添加工作组 + `grant_access` |
| 特定目录授权 | `directories.<路径>.extra_viewers` |
| 限制敏感目录 | 新增 `directories` 条目，`scope: restricted` |

### 监控与日志

```bash
# 查看实时日志
docker-compose logs -f --tail=50

# 查看 MCP 请求日志
docker-compose logs llmwiki | grep "MCP\|tool call"

# 查看文件索引活动
docker-compose logs llmwiki | grep "Indexed\|Re-indexed"

# 查看企业初始化状态
docker-compose logs llmwiki | grep "Enterprise init"
```

### 健康检查

```bash
# API 健康
curl http://localhost:8000/health

# MCP 健康
curl http://localhost:8080/health

# MCP 工具调用测试
curl -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping","arguments":{}}}'
```

### 磁盘空间管理

```bash
# 查看 workspace 大小
du -sh workspace/

# 查看索引大小
du -sh workspace/.llmwiki/

# 查看提取缓存（可安全清理）
du -sh workspace/.llmwiki/cache/
rm -rf workspace/.llmwiki/cache/*
```

### 升级

```bash
# 拉取新镜像
docker pull llmwiki:latest

# 重启（数据在挂载卷，不受影响）
docker-compose down
docker-compose up -d

# 验证
docker-compose logs --tail=20
```

---

## 故障排查

### 文件上传后未出现在列表

**原因：** Watcher 未检测到文件，或文件被 ignore 规则过滤。

**排查：**
```bash
# 检查文件是否在忽略列表
cat workspace/.llmwikiignore
cat workspace/.gitignore

# 检查索引状态
sqlite3 workspace/.llmwiki/index.db "SELECT filename, status FROM documents WHERE filename LIKE '%目标文件%'"

# 检查 Watcher 日志
docker-compose logs llmwiki | grep "Indexed\|ignore"
```

### MCP 报错 "Not Acceptable"

**原因：** 客户端未发送正确的 Accept 头。

**解决：** 服务已配置 `json_response=True` + `stateless_http=True`，客户端只需：
```
Content-Type: application/json
Accept: application/json
```

### MCP 搜索返回空

**排查：**
1. 确认传了 `knowledge_base` 参数（调用 `guide()` 获取正确的 slug）
2. 确认文件 status 为 `ready`：
   ```bash
   sqlite3 workspace/.llmwiki/index.db "SELECT filename, status FROM documents WHERE status != 'ready'"
   ```
3. 确认 chunks 已生成：
   ```bash
   sqlite3 workspace/.llmwiki/index.db "SELECT COUNT(*) FROM document_chunks"
   ```

### 权限过滤不生效

**排查：**
```bash
# 检查 SCHEMA.md 是否被解析
sqlite3 workspace/.llmwiki/index.db "SELECT COUNT(*) FROM directory_meta"

# 检查文件的 access_scope
sqlite3 workspace/.llmwiki/index.db "SELECT filename, access_scope FROM documents"

# 手动验证权限解析
sqlite3 workspace/.llmwiki/index.db "SELECT path, scope FROM directory_meta"
```

如果 `directory_meta` 为空，说明 SCHEMA.md 未被解析 — 检查文件格式（必须有 `---` frontmatter）。

### PDF 提取失败

**症状：** 文件 status 为 `failed`。

**排查：**
```bash
sqlite3 workspace/.llmwiki/index.db "SELECT filename, error_message FROM documents WHERE status = 'failed'"
```

**常见原因：**
- LibreOffice 未安装（Office 文件转换需要）
- PDF 加密或损坏
- 内存不足

### 索引损坏

```bash
# 完整重建
docker-compose stop
rm workspace/.llmwiki/index.db
rm workspace/.llmwiki/.initialized
docker-compose start
```

重建后所有文件会被重新索引，Wiki 内容保持不变（存储在文件系统）。

---

## 环境变量参考

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WORKSPACE_PATH` | `.` | workspace 目录路径 |
| `WIKI_LANGUAGE` | `zh` | Wiki 生成语言 |
| `SEARCH_MODE` | `db` | 搜索模式：`db` = SQLite FTS5, `file` = 文件系统 Obsidian 搜索 |
| `WIKI_FORMAT` | `obsidian` | Wiki 格式：`obsidian` = Obsidian 兼容 frontmatter |
| `APP_URL` | `http://localhost:3000` | Web UI URL |
| `API_URL` | `http://localhost:8000` | API URL |
| `MCP_URL` | `http://localhost:8080/mcp` | MCP 端点 URL |
| `PDF_BACKEND` | (空) | PDF 提取后端：空=本地, `mistral`=Mistral OCR |
| `MISTRAL_API_KEY` | (空) | Mistral OCR API Key |

---

## 权限模型速查

| 位置 | 读 | 写 |
|------|----|----|
| `/` 根目录 | 全员 | 仅 admin |
| `/raw/<部门>/` | 部门成员 + admin | 部门 editor + admin |
| `/raw/<部门>/<子目录>/` | 继承父目录 | 继承父目录 |
| `/raw/个人/<用户>/` | 仅本人 + admin | 仅本人 |
| `restricted` 目录 | 明确授权用户 | 明确授权用户 |
| `/wiki/` | 继承对应 `/raw/` | 继承对应 `/raw/` |

**角色层级：**
- `owner/admin` → 全部可读可写
- `editor` → 所属部门可读可写
- `member` → 所属部门可读，不可写
- 工作组授权 → 指定目录可读

---

## 文件结构参考

```
项目根目录/
├── api/                    # FastAPI 后端
│   ├── domain/
│   │   ├── watcher.py      # 文件监控 + access_scope 标记
│   │   ├── schema_init.py  # SCHEMA.md 解析器
│   │   └── local_processor.py  # PDF/Office 内容提取
│   ├── services/           # 业务逻辑层
│   ├── routes/             # API 路由
│   └── infra/db/sqlite.py  # SQLite 数据访问
├── mcp/                    # MCP 服务
│   ├── local_server.py     # 入口 + 企业初始化
│   ├── schema_init.py      # SCHEMA.md 解析器（MCP端）
│   ├── tools/              # MCP 工具（search/read/write/query/guide）
│   └── vaultfs/sqlite.py   # 数据层 + 权限过滤
├── web/                    # Next.js 前端
├── shared/
│   └── sqlite_schema.sql   # 数据库 schema（含企业表）
├── img_gen/                # Docker 镜像构建目录
├── SCHEMA.md.sample        # 企业配置样本
├── MANUAL.md               # 本文档
└── tests/
    └── test_enterprise_integration.py  # 集成测试
```
