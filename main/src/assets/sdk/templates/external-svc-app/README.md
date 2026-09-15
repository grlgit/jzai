# external-svc-app — 外部服务模式模板（CP-SAT 生产排程）

原生求解库 / 分钟级长任务 / LLM 交互式调优的标准做法：**求解跑在包外容器，APP 只做
编排与交互**。

## 架构

```
docker compose（同一网络）:
  ├─ jianzhi（见智平台）              ← 本 APP 安装于此
  └─ sched-solver（FastAPI + OR-Tools） ← 求解伴侣服务，solver/ 目录附源码，与 .jzapp 分开部署

APP 包内（三层形态）:
  ├─ backend/lib/    服务层：SolverClient（fetch 提交/轮询，AbortSignal.timeout）
  │                  + JobManager（异步轮询落库、metrics 摘要、impact diff、confirmToken 门）
  ├─ backend/index.ts ScheduleController（面板通道，invoke 白名单 7 个 handler）
  │                  + ScheduleToolProvider（agent 通道，es_* 5 个工具）
  ├─ pages/SchedulePanel.tsx  4 页签：排程设定 / 资源确认 / 订单确认 / 排程
  └─ agents/es_planner.yaml   排程规划师（reasoning 档，"初排→检查→调优→确认"循环）
```

## 部署步骤

1. **先起 solver 容器**：`solver/README.md` 里的 compose 片段并入部署，`SOLVER_API_KEY` 记好。
2. **构建安装包**：`node ../../build.mjs && node ../../package-app.mjs` → 安装 `.jzapp`。
3. **配置连接**：安装时填写 `solverEndpoint`（默认 `http://sched-solver:8100`）与
   `solverApiKey`（与 compose 的 `SOLVER_API_KEY` 一致；secret 字段落库加密、注入时已解密）。

## LLM 交互式调优设计要点

- **摘要给 LLM / 全量给面板**：`es_metrics`/`es_impact` 只返回聚合指标（受
  `tokenLimits` 预算约束）；全量解（甘特/明细）只经 `ScheduleController.getJob` 给面板。
- **原子 what-if**：调整被翻译为不可再分的操作集（`insert_order` / `change_due` /
  `change_priority` / `lock_resource` / `disable_resource`），每次预演是一个 scenario job，
  面板手工调整与 agent 调优**走同一套 jobs/scenario 机制**，互不打架。
- **confirmToken 落库门**：`es_impact` 对比 scenario 与 baseline 后签发 token
  （绑定 impact 摘要、10 分钟有效、一次性）；`es_apply`/`applyResult` 无有效 token 拒绝——
  LLM 只能提议，落库必经人确认。agent 的 soul 里写死了"绝不自行落库"纪律。
- **warm-start 要求**：scenario 预演带 baseline 解作 hint，求解服务 `AddHint()` 后
  增量调整应秒级返回——否则交互式调优的对话节奏不成立（见 `solver/main.py` 注释）。
- **第三方数据**：`syncResources` 演示经 `ctx.tools.call('mcp', …)` 读 ERP（通道②，
  须在 manifest `usesPlatformTools` 声明 `mcp`）；agent yaml 直接引用平台工具是通道①。

## 使用

```bash
cp -r templates/external-svc-app my-app && cd my-app
# 改 manifest 的 appId/shortName/nsPrefix 及全部 es 前缀标识符（es_*/es:*/esXxx）
node ../../build.mjs && node ../../package-app.mjs
```
