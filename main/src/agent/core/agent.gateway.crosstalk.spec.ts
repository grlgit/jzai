/**
 * 会话串流（cross-talk）回归测试。
 *
 * 历史缺陷：多个会话并发生成时，会话 A 的流式响应偶现闪入会话 B 的消息流。
 * 根因：① socket 只 join 不 leave，旧会话 room 的事件持续抵达；
 *      ② 同会话并发双发时 ActiveRun 按 key 覆盖，两路流交织且无法区分；
 *      ③ 流事件无 runId，前端只能靠有空窗的 sessionId 过滤。
 *
 * 修复：joinRunRoom 退出旧 chatrun room；同会话并发第二发拒绝；全事件携带 runId。
 * 本 spec 固化修复后的行为。
 */
import { ChatGateway } from './agent.gateway';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 按标签产出带间隔的 text_delta 流，结尾 done */
async function* makeStream(labels: string[], gapMs: number) {
  for (const text of labels) {
    await sleep(gapMs);
    yield { type: 'text_delta', text };
  }
  yield { type: 'done', model: 'mock', cost: 0, tokens: { input: 0, output: 0, total: 0 } };
}

interface Emitted { room: string; event: string; payload: any; t: number }

function buildGateway(streamFor: (content: string) => AsyncGenerator<any>) {
  const emitted: Emitted[] = [];

  const agentService: any = {
    processMessage: jest.fn((_agentId: string, _sid: string, _uid: string, content: string) => streamFor(content)),
    getReuseWindowMinutes: () => 10,
    warmupAgent: async () => {},
    cancelAgent: () => {},
  };
  const sessionService: any = {
    getSession: async (id: string) => ({ id, agentType: 'main', userId: 'u1' }),
    getRecentSession: async () => null,
    createSession: async () => 'new-session',
    saveUserMessage: async () => {},
    saveMessage: async () => {},
    checkAndCompress: async () => {},
  };
  const analytics: any = { recordEvent: async () => {}, registerUser: () => {} };
  const confirmBridge: any = { events: { on: () => {}, off: () => {} } };
  const userService: any = { verifyToken: () => null, decodeOem: () => null };

  const gateway = new ChatGateway(agentService, sessionService, userService, analytics, confirmBridge, undefined, undefined);
  (gateway as any).server = {
    to: (room: string) => ({
      emit: (event: string, payload: any) => { emitted.push({ room, event, payload, t: Date.now() }); },
    }),
  };

  const makeClient = (id: string) => {
    const rooms = new Set<string>([id]); // socket.io 语义：rooms 含自身 id
    const left: string[] = [];
    const direct: { event: string; payload: any }[] = [];
    return {
      id,
      rooms,
      join: (room: string) => { rooms.add(room); },
      leave: (room: string) => { rooms.delete(room); left.push(room); },
      emit: (event: string, payload: any) => { direct.push({ event, payload }); },
      left, direct,
      handshake: { auth: {}, query: {}, headers: {} },
    } as any;
  };

  return { gateway, emitted, makeClient };
}

