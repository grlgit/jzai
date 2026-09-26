# KBS（TS 智识库）完整测试用例清单

测试环境：本地 docker 栈，main 已切换至 kbs（`http://kbs:8000` / `http://kbs:3011`）。
入口：UI http://localhost:8899 ｜ kbs API http://localhost:8100 ｜ kbs MCP http://localhost:3111/mcp

约定：✅=通过 ⬜=未测 ⚠️=已知限制/偏差（见文末「已知行为清单」）

---

## 1. 服务基础

| # | 用例 | 操作 | 预期 |
|---|---|---|---|
| 1.1 | API 健康 | `curl localhost:8100/health` | `{"status":"ok"}` |
| 1.2 | 版本 | `curl localhost:8100/version` | 返回 version.json 内容（含 component:"kb"） |
| 1.3 | MCP 健康 | `curl localhost:3111/health` | `{"status":"ok"}` |
| 1.4 | schema 自检 | 停掉 PG 后启动 kbs | 启动失败并提示缺表/先跑 main migration |
| 1.5 | main 集成健康 | `curl localhost:8899/api/setup/health` | `kb.status = "ok"` |

## 2. REST API（直连 kbs:8100）

| # | 用例 | 操作 | 预期 |
|---|---|---|---|
| 2.1 | KB 列表 | `GET /v1/knowledge-bases` | 静态单例 `default/Enterprise Mind`，source/wiki 计数正确 |
| 2.2 | 文档列表 | `GET /v1/knowledge-bases/default/documents` | 数组，字段与 Python 版一致（tags 数组、metadata 对象） |
| 2.3 | 按目录过滤 | `GET .../documents?path=/wiki/` | 仅 /wiki/ 下文档 |
| 2.4 | 文档详情 | `GET /v1/documents/{id}` | 200；不存在 → 404 `{detail}` |
| 2.5 | 文档内容 | `GET /v1/documents/{id}/content` | id/filename/path/content/file_type |
| 2.6 | 下载链接 | `GET /v1/documents/{id}/url` | `{url: ".../v1/files/<relative>"}` |
| 2.7 | 文件下载 | `GET /v1/files/{relative}` | 200 + 正确 Content-Type + ETag；再次请求带 If-None-Match → 304 |
| 2.8 | Range 下载 | `curl -H "Range: bytes=0-99"` | 206 + Content-Range，前 100 字节一致 |
| 2.9 | 路径穿越 | `GET /v1/files/../../etc/passwd` | 404（防穿越生效） |
| 2.10 | 用户信息 | `GET /v1/me` | 固定本地用户 profile |
| 2.11 | 用量 | `GET /v1/usage` | 文档数/页数/存储统计正确 |
| 2.12 | extractions 兼容 | `GET /v1/documents/{id}/extractions` | 501（sqlite-only 兼容响应） |

## 3. 签名与身份（HMAC X-JZ-*）

| # | 用例 | 操作 | 预期 |
|---|---|---|---|
| 3.1 | 无签名放行 | 直接 curl 任意 GET | 本地 fail-open，正常响应 |
| 3.2 | 合法签名 | 按 canonical 签名（main 同算法）请求 | 200 |
| 3.3 | 篡改签名 | 改签名末位 | 401 `Invalid internal authentication signature` |
| 3.4 | 头不全 | 只发 X-JZ-User | 401 `Incomplete internal authentication headers` |
| 3.5 | 过期时间戳 | ts 偏差 >300s | 401 `timestamp expired` |
| 3.6 | main 代理链路 | UI 登录后访问知识库（走 /api/kb 代理） | 浏览/搜索正常（说明 main↔kbs 签名互通） |

## 4. 权限矩阵（分类 scope）

前置：`scripts/test-kb-e2e.sh` 已建部门/分类/授权（或直接复跑该脚本）。

