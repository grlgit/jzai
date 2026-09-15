/**
 * SolverClient —— 外部求解服务（sched-solver）的 HTTP 客户端。
 * 提交必须快（求解是异步的）；状态查询同样短超时，由 JobManager 负责轮询节奏。
 */
export class SolverClient {
  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  /** 提交求解，返回求解方 jobId */
  async submit(payload: unknown): Promise<string> {
    const r = await fetch(`${this.baseUrl}/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`solver submit failed: ${r.status}`);
    return (await r.json()).jobId;
  }

  /** 查询求解状态：{ status: 'running' | 'done' | 'unknown', solution? } */
  async status(jobId: string): Promise<{ status: string; solution?: any }> {
    const r = await fetch(`${this.baseUrl}/solve/${jobId}`, {
      headers: { 'X-API-Key': this.apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`solver status failed: ${r.status}`);
    return r.json();
  }
}
