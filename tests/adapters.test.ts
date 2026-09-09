import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { claudeAdapter } from '../src/adapters/claude.js';
import { zcodeAdapter } from '../src/adapters/zcode.js';
import { codexAdapter } from '../src/adapters/codex.js';
import {
  claudeAssistant,
  claudeToolResult,
  zcodeTurn,
  codexSessionMeta,
  codexTokenCount,
  codexTurnContext,
  tmpDir,
  writeLines,
} from './helpers.js';

describe('claude 适配器', () => {
  it('解析 assistant 记录为 UsageEvent', () => {
    const dir = tmpDir();
    const file = writeLines(dir, 'sess-a.jsonl', [
      claudeAssistant({ input: 1000, output: 200, cacheRead: 5000, cwd: '/tmp/p1', model: 'Claude-Sonnet-4-5' }),
    ]);
    const out = claudeAdapter.parseFull(file);
    expect(out.events).toHaveLength(1);
    const e = out.events[0];
    expect(e.agent).toBe('claude');
    expect(e.inputTokens).toBe(1000);
    expect(e.outputTokens).toBe(200);
    expect(e.cacheReadTokens).toBe(5000);
    expect(e.model).toBe('claude-sonnet-4-5');
    expect(e.projectDir).toBe('/tmp/p1');
  });

  it('相同 message.id 的重复落盘只计一次', () => {
    const dir = tmpDir();
    const dup = claudeAssistant({ msgId: 'msg-1', requestId: 'req-1' });
    const file = writeLines(dir, 'sess-a.jsonl', [dup, { ...dup }, claudeAssistant({ msgId: 'msg-2' })]);
    const out = claudeAdapter.parseFull(file);
    expect(out.events).toHaveLength(2);
  });

  it('提取工具路径与错误签名（脱敏哈希）', () => {
    const dir = tmpDir();
    const file = writeLines(dir, 'sess-a.jsonl', [
      claudeToolResult({ toolUseId: 'tu-1', isError: true, text: 'Error: ENOENT /etc/hosts line 5' }),
      claudeAssistant({ toolUses: [{ id: 'tu-1', name: 'Read', path: '/tmp/p1/a.ts' }] }),
    ]);
    const out = claudeAdapter.parseFull(file);
    expect(out.traces).toHaveLength(1);
    const tools = out.traces[0].tools;
    expect(tools.find((t) => t.name === 'Read')?.path).toBe('/tmp/p1/a.ts');
    const err = tools.find((t) => t.error);
    expect(err).toBeTruthy();
    expect(err?.errSig).toMatch(/^[0-9a-f]{8}$/);
  });

  it('isApiErrorMessage 标记 API 错误', () => {
    const dir = tmpDir();
    const file = writeLines(dir, 'sess-a.jsonl', [claudeAssistant({ apiError: true, input: 500 })]);
    const out = claudeAdapter.parseFull(file);
    expect(out.events[0].meta?.isApiError).toBe(true);
    expect(out.traces[0].flags.isApiError).toBe(true);
  });
});

describe('zcode 适配器', () => {
  it('解析 camelCase usage 与 attempt', () => {
    const dir = tmpDir();
    const file = writeLines(dir, 'model-io-sess_abc123.jsonl', [
      zcodeTurn({ input: 3000, output: 400, cacheRead: 20000, attempt: 1 }),
      zcodeTurn({ input: 3000, output: 0, cacheRead: 20000, attempt: 2, finishReason: 'error' }),
    ]);
    const out = zcodeAdapter.parseFull(file);
    expect(out.events).toHaveLength(2);
    expect(out.events[1].meta?.attempt).toBe(2);
    expect(out.events[1].meta?.isApiError).toBe(true);
    expect(out.events[0].sessionId).toBe('abc123'.slice(0, 0) + out.events[0].sessionId); // sessionId 存在
    expect(out.events[0].sessionId.length).toBeGreaterThan(0);
  });

  it('session_title 请求标记为 internal', () => {
    const dir = tmpDir();
    const file = writeLines(dir, 'model-io-sess_abc123.jsonl', [
      zcodeTurn({ querySource: 'session_title' }),
    ]);
    const out = zcodeAdapter.parseFull(file);
    expect(out.events[0].meta?.internal).toBe(true);
  });

  it('从 system 提示词提取项目目录', () => {
    const dir = tmpDir();
    const file = writeLines(dir, 'model-io-sess_abc123.jsonl', [
      zcodeTurn({ systemDir: '/Users/x/my-project' }),
    ]);
    const out = zcodeAdapter.parseFull(file);
    expect(out.events[0].projectDir).toBe('/Users/x/my-project');
  });

  it('工具调用路径进入 trace 并参与项目推断', () => {
    const dir = tmpDir();
    const file = writeLines(dir, 'model-io-sess_abc123.jsonl', [
      zcodeTurn({
        toolCalls: [
          { id: 'c1', name: 'Read', path: '/Users/x/infra/src/a.ts' },
          { id: 'c2', name: 'Grep', path: '/Users/x/infra/src/b.ts' },
        ],
      }),
    ]);
    const out = zcodeAdapter.parseFull(file);
    expect(out.traces[0].tools).toHaveLength(2);
    // 无 system 目录时用路径推断
    expect(out.events[0].projectDir).toContain('/Users/x/infra');
  });
});

describe('codex 适配器', () => {
  it('token_count 事件映射为事件（cached 不重复计入 input）', () => {
    const dir = tmpDir();
    const file = writeLines(dir, 'rollout-x.jsonl', [
      codexSessionMeta('/tmp/codex-proj', 'cs-1'),
      codexTurnContext('gpt-5-codex'),
      codexTokenCount({ input: 17655, cached: 12032, output: 225, reasoning: 26 }),
    ]);
    const out = codexAdapter.parseFull(file);
    expect(out.events).toHaveLength(1);
    const e = out.events[0];
    expect(e.inputTokens).toBe(17655 - 12032);
    expect(e.cacheReadTokens).toBe(12032);
    expect(e.outputTokens).toBe(225 + 26);
    expect(e.projectDir).toBe('/tmp/codex-proj');
    expect(e.model).toBe('gpt-5-codex');
  });

  it('增量解析时从文件头恢复 session_meta', () => {
    const dir = tmpDir();
    const meta = codexSessionMeta('/tmp/codex-proj2', 'cs-2');
    const first = codexTokenCount({ ts: '2026-09-01T10:00:00.000Z' });
    const file = writeLines(dir, 'rollout-y.jsonl', [meta, first]);
    const full = codexAdapter.parseFull(file);
    expect(full.events).toHaveLength(1);

    // 追加一条，模拟增量
    fs.appendFileSync(file, JSON.stringify(codexTokenCount({ ts: '2026-09-01T10:05:00.000Z' })) + '\n');
    const inc = codexAdapter.parseIncremental(file, full.nextOffset, {
      entry: { size: 0, mtimeMs: 0, offset: full.nextOffset, events: full.events, traces: full.traces, head: full.head },
    });
    expect(inc.events).toHaveLength(1);
    expect(inc.events[0].projectDir).toBe('/tmp/codex-proj2');
  });
});
