import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** 测试夹具：合成各 agent 的日志行（不含任何真实数据） */

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentmeter-test-'));
}

export function writeLines(dir: string, name: string, objs: any[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, objs.map((o) => JSON.stringify(o)).join('\n') + '\n');
  return file;
}

/* ---------------- Claude Code 行 ---------------- */

export function claudeAssistant(opts: {
  ts?: string;
  sessionId?: string;
  cwd?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  msgId?: string;
  requestId?: string;
  apiError?: boolean;
  toolUses?: { id: string; name: string; path?: string }[];
  sidechain?: boolean;
}): any {
  const content: any[] = [];
  for (const t of opts.toolUses || []) {
    content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.path ? { file_path: t.path } : {} });
  }
  if (content.length === 0) content.push({ type: 'text', text: 'ok' });
  return {
    type: 'assistant',
    timestamp: opts.ts || '2026-09-01T10:00:00.000Z',
    sessionId: opts.sessionId || 'sess-a',
    requestId: opts.requestId || 'req-1',
    cwd: opts.cwd || '/tmp/proj',
    uuid: `uuid-${Math.random().toString(36).slice(2)}`,
    isSidechain: opts.sidechain === true,
    isApiErrorMessage: opts.apiError === true,
    message: {
      id: opts.msgId || `msg-${Math.random().toString(36).slice(2)}`,
      model: opts.model || 'claude-sonnet-4-5',
      content,
      usage: {
        input_tokens: opts.input ?? 1000,
        output_tokens: opts.output ?? 100,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheWrite ?? 0,
      },
    },
  };
}

export function claudeToolResult(opts: {
  ts?: string;
  sessionId?: string;
  cwd?: string;
  toolUseId: string;
  isError?: boolean;
  text?: string;
}): any {
  return {
    type: 'user',
    timestamp: opts.ts || '2026-09-01T10:00:01.000Z',
    sessionId: opts.sessionId || 'sess-a',
    cwd: opts.cwd || '/tmp/proj',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: opts.toolUseId,
          is_error: opts.isError === true,
          content: [{ type: 'text', text: opts.text || 'done' }],
        },
      ],
    },
  };
}

/* ---------------- ZCode 行 ---------------- */

export function zcodeTurn(opts: {
  ts?: string;
  sessionId?: string;
  turnId?: string;
  attempt?: number;
  model?: string;
  querySource?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  finishReason?: string;
  toolCalls?: { id: string; name: string; path?: string }[];
  systemDir?: string;
}): any {
  const rec: any = {
    startedAt: opts.ts || '2026-09-01T10:00:00.000Z',
    completedAt: opts.ts || '2026-09-01T10:00:02.000Z',
    durationMs: 2000,
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    attempt: opts.attempt ?? 1,
    turnId: opts.turnId || 'turn-1',
    sessionId: opts.sessionId || '11111111-2222-3333-4444-555555555555',
    querySource: opts.querySource || 'main_turn',
    model: { modelId: opts.model || 'GLM-5.3', providerId: 'test', role: 'main' },
    request: {
      body: {
        model: opts.model || 'GLM-5.3',
        max_tokens: 8192,
        system: opts.systemDir
          ? [{ type: 'text', text: `You are working in workspace ${opts.systemDir}` }]
          : [{ type: 'text', text: 'system prompt' }],
        messages: [],
      },
    },
    response: {
      usage: {
        inputTokens: opts.input ?? 1000,
        outputTokens: opts.output ?? 100,
        totalTokens: (opts.input ?? 1000) + (opts.output ?? 100),
        cacheReadTokens: opts.cacheRead ?? 0,
        cacheWriteTokens: opts.cacheWrite ?? 0,
      },
      finishReason: opts.finishReason || 'stop',
      toolCalls: (opts.toolCalls || []).map((t) => ({
        id: t.id,
        name: t.name,
        input: t.path ? { file_path: t.path } : {},
      })),
    },
  };
  return rec;
}

/* ---------------- Codex 行 ---------------- */

export function codexSessionMeta(cwd: string, sessionId: string): any {
  return {
    type: 'session_meta',
    timestamp: '2026-09-01T09:00:00.000Z',
    payload: { cwd, session_id: sessionId, id: sessionId },
  };
}

export function codexTokenCount(opts: {
  ts?: string;
  input?: number;
  cached?: number;
  cacheWrite?: number;
  output?: number;
  reasoning?: number;
}): any {
  const input = opts.input ?? 10000;
  const cached = opts.cached ?? 8000;
  return {
    type: 'event_msg',
    timestamp: opts.ts || '2026-09-01T10:00:00.000Z',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          cache_write_input_tokens: opts.cacheWrite ?? 0,
          output_tokens: opts.output ?? 500,
          reasoning_output_tokens: opts.reasoning ?? 0,
          total_tokens: input + (opts.output ?? 500),
        },
      },
    },
  };
}

export function codexTurnContext(model: string): any {
  return { type: 'turn_context', timestamp: '2026-09-01T09:59:00.000Z', payload: { model } };
}
