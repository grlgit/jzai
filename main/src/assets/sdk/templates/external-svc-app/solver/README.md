# sched-solver — 求解伴侣服务

独立于 `.jzapp` 部署的 FastAPI + OR-Tools 容器。见智 APP（external-svc-app）经
`configSchema.solverEndpoint`（默认 `http://sched-solver:8100`）+ `solverApiKey` 访问它。

## 为什么独立部署

见智 APP 包不允许原生依赖，CP-SAT（OR-Tools）是原生库，必须以**外部服务模式**运行：
APP 只负责提交/轮询 HTTP，求解在本容器内完成。

## 部署（docker compose 追加片段）

```yaml
services:
  sched-solver:
    build: ./solver            # 本目录
    environment:
      - SOLVER_API_KEY=change-me   # 与安装 APP 时填写的 solverApiKey 一致
    # 与 jianzhi（见智平台）同一 compose 网络，APP 经 http://sched-solver:8100 访问
```

## 协议

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/solve` | 提交求解（Header `X-API-Key`），立即返回 `{ jobId }` |
| GET | `/solve/{jobId}` | 查询状态：`running` / `done`（含 `solution`）/ `unknown` |

`main.py` 为协议骨架（伪解）。真实实现在 `solve_async()` 内按 payload 建 CP-SAT 模型，
并支持 **warm-start**（payload 带 baseline 解作 hint 时 `AddHint()`，增量调整秒级返回）——
这是 LLM 交互式调优"原子 what-if 预演"体验的前提。
