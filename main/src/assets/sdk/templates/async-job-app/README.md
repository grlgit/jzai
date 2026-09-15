# async-job-app — 异步任务模式模板（批量报表生成）

**为什么需要这个模式**：同步工具调用 / invoke 请求有 ≤30s 超时预算。任何分钟级任务
（批量生成、大数据处理、外部求解）都必须：**提交即返回 jobId → 后台驱动 → 轮询状态**。

## 结构

```
backend/lib/job-manager.ts   # 核心：create() 立即返回；drive() 后台推进（本模板用
                             # setTimeout 每 2 秒一步、5 步完成来模拟，不接真实外部服务）
backend/index.ts             # JobController(createJob/getJob/listJobs) + 工具 aj_job_submit/aj_job_status
pages/JobPanel.tsx           # 创建任务 → 轮询 getJob → 进度条 → 完成展示结果
migrations/001_create_jobs.sql  # aj_jobs：id/type/status/progress/result/created_at/finished_at
```

## 要点

- `create()` 里 `void this.drive(jobId)` **不 await**——同步通道只负责"受理"，不做"执行"。
- 进度落库（`progress` 0-100），面板与 agent 各自轮询，天然共享同一份状态。
- 失败同样落库（`status='failed'` + `result.error`），查询方才有确定终态。
- 真实外部服务场景见 `external-svc-app` 模板（fetch 提交 + 轮询 + AbortSignal.timeout）。

## 使用

```bash
cp -r templates/async-job-app my-app && cd my-app
# 改 manifest 的 appId/shortName/nsPrefix 及全部 aj 前缀标识符
node ../../build.mjs && node ../../package-app.mjs
```
