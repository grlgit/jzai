# solver/main.py — FastAPI + OR-Tools 求解伴侣服务（简版骨架）
# 与见智平台同一 compose 网络部署，APP 经 http://sched-solver:8100 访问。
from fastapi import FastAPI, Header, HTTPException
import os, uuid, threading

app = FastAPI()
API_KEY = os.environ["SOLVER_API_KEY"]
JOBS: dict[str, dict] = {}


def solve_async(job_id: str, payload: dict):
    """后台求解线程。真实实现：按 payload(orders/resources/params) 建 CP-SAT 模型。

    关键要求：
    - warm-start：payload 带 hint（baseline 解）时 solver.AddHint()，增量调整秒级返回；
    - 时间预算：solver.parameters.max_time_in_seconds = payload.get("timeLimitSec", 60)。

    from ortools.sat.python import cp_model
    model = cp_model.CpModel()
    # …建模式…
    solver = cp_model.CpSolver()
    status = solver.Solve(model)
    solution = extract(model, solver, status)
    """
    # 骨架：伪解，仅打通协议
    solution = {
        "ops": [],
        "changeoverLossPct": 0.0,
        "maxLeadTimeDays": 0.0,
        "avgWip": 0.0,
        "avgCt": 0.0,
        "echo": {"horizon": payload.get("horizon"), "ops": payload.get("ops", [])},
    }
    JOBS[job_id] = {"status": "done", "solution": solution}


@app.post("/solve")
def submit(payload: dict, x_api_key: str = Header(None)):
    if x_api_key != API_KEY:
        raise HTTPException(401)
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "running"}
    threading.Thread(target=solve_async, args=(job_id, payload), daemon=True).start()
    return {"jobId": job_id}


@app.get("/solve/{job_id}")
def status(job_id: str, x_api_key: str = Header(None)):
    if x_api_key != API_KEY:
        raise HTTPException(401)
    return JOBS.get(job_id) or {"status": "unknown"}