| # | 用例 | 操作 | 预期 |
|---|---|---|---|
| 4.1 | 管理员 | admin 经 /api/kb 列文档 | 可见全部（ADMIN_ALL） |
| 4.2 | 部门授权 | 张三（生产部）列文档 | 可见 /production + 公共 + 个人；不可见 /sales、/confidential |
| 4.3 | 工作组+继承 | 张三经质量专项组 | 可见 /production/quality（子级继承） |
| 4.4 | 越权直读 | 张三 GET 机密文档 id | 404（不暴露存在性） |
| 4.5 | 个人文档 | 张三的个人笔记 | 仅本人与管理员可见 |
| 4.6 | 搜索过滤 | 张三搜索"利润率" | 机密文档不出现在结果 |
| 4.7 | 空 scopes | 无授权用户（scopes 非空但无匹配分类） | 仅公共（category 空）+ 本人文档 |
| 4.8 | e2e 回归 | `bash scripts/test-kb-e2e.sh` | exit=0 全绿 |

## 5. 文档处理管线（上传 → pending → ready）

上传方式：UI 知识库上传，或 `curl -F "file=@f" -F "path=/sources/" localhost:8899/api/kb/v1/upload`

| # | 用例 | 预期 | 验证点 |
|---|---|---|---|
| 5.1 | md/txt | 即时 ready | content 入库 + chunks 生成 + 搜索命中 |
| 5.2 | 文本型 PDF | ready，parser=pdfjs | pages 逐页、page_count 正确、页内容可读 |
| 5.3 | 扫描版 PDF | ready，**parser=tesseract** | 中文内容被 OCR 出（允许个别错字）、可按关键词搜索到 |
| 5.4 | 图片（png/jpg） | ready，parser=tesseract | 图中文字入库可搜索 |
| 5.5 | docx | ready，**parser=mammoth**，单页 | 正文完整（标题/段落），可搜索 |
| 5.6 | pptx | ready，**parser=pptx-xml** | **每 slide 一页**（pages 表页码与 slide 对应） |
| 5.7 | xlsx/xls | ready，parser=xlsx | 每 sheet 一页，单元格 `\|` 连接 |
| 5.8 | html | ready，parser=webmd | 正文提取（script/style/nav 去除） |
| 5.9 | doc/ppt 旧格式 | status=**failed** | error_message 引导"请转换为 docx/pptx" |
| 5.10 | 同路径重复上传 | 覆盖（relative_path 冲突） | 不产生重复文档，内容更新 |
| 5.11 | 大 PDF（50+ 页） | 队列串行处理不阻塞 API | 处理期间 /health 与搜索响应正常 |
| 5.12 | 损坏文件 | status=failed | error_message 有明确原因，服务不崩 |

## 6. MCP 工具（Agent 链路）

验证方式：聊天中让 AI 使用知识库工具；或 `node kbs/scripts/smoke-kb-mcp.mjs http://localhost:3111/mcp`

| # | 用例 | 预期 |
|---|---|---|
| 6.1 | ping | pong |
| 6.2 | guide | 含语言指令、分类树、KB 列表（slug=default） |
| 6.3 | search list | sources/wiki 分组 + 编译状态标注 |
| 6.4 | search 关键词 | 命中 chunk 片段 + 页码 + [view] 链接 |
| 6.5 | search references | cites/links_to/backlinks 正确 |
| 6.6 | search uncited/stale | 未被引源文档、过期页面清单 |
| 6.7 | search digest | ≤1500 字知识摘要 |
| 6.8 | read 单篇 | 头部元信息 + 内容 + backlinks |
| 6.9 | read glob 批量 | 多篇合并，120k 预算截断提示 |
| 6.10 | read 分页 | `pages="1-3"` 仅返回指定页（PDF/pptx） |
| 6.11 | write create | 建档 + 落盘（wiki/ 下可见文件） |
| 6.12 | write 缺 title/tags | 返回校验错误 |
| 6.13 | write 重复创建 | 提示 already exists；overwrite=true 可覆盖 |
| 6.14 | write str_replace | 精确替换 1 处；多匹配/无匹配报错 |
| 6.15 | write append | 内容追加成功 |
| 6.16 | wiki 页脚注引用 | references 建立 cites 边 ⚠️（被引文件名须不含 `-`，见已知#2） |
| 6.17 | delete 单篇/glob | DB+磁盘同步删除；overview.md/log.md 保护 |
| 6.18 | delete `*` | 拒绝 |
| 6.19 | query | 返回完整文档内容（含 frontmatter 剥离），预算截断 |
| 6.20 | query tags | 按标签组合过滤 |
| 6.21 | 聊天链路 e2e | 对话中提问知识库内容，AI 能检索并引用（观察 main 日志 MCP 调用） |
| 6.22 | 权限注入 | 非 admin 用户的对话检索结果受分类授权过滤 |

