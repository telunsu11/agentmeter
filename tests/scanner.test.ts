import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Scanner, AgentAdapter } from '../src/core/scanner.js';
import { zcodeTurn, claudeAssistant, tmpDir, writeLines } from './helpers.js';

/** 一个最小 append 适配器用于扫描器行为测试 */
function fakeAdapter(dir: string): AgentAdapter {
  return {
    id: 'zcode',
    displayName: 'fake',
    defaultDir: () => dir,
    listFiles: (d: string) =>
      fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(d, f)).sort(),
    parseFull: (file: string) => {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
      const events = lines.map((l) => {
        const rec = JSON.parse(l);
        return {
          ts: rec.completedAt,
          agent: 'zcode' as const,
          sessionId: rec.sessionId,
          projectDir: '',
          model: rec.model.modelId,
          inputTokens: rec.response.usage.inputTokens,
          outputTokens: rec.response.usage.outputTokens,
          cacheReadTokens: rec.response.usage.cacheReadTokens,
          cacheWriteTokens: rec.response.usage.cacheWriteTokens,
        };
      });
      return { events, traces: [], nextOffset: fs.statSync(file).size };
    },
    parseIncremental: (file: string, offset: number) => {
      const text = fs.readFileSync(file, 'utf8');
      const newPart = Buffer.from(text).subarray(offset).toString();
      const events = newPart
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          const rec = JSON.parse(l);
          return {
            ts: rec.completedAt,
            agent: 'zcode' as const,
            sessionId: rec.sessionId,
            projectDir: '',
            model: rec.model.modelId,
            inputTokens: rec.response.usage.inputTokens,
            outputTokens: rec.response.usage.outputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          };
        });
      return { events, traces: [], nextOffset: Buffer.byteLength(text, 'utf8') };
    },
  };
}

describe('Scanner 增量扫描', () => {
  let dir: string;
  let cacheDir: string;
  let file: string;

  beforeEach(() => {
    dir = tmpDir();
    cacheDir = tmpDir();
    file = writeLines(dir, 's1.jsonl', [zcodeTurn({ input: 100 }), zcodeTurn({ input: 200 })]);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('首扫全量、二扫命中缓存、追加后增量且不重复计数', async () => {
    const mk = () => new Scanner({ adapters: [fakeAdapter(dir)], cacheDir });
    const s1 = await mk().scan();
    expect(s1.events).toHaveLength(2);
    expect(s1.parsedFiles).toBe(1);

    // 无变化：全部命中缓存
    const s2 = await mk().scan();
    expect(s2.parsedFiles).toBe(0);
    expect(s2.events).toHaveLength(2);

    // 追加一条：只解析增量，事件累积为 3
    fs.appendFileSync(file, JSON.stringify(zcodeTurn({ input: 300 })) + '\n');
    const s3 = await mk().scan();
    expect(s3.parsedFiles).toBe(1);
    expect(s3.events).toHaveLength(3);
    expect(s3.events[2].inputTokens).toBe(300);

    // 再扫一次（无变化）确认没有重复
    const s4 = await mk().scan();
    expect(s4.events).toHaveLength(3);
  });

  it('删除文件后缓存历史保留', async () => {
    const mk = () => new Scanner({ adapters: [fakeAdapter(dir)], cacheDir });
    await mk().scan();
    fs.rmSync(file);
    const s = await mk().scan();
    expect(s.events).toHaveLength(2); // 历史事件仍在
  });

  it('--rescan 强制全量重扫', async () => {
    await new Scanner({ adapters: [fakeAdapter(dir)], cacheDir }).scan();
    fs.appendFileSync(file, JSON.stringify(zcodeTurn({ input: 300 })) + '\n');
    const s = await new Scanner({ adapters: [fakeAdapter(dir)], cacheDir, rescan: true }).scan();
    expect(s.events).toHaveLength(3);
    expect(s.parsedFiles).toBe(1);
  });
});

describe('claude/zcode 适配器经过 Scanner 的组合', () => {
  it('两个 agent 的事件合流', async () => {
    const zDir = tmpDir();
    const cDir = tmpDir();
    const cacheDir = tmpDir();
    writeLines(zDir, 'model-io-sess_x.jsonl', [zcodeTurn({ sessionId: 'x' })]);
    const claudeProj = path.join(cDir, 'projects', '-tmp-p1');
    writeLines(claudeProj, 'sess-b.jsonl', [claudeAssistant({ sessionId: 'sess-b' })]);

    const zAdapter = {
      ...fakeAdapter(zDir),
      defaultDir: () => zDir,
      listFiles: () => fs.readdirSync(zDir).map((f) => path.join(zDir, f)),
    };
    const { claudeAdapter } = await import('../src/adapters/claude.js');
    const cAdapter = { ...claudeAdapter, defaultDir: () => cDir };
    const scanner = new Scanner({ adapters: [zAdapter as any, cAdapter as any], cacheDir });
    const s = await scanner.scan();
    expect(s.events.map((e) => e.agent).sort()).toEqual(['claude', 'zcode']);
  });
});
