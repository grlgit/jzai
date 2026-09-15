'use client';

import { useState, useEffect } from 'react';
import { useI18n } from '@/i18n';

import { getMainUrl } from '@/lib/env';
const MAIN_URL = getMainUrl();

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

interface DashboardData {
  overview: {
    totalMessages: number; weekMessages: number;
    timeSavedHours: number; totalCost: number;
    satisfactionRate: number; feedbackCount: number;
    localCount: number; cloudCount: number; localRate: number;
    totalTokens: number; totalTokensInput: number; totalTokensOutput: number;
  };
  dailyTrend: { date: string; messages: number; cost: number }[];
  topTools: { name: string; count: number }[];
  userStats: { userId: string; userName: string; messages: number; cost: number }[];
  roi: { cost: number; savedHours: number; ratio: number };
}

interface UserDetail {
  userId: string; userName: string; messages: number; cost: number;
  tokensInput: number; tokensOutput: number; tokensTotal: number;
  localCount: number; cloudCount: number;
  thumbsUp: number; thumbsDown: number;
  tools: { name: string; count: number }[];
  dailyTrend: { date: string; messages: number }[];
}

function StatCard({ label, value, sub, onClick }: { label: string; value: string; sub?: string; onClick?: () => void }) {
  return (
    <div className={`border border-gray-200 rounded-lg p-4 text-center ${onClick ? 'cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/30 transition-all' : ''}`} onClick={onClick}>
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className="text-2xl font-bold font-mono text-indigo-600">{value}</div>
      {sub && <div className="text-xs text-green-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function formatTokens(n: number) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}

const toolLabels: Record<string, string> = {
  search_knowledge: '知识检索', get_character: '获取企业人格',
  get_rules: '获取企业规则', suggest_knowledge: '知识建议', open_system: '打开系统',
};

export default function DashboardPanel() {
  const { t } = useI18n();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [drillUser, setDrillUser] = useState<UserDetail | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);

  const fetchData = () => {
    setLoading(true);
    fetch(`${MAIN_URL}/api/analytics/dashboard`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  const drillDown = (userId: string) => {
    setDrillLoading(true);
    fetch(`${MAIN_URL}/api/analytics/user/${userId}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { setDrillUser(d); setDrillLoading(false); })
      .catch(() => setDrillLoading(false));
  };

  if (loading && !data) return <div className="p-6 text-sm text-gray-400">{t('common.loading')}</div>;
  if (!data) return <div className="p-6 text-sm text-gray-400">{t('dashboard.loadError')}</div>;

  const { overview: o, dailyTrend, topTools, userStats, roi } = data;
  const maxDayMsg = Math.max(...dailyTrend.map(d => d.messages), 1);

  // User drill-down view
  if (drillUser) {
    const u = drillUser;
    const maxDay = Math.max(...u.dailyTrend.map(d => d.messages), 1);
    return (
      <div className="p-6 overflow-y-auto h-full space-y-5">
        <div className="flex items-center gap-3">
          <button onClick={() => setDrillUser(null)} className="text-xs text-indigo-600 hover:underline">{t('common.back')}</button>
          <h2 className="text-base font-semibold">{u.userName} · 使用详情</h2>
        </div>

        <div className="grid grid-cols-4 gap-3">
          <StatCard label={t('dashboard.chatCount')} value={`${u.messages}`} />
          <StatCard label={t('dashboard.tokenUsage')} value={formatTokens(u.tokensTotal)} sub={t('dashboard.tokenIO', { input: formatTokens(u.tokensInput), output: formatTokens(u.tokensOutput) })} />
          <StatCard label={t('dashboard.costLabel')} value={`¥${u.cost}`} />
          <StatCard label={t('dashboard.satisfactionLabel')} value={u.thumbsUp + u.thumbsDown > 0 ? `${Math.round(u.thumbsUp / (u.thumbsUp + u.thumbsDown) * 100)}%` : '--'} sub={`👍${u.thumbsUp} 👎${u.thumbsDown}`} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="border border-gray-200 rounded-lg p-4">
            <div className="text-xs text-gray-400 mb-1">{t('dashboard.localProcess')}</div>
            <div className="text-xl font-bold font-mono">{u.localCount} <span className="text-xs text-green-500 font-normal">¥0</span></div>
          </div>
          <div className="border border-gray-200 rounded-lg p-4">
            <div className="text-xs text-gray-400 mb-1">{t('dashboard.cloudProcess')}</div>
            <div className="text-xl font-bold font-mono">{u.cloudCount} <span className="text-xs text-amber-500 font-normal">¥{u.cost}</span></div>
          </div>
        </div>

        {/* Daily trend */}
        <div>
          <div className="text-xs text-gray-400 mb-2">{t('dashboard.last7days')}</div>
          <div className="border border-gray-200 rounded-lg p-4">
            <div className="flex items-end gap-2 h-16">
              {u.dailyTrend.map((d, i) => (
                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                  <div className="w-full flex flex-col justify-end" style={{ height: 48 }}>
                    <div className="w-full bg-indigo-500 rounded-t min-h-[2px]" style={{ height: `${Math.max((d.messages / maxDay) * 100, 3)}%` }} />
                  </div>
                  <span className="text-[10px] text-gray-400">{d.date}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Tools used */}
        {u.tools.length > 0 && (
          <div>
            <div className="text-xs text-gray-400 mb-2">{t('dashboard.toolUsageLabel')}</div>
            <div className="border border-gray-200 rounded-lg p-4 space-y-1.5">
              {u.tools.map((t, i) => (
                <div key={i} className="flex items-center gap-3 text-sm">
                  <span className="w-20 text-xs text-gray-500 truncate">{toolLabels[t.name] || t.name}</span>
                  <div className="h-3 bg-gray-100 rounded-full flex-1">
                    <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${Math.round(t.count / u.tools[0].count * 100)}%` }} />
                  </div>
                  <span className="text-xs text-gray-400 w-6 text-right">{t.count}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Main dashboard view
  return (
    <div className="p-6 overflow-y-auto h-full space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{t('dashboard.title')}</h2>
        <button onClick={fetchData} className="text-xs text-gray-400 hover:text-gray-600 border border-gray-200 rounded-lg px-3 py-1">{t('common.refresh')}</button>
      </div>

      {/* ROI */}
      <div className="border border-gray-200 rounded-lg p-5 text-center bg-gradient-to-b from-indigo-50/50 to-white">
        <div className="text-xs text-gray-400 mb-1">{t('dashboard.roi')}</div>
        <div className="text-4xl font-bold text-indigo-600 font-mono">{roi.ratio > 0 ? `1 : ${roi.ratio}` : '—'}</div>
        <div className="text-xs text-gray-400 mt-2">{t('dashboard.roiDetail', { cost: roi.cost.toFixed(2), hours: roi.savedHours })}</div>
      </div>

      {/* Overview — clickable cards drill down */}
      <div>
        <div className="text-xs text-gray-400 mb-2">{t('dashboard.overview')} <span className="text-gray-300">{t('dashboard.overviewHint')}</span></div>
        <div className="grid grid-cols-4 gap-3">
          <StatCard label={t('dashboard.aiTasks')} value={`${o.totalMessages}`} sub={t('dashboard.thisWeek', { n: o.weekMessages })}
            onClick={() => userStats.length > 0 && drillDown(userStats[0].userId)} />
          <StatCard label={t('dashboard.tokenUsage')} value={formatTokens(o.totalTokens)} sub={t('dashboard.tokenIO', { input: formatTokens(o.totalTokensInput), output: formatTokens(o.totalTokensOutput) })} />
          <StatCard label={t('dashboard.timeSaved')} value={`${o.timeSavedHours}h`} />
          <StatCard label={t('dashboard.aiCost')} value={`¥${o.totalCost}`} />
          <StatCard label={t('dashboard.satisfaction')} value={o.feedbackCount > 0 ? `${o.satisfactionRate}%` : '--'} sub={o.feedbackCount > 0 ? t('dashboard.feedbackCount', { n: o.feedbackCount }) : t('dashboard.noData')} />
          <StatCard label={t('dashboard.localRate')} value={`${o.localRate}%`} sub="= ¥0" />
          <StatCard label={t('dashboard.roi')} value={roi.ratio > 0 ? `1:${roi.ratio}` : '--'} />
          <StatCard label={t('dashboard.totalTokens')} value={formatTokens(o.totalTokens)} sub={t('dashboard.callCount', { n: o.localCount + o.cloudCount })} />
        </div>
      </div>

      {/* Cost + Token Breakdown */}
      <div className="grid grid-cols-2 gap-3">
        <div className="border border-gray-200 rounded-lg p-4">
          <div className="text-xs text-gray-400 mb-2">{t('dashboard.costBreakdown')}</div>
          <div className="flex gap-4 text-sm">
            <div><div className="text-xs text-gray-400">{t('dashboard.local')}</div><div className="font-bold font-mono">{o.localCount}<span className="text-green-500 text-xs ml-1">¥0</span></div></div>
            <div><div className="text-xs text-gray-400">{t('dashboard.cloud')}</div><div className="font-bold font-mono">{o.cloudCount}<span className="text-amber-500 text-xs ml-1">¥{o.totalCost}</span></div></div>
          </div>
        </div>
        <div className="border border-gray-200 rounded-lg p-4">
          <div className="text-xs text-gray-400 mb-2">{t('dashboard.tokenBreakdown')}</div>
          <div className="flex gap-4 text-sm">
            <div><div className="text-xs text-gray-400">{t('dashboard.input')}</div><div className="font-bold font-mono">{formatTokens(o.totalTokensInput)}</div></div>
            <div><div className="text-xs text-gray-400">{t('dashboard.output')}</div><div className="font-bold font-mono">{formatTokens(o.totalTokensOutput)}</div></div>
            <div><div className="text-xs text-gray-400">{t('dashboard.total')}</div><div className="font-bold font-mono text-indigo-600">{formatTokens(o.totalTokens)}</div></div>
          </div>
        </div>
      </div>

      {/* User ranking — clickable rows */}
      {userStats.length > 0 && (
        <div>
          <div className="text-xs text-gray-400 mb-2">{t('dashboard.userRank')} <span className="text-gray-300">{t('dashboard.userRankHint')}</span></div>
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="text-[11px] text-gray-400 bg-gray-50 border-b">
                <th className="text-left py-2 px-4">{t('dashboard.user')}</th>
                <th className="text-right py-2 px-4">{t('dashboard.chats')}</th>
                <th className="text-right py-2 px-4">{t('dashboard.cost')}</th>
                <th className="text-right py-2 px-4"></th>
              </tr></thead>
              <tbody>
                {userStats.map((u, i) => (
                  <tr key={i} className="border-b border-gray-50 hover:bg-indigo-50/30 cursor-pointer transition-colors" onClick={() => drillDown(u.userId)}>
                    <td className="py-2 px-4">{u.userName}</td>
                    <td className="py-2 px-4 text-right font-mono">{u.messages}</td>
                    <td className="py-2 px-4 text-right font-mono text-amber-500">¥{u.cost}</td>
                    <td className="py-2 px-4 text-right text-xs text-gray-400">→</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Daily Trend */}
      <div>
        <div className="text-xs text-gray-400 mb-2">{t('dashboard.trend')}</div>
        <div className="border border-gray-200 rounded-lg p-4">
          <div className="flex items-end gap-2 h-20">
            {dailyTrend.map((d, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <div className="w-full flex flex-col justify-end" style={{ height: 64 }}>
                  <div className="w-full bg-indigo-500 rounded-t min-h-[2px]" style={{ height: `${Math.max((d.messages / maxDayMsg) * 100, 3)}%` }} title={`${d.messages}次`} />
                </div>
                <span className="text-[10px] text-gray-400">{d.date}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Tools */}
      {topTools.length > 0 && (
        <div>
          <div className="text-xs text-gray-400 mb-2">{t('dashboard.toolUsage')}</div>
          <div className="border border-gray-200 rounded-lg p-4 space-y-1.5">
            {topTools.map((t, i) => (
              <div key={i} className="flex items-center gap-3 text-sm">
                <span className="w-20 text-xs text-gray-500 truncate">{toolLabels[t.name] || t.name}</span>
                <div className="h-3 bg-gray-100 rounded-full flex-1">
                  <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${Math.round(t.count / topTools[0].count * 100)}%` }} />
                </div>
                <span className="text-xs text-gray-400 w-6 text-right">{t.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* P2-17 效能看板 */}
      <EfficiencyBoard />

      {/* Agent Stats */}
      <AgentStats />
    </div>
  );
}

interface EfficiencyData {
  adoption: { weeklyActiveUsers: number; totalUsers: number; adoptionRate: number };
  reliability: { totalConversations: number; cleanConversations: number; cleanRate: number; satisfactionRate: number; feedbackCount: number };
  topFailedTools: { toolName: string; failCount: number; lastErrorCode: string; lastErrorMessage: string }[];
  agentUsageBreakdown: { agentId: string; messageCount: number; avgResponseTimeSec: number }[];
  knowledge: { hitRate: number; coverage: number; totalSearches: number; topMissedQueries: { query: string; count: number }[] };
}

function EfficiencyBoard() {
  const [data, setData] = useState<EfficiencyData | null>(null);
  const [agentNames, setAgentNames] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch(`${MAIN_URL}/api/analytics/efficiency`, { headers: authHeaders() })
      .then(r => r.json()).then(d => { if (d && !d.error) setData(d); }).catch(() => {});
    fetch(`${MAIN_URL}/api/agents`, { headers: authHeaders() }).then(r => r.json())
      .then(list => { if (Array.isArray(list)) setAgentNames(Object.fromEntries(list.map((a: any) => [a.id, a.name]))); }).catch(() => {});
  }, []);

  if (!data) return null;
  const { adoption, reliability, topFailedTools, agentUsageBreakdown } = data;
  const maxAgentMsgs = Math.max(...agentUsageBreakdown.map(a => a.messageCount), 1);

  return (
    <div>
      <div className="text-xs text-gray-400 mb-2">效能看板 <span className="text-gray-300">— CoWorker 是否在创造价值</span></div>

      {/* 关键比率 */}
      <div className="grid grid-cols-3 gap-3 mb-3">
        <StatCard label="员工采纳率" value={adoption.totalUsers > 0 ? `${adoption.adoptionRate}%` : '--'}
          sub={`本周 ${adoption.weeklyActiveUsers}/${adoption.totalUsers} 人`} />
        <StatCard label="无故障会话率" value={reliability.totalConversations > 0 ? `${reliability.cleanRate}%` : '--'}
          sub={`${reliability.cleanConversations}/${reliability.totalConversations} 会话`} />
        <StatCard label="满意度" value={reliability.feedbackCount > 0 ? `${reliability.satisfactionRate}%` : '--'}
          sub={reliability.feedbackCount > 0 ? `${reliability.feedbackCount} 条反馈` : '暂无反馈'} />
      </div>

      {/* 常见失败 */}
      {topFailedTools.length > 0 && (
        <div className="border border-gray-200 rounded-lg p-4 mb-3">
          <div className="text-xs text-gray-400 mb-2">常见失败（本月）</div>
          <div className="space-y-1.5">
            {topFailedTools.map((f, i) => (
              <div key={i} className="flex items-center gap-3 text-sm" title={f.lastErrorMessage}>
                <span className="flex-1 text-xs text-gray-600 truncate font-mono">{toolLabels[f.toolName] || f.toolName}</span>
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-red-50 text-red-500 font-mono">{f.lastErrorCode}</span>
                <span className="text-xs text-gray-400 w-10 text-right">{f.failCount} 次</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Agent 使用分布 */}
      {agentUsageBreakdown.length > 0 && (
        <div className="border border-gray-200 rounded-lg p-4">
          <div className="text-xs text-gray-400 mb-2">Agent 使用分布（本月）</div>
          <div className="space-y-1.5">
            {agentUsageBreakdown.map((a, i) => (
              <div key={i} className="flex items-center gap-3 text-sm">
                <span className="w-20 text-xs text-gray-500 truncate">{agentNames[a.agentId] || a.agentId}</span>
                <div className="h-3 bg-gray-100 rounded-full flex-1">
                  <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${Math.round(a.messageCount / maxAgentMsgs * 100)}%` }} />
                </div>
                <span className="text-xs text-gray-400 w-16 text-right">{a.messageCount} 条{a.avgResponseTimeSec > 0 ? ` · ${a.avgResponseTimeSec}s` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentStats() {
  const { t } = useI18n();
  const [agents, setAgents] = useState<{ id: string; name: string; icon: string }[]>([]);
  const [stats, setStats] = useState<Record<string, { sessions: number; messages: number }>>({});

  useEffect(() => {
    // Load agents
    fetch(`${MAIN_URL}/api/agents`, { headers: authHeaders() }).then(r => r.json())
      .then(list => { if (Array.isArray(list)) setAgents(list); }).catch(() => {});
    // Load session counts per agent type
    fetch(`${MAIN_URL}/api/sessions/stats`, { headers: authHeaders() }).then(r => r.json())
      .then(d => { if (d && !d.error) setStats(d); }).catch(() => {});
  }, []);

  if (agents.length === 0) return null;

  return (
    <div>
      <div className="text-xs text-gray-400 mb-2">{t('dashboard.agentPerf')}</div>
      <div className="grid grid-cols-2 gap-3">
        {agents.map(a => {
          const s = stats[a.id] || { sessions: 0, messages: 0 };
          return (
            <div key={a.id} className="border border-gray-200 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">{a.icon}</span>
                <span className="text-sm font-medium text-gray-700">{a.name}</span>
              </div>
              <div className="flex gap-4 text-sm">
                <div>
                  <div className="text-xs text-gray-400">{t('dashboard.sessions')}</div>
                  <div className="font-bold font-mono text-indigo-600">{s.sessions}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-400">{t('dashboard.messages')}</div>
                  <div className="font-bold font-mono">{s.messages}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