## 7. 平台集成点

| # | 用例 | 操作 | 预期 |
|---|---|---|---|
| 7.1 | /api/kb 代理 | UI 知识库全部操作 | 与直连 kbs 结果一致 |
| 7.2 | /kb-api 直连下载 | UI 文档下载按钮 | 文件正确下载（走 next rewrite） |
| 7.3 | 定时任务 | main 日志观察 2h/6h | KbService 维护任务不报错 |
| 7.4 | analytics 统计 | 仪表盘知识库统计卡 | 数字与 DB 一致 |
| 7.5 | OCR 引擎2（聊天附图） | 聊天上传 PDF/图片提问 | 经 kbs 提取文本后可问答 |
| 7.6 | 个人知识整理 | 触发 personal-knowledge/compile | overview.md 生成/更新 |
| 7.7 | 企业知识编译 | 等 6h 任务或重启后观察 | /wiki/overview.md 更新 |

## 8. 运维

| # | 用例 | 操作 | 预期 |
|---|---|---|---|
| 8.1 | hotfix | 改 kbs 源码后 `bash docker_gen/hotfix.sh` | dist 更新 + 容器重启 + 健康恢复 |
| 8.2 | 依赖变更 hotfix | package.json 变更后 hotfix | 容器内自动 npm ci |
| 8.3 | 崩溃恢复 | `docker kill --signal=KILL docker_gen-kbs-1` | restart 策略拉起，数据无损 |
| 8.4 | 日志 | `docker logs docker_gen-kbs-1` | 请求日志 + 处理失败含文档名与原因 |
| 8.5 | 切回 Python kb | system.json/compose 还原 + `docker compose up -d main` | 旧链路恢复可用（回退预案验证） |

---

## 已知行为清单（非 bug，测试时预期如此）

1. **极小文档无 chunks**：内容 <128 字符（token 估算 <32）的文档不产生 chunks，`search` 查不到但 `query`（content 兜底）可查。与 Python 一致。
2. **脚注文件名含 `-` 截断**：`[^1]: qilin-yield-report.md` 会在首个 `-` 截断导致引用边丢失（Python 上游 bug，忠实保留，待决策是否修）。
3. **MCP 写的文档无 chunks**：经 MCP write 创建的文档 search 查不到（query 可查），REST/上传建的文档正常。与 Python 一致。
4. **docx 单页语义**：mammoth 无真实分页，引用页码恒为 p.1（原 LibreOffice→PDF 分页不再）。pptx 按 slide 分页保留。
5. **tessdata_fast 中文精度**：小字号/手写体中文 OCR 有个别错字（良→腿、报→罗 级）；英文/印刷体良好。高精度需求配 MISTRAL_API_KEY 走云端。
6. **空 scopes 头 401**：X-JZ-Scopes 为空字符串时按"头不全"401（与 Python 中间件一致）；main 侧对无权限用户本就不会签空 scopes。
7. **bulk-delete 硬删除**：批量删除物理删除行（不可恢复），单篇删除是 archived 软删。与 Python pg_local 一致。