describe('ChatGateway 会话串流回归', () => {
  jest.setTimeout(15000);

  it('同一会话并发双发：第二发被拒绝，仅一路流产出，事件均携带 runId', async () => {
    const { gateway, emitted, makeClient } = buildGateway((content) =>
      content.includes('A')
        ? makeStream(['A1', 'A2', 'A3', 'A4'], 20)
        : makeStream(['B1', 'B2', 'B3'], 20),
    );
    const client = makeClient('c1');
    (gateway as any).socketUsers.set('c1', { id: 'u1', name: 'tester', principal: {} });

    const p1 = gateway.handleChatSend(client, { conversationId: 'default', sessionId: 's1', content: '问题A' } as any);
    await sleep(10);
    const p2 = gateway.handleChatSend(client, { conversationId: 'default', sessionId: 's1', content: '问题B' } as any);
    await Promise.all([p1, p2]);

    // 第二发被拒：直接回给发起方错误 + done，不进入广播流
    const rejections = client.direct.filter((d: any) => d.event === 'chat.error');
    expect(rejections).toHaveLength(1);
    expect(rejections[0].payload.error).toContain('正在生成');

    // 广播流里只有 A 一路，无 B 穿透
    const deltas = emitted.filter(e => e.event === 'chat.stream' && e.payload.delta);
    expect(deltas.map(d => d.payload.delta)).toEqual(['A1', 'A2', 'A3', 'A4']);

    // 所有流事件都带同一个 runId，且发起方收到了 chat.run 通告
    const runIds = new Set(deltas.map(d => d.payload.runId));
    expect(runIds.size).toBe(1);
    expect([...runIds][0]).toBeTruthy();
    const runNotice = client.direct.find((d: any) => d.event === 'chat.run');
    expect(runNotice?.payload.runId).toBe([...runIds][0]);
  });

  it('跨会话切换：进入新 run 的 room 时退出旧 chatrun room，旧会话事件不再抵达本 socket', async () => {
    const { gateway, emitted, makeClient } = buildGateway((content) =>
      content.includes('慢')
        ? makeStream(['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], 25)
        : makeStream(['B1', 'B2'], 10),
    );
    const client = makeClient('c1');
    (gateway as any).socketUsers.set('c1', { id: 'u1', name: 'tester', principal: {} });

    const pA = gateway.handleChatSend(client, { conversationId: 'default', sessionId: 'sA', content: '慢问题' } as any);
    await sleep(40); // A 正在流式输出
    const pB = gateway.handleChatSend(client, { conversationId: 'default', sessionId: 'sB', content: '快问题' } as any);
    await sleep(15); // 等 B 走过 handleChatSend 内的 await 链抵达 joinRunRoom

    // 发起 B 后：socket 已退出 A 的 room，只在 B 的 room
    expect(client.left).toContain('chatrun:u1:sA');
    expect(client.rooms.has('chatrun:u1:sA')).toBe(false);
    expect(client.rooms.has('chatrun:u1:sB')).toBe(true);

    await Promise.all([pA, pB]);

    // A 的后续 delta 仍会广播到 room A（供 attach 回去的 socket 续流），
    // 但本 socket 已不在 room A——不会收到。两路事件 runId 不同，前端可精确区分。
    const aDeltas = emitted.filter(e => e.room === 'chatrun:u1:sA' && e.payload.delta);
    const bDeltas = emitted.filter(e => e.room === 'chatrun:u1:sB' && e.payload.delta);
    expect(aDeltas.length).toBeGreaterThan(0);
    expect(bDeltas.length).toBeGreaterThan(0);
    const aRunIds = new Set(aDeltas.map(d => d.payload.runId));
    const bRunIds = new Set(bDeltas.map(d => d.payload.runId));
    expect(aRunIds.size).toBe(1);
    expect(bRunIds.size).toBe(1);
    expect([...aRunIds][0]).not.toBe([...bRunIds][0]);
  });

  it('chat.attach 恢复：join 新 room 前退出旧 chatrun room，快照携带 runId', async () => {
    const { gateway, makeClient } = buildGateway(() => makeStream(['X1', 'X2', 'X3', 'X4'], 30));
    const sender = makeClient('c1');
    (gateway as any).socketUsers.set('c1', { id: 'u1', name: 'tester', principal: {} });

    const p = gateway.handleChatSend(sender, { conversationId: 'default', sessionId: 'sX', content: '问题X' } as any);
    await sleep(40);

    // 另一个 socket（如新标签页）先残留在别的 chatrun room，再 attach 到 sX
    const other = makeClient('c2');
    (gateway as any).socketUsers.set('c2', { id: 'u1', name: 'tester', principal: {} });
    other.rooms.add('chatrun:u1:sOld');

    await gateway.handleAttach(other, { sessionId: 'sX' } as any);

    expect(other.left).toContain('chatrun:u1:sOld');
    expect(other.rooms.has('chatrun:u1:sX')).toBe(true);
    const attached = other.direct.find((d: any) => d.event === 'chat.attached');
    expect(attached?.payload.status).toBe('running');
    expect(attached?.payload.runId).toBeTruthy();

    await p;
  });
});
