import { describe, it, expect } from 'vitest';
import { detectWaste } from '../src/core/waste/engine.js';
import { TokenTotals, TurnTrace } from '../src/core/model.js';
import { rawTotal } from '../src/core/aggregate.js';

function trace(opts: Partial<TurnTrace> & { ts: string }): TurnTrace {
  return {
    agent: 'claude',
    sessionId: 's1',
    projectDir: '/tmp/p',
    model: 'm',
    tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, ...(opts.tokens || {}) },
    tools: [],
    flags: {},
    ...opts,
  } as TurnTrace;
}

const T = (input: number, output: number, cacheRead = 0, cacheWrite = 0): TokenTotals => ({
  input, output, cacheRead, cacheWrite,
});

describe('浪费检测引擎', () => {
  it('API 错误/重试：attempt>1 与 isApiError 轮计入浪费', () => {
    const findings = detectWaste([
      trace({ ts: '2026-09-01T01:00:00Z', tokens: T(1000, 100) }),
      trace({ ts: '2026-09-01T01:01:00Z', tokens: T(2000, 0), flags: { attempt: 2 } }),
      trace({ ts: '2026-09-01T01:02:00Z', tokens: T(1500, 0), flags: { isApiError: true } }),
    ]);
    const retry = findings.find((f) => f.type === 'api_retry');
    expect(retry).toBeTruthy();
    expect(retry!.count).toBe(2);
    expect(retry!.tokensWasted.input).toBe(3500);
    expect(retry!.severity).toBe('high');
  });

  it('失败循环：同工具+同错误签名 ≥3 次触发，循环区间计入浪费', () => {
    const errSig = 'deadbeef';
    const mk = (i: number): TurnTrace =>
      trace({
        ts: `2026-09-01T01:0${i}:00Z`,
        tokens: T(5000, 100),
        tools: [{ name: 'Bash', error: true, errSig }, { name: 'Read', path: '/a.ts' }],
      });
    const findings = detectWaste([mk(0), mk(1), mk(2)]);
    const loop = findings.find((f) => f.type === 'failure_loop');
    expect(loop).toBeTruthy();
    expect(loop!.count).toBe(3);
    expect(loop!.tokensWasted.input).toBe(15000);
  });

  it('失败循环：错误签名不同不触发', () => {
    const mk = (i: number, sig: string): TurnTrace =>
      trace({ ts: `2026-09-01T01:0${i}:00Z`, tools: [{ name: 'Bash', error: true, errSig: sig }] });
    const findings = detectWaste([mk(0, 'aaaa1111'), mk(1, 'bbbb2222'), mk(2, 'cccc3333')]);
    expect(findings.find((f) => f.type === 'failure_loop')).toBeUndefined();
  });

  it('上下文重启：缓存读取骤降 + 上下文收缩触发，重建期计入浪费', () => {
    const findings = detectWaste([
      trace({ ts: '2026-09-01T01:00:00Z', tokens: T(5000, 500, 200000) }),
      trace({ ts: '2026-09-01T01:05:00Z', tokens: T(2000, 300, 0, 50000) }), // 重启点
      trace({ ts: '2026-09-01T01:06:00Z', tokens: T(1000, 300, 1000, 20000) }),
      trace({ ts: '2026-09-01T01:07:00Z', tokens: T(1000, 300, 2000, 10000) }),
    ]);
    const restart = findings.find((f) => f.type === 'context_restart');
    expect(restart).toBeTruthy();
    expect(restart!.tokensWasted.cacheWrite).toBe(80000);
    expect(restart!.tokensWasted.input).toBe(4000);
  });

  it('缓存空转：巨量缓存读 + 输出 < 50', () => {
    const findings = detectWaste([
      trace({ ts: '2026-09-01T01:00:00Z', tokens: T(10, 10, 150000) }),
      trace({ ts: '2026-09-01T01:01:00Z', tokens: T(10, 5, 120000) }),
      trace({ ts: '2026-09-01T01:02:00Z', tokens: T(10, 900, 150000) }), // 正常轮
    ]);
    const idle = findings.find((f) => f.type === 'ineffective_cache');
    expect(idle).toBeTruthy();
    expect(idle!.count).toBe(2);
    expect(idle!.tokensWasted.cacheRead).toBe(270000);
  });

  it('僵尸会话：输出极少或错误收尾', () => {
    const zombie = detectWaste(
      Array.from({ length: 6 }, (_, i) => trace({ ts: `2026-09-01T01:0${i}:00Z`, tokens: T(8000, 10) })),
    );
    expect(zombie.find((f) => f.type === 'zombie_session')).toBeTruthy();

    const endedErr = detectWaste([
      trace({ ts: '2026-09-01T01:00:00Z', tokens: T(5000, 500) }),
      trace({ ts: '2026-09-01T01:01:00Z', tokens: T(5000, 500) }),
      trace({ ts: '2026-09-01T01:02:00Z', tokens: T(5000, 0), flags: { isApiError: true } }),
    ]);
    const z2 = endedErr.find((f) => f.type === 'zombie_session');
    expect(z2).toBeTruthy();
    expect(z2!.severity).toBe('high');
  });

  it('重复读取：同一路径读取 ≥4 次触发', () => {
    const mk = (i: number): TurnTrace =>
      trace({
        ts: `2026-09-01T01:0${i}:00Z`,
        tools: [{ name: 'Read', path: '/tmp/p/big-file.ts' }, { name: 'Read', path: `/tmp/p/once-${i}.ts` }],
      });
    const findings = detectWaste(Array.from({ length: 5 }, (_, i) => mk(i)));
    const dup = findings.find((f) => f.type === 'duplicate_reads');
    expect(dup).toBeTruthy();
    expect(dup!.count).toBe(5);
  });

  it('internal 轮（标题生成等）不参与审计', () => {
    const findings = detectWaste([
      trace({ ts: '2026-09-01T01:00:00Z', tokens: T(10, 10, 150000), flags: { internal: true } }),
    ]);
    expect(findings).toHaveLength(0);
  });

  it('长会话税：上下文越线后续跑 ≥3 轮触发，浪费=超出健康线部分', () => {
    // 4 轮，每轮 ctx = 10k 输入 + 190k 缓存读 = 200k（显式健康线 150k，默认 400K 见下一条用例）
    const cfg = { waste: { contextBloatTokens: 150_000 } };
    const fat = (i: number) => trace({ ts: `2026-09-01T01:0${i}:00Z`, tokens: T(10000, 500, 190000) });
    const findings = detectWaste([fat(0), fat(1), fat(2), fat(3)], cfg);
    const bloat = findings.find((f) => f.type === 'context_bloat');
    expect(bloat).toBeTruthy();
    expect(bloat!.count).toBe(4);
    // 每轮超出 50k，按 cacheRead 占比 190/200 → 47.5k/轮，4 轮 ≈ 190k
    expect(bloat!.tokensWasted.cacheRead).toBe(190000);
    expect(bloat!.tokensWasted.input).toBe(10000);
  });

  it('长会话税：未过线或轮数不足不触发', () => {
    const thin = (i: number) => trace({ ts: `2026-09-01T01:0${i}:00Z`, tokens: T(5000, 500, 50000) });
    expect(detectWaste(Array.from({ length: 10 }, (_, i) => thin(i))).find((f) => f.type === 'context_bloat')).toBeUndefined();

    // 越线但只跑了 2 轮（阈值 3）→ 不触发
    const fat = (i: number) => trace({ ts: `2026-09-01T01:0${i}:00Z`, tokens: T(10000, 500, 190000) });
    expect(detectWaste([fat(0), fat(1)], { waste: { contextBloatTokens: 150_000 } }).find((f) => f.type === 'context_bloat')).toBeUndefined();
  });

  it('长会话税默认健康线为 400K（现代 agent 正常长会话不误报）', async () => {
    const { defaultWasteOptions } = await import('../src/core/waste/engine.js');
    expect(defaultWasteOptions().contextBloatTokens).toBe(400_000);
    // 200k 上下文在默认阈值下不触发
    const mid = (i: number) => trace({ ts: `2026-09-01T01:0${i}:00Z`, tokens: T(10000, 500, 190000) });
    expect(detectWaste(Array.from({ length: 6 }, (_, i) => mid(i))).find((f) => f.type === 'context_bloat')).toBeUndefined();
  });

  it('长会话税：健康线可配置', () => {
    const mid = (i: number) => trace({ ts: `2026-09-01T01:0${i}:00Z`, tokens: T(4000, 500, 60000) });
    const cfg = { waste: { contextBloatTokens: 50000, contextBloatMinTurns: 2 } };
    const findings = detectWaste(Array.from({ length: 3 }, (_, i) => mid(i)), cfg);
    expect(findings.find((f) => f.type === 'context_bloat')).toBeTruthy();
  });

  it('时间过滤按时区归属（UTC 日期≠本地日期的边界事件）', () => {
    // 本地(UTC+8) 2026-06-01 02:00 = UTC 2026-05-31 18:00；带 API 错误标记使过滤结果可观察
    const sig: TurnTrace = {
      agent: 'claude', sessionId: 'tz1', projectDir: '/p', model: 'm',
      ts: '2026-05-31T18:00:00.000Z',
      tokens: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0 },
      tools: [], flags: { isApiError: true },
    };
    // UTC 口径：属 5-31，6 月过滤应排除
    expect(detectWaste([sig], undefined, '2026-06-01', '2026-06-30', 'UTC')).toHaveLength(0);
    // 上海口径：属 6-01，应包含
    expect(detectWaste([sig], undefined, '2026-06-01', '2026-06-30', 'Asia/Shanghai')).toHaveLength(1);
  });

  it('正常会话不产生任何信号', () => {
    const findings = detectWaste(
      Array.from({ length: 10 }, (_, i) =>
        trace({ ts: `2026-09-01T01:${String(i).padStart(2, '0')}:00Z`, tokens: T(2000, 800, 50000, 2000) }),
      ),
    );
    expect(findings).toHaveLength(0);
  });
});

describe('错误签名归一化', () => {
  it('只有数字/路径不同的同类错误得到相同签名', async () => {
    const { errorSignature } = await import('../src/core/util.js');
    const a = errorSignature('Error: ENOENT: no such file /tmp/a/b.ts at line 42');
    const b = errorSignature('Error: ENOENT: no such file /tmp/x/y.ts at line 77');
    const c = errorSignature('SyntaxError: unexpected token in /tmp/a/b.ts');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
