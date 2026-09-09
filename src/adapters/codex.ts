import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  AgentAdapter,
  AdapterContext,
  ParseOutcome,
  listJsonlRecursive,
} from '../core/scanner.js';
import { TokenTotals, TurnTrace, UsageEvent } from '../core/model.js';
import { errorSignature, parseJsonLines, readFileTail } from '../core/util.js';

/**
 * Codex CLI 适配器
 * 数据：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * 用量来自 event_msg(token_count) 的 last_token_usage；cwd 来自首行 session_meta。
 * 增量解析时 session_meta 在文件头部，通过 head 缓存携带。
 */

interface CodexRecord {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    // session_meta
    cwd?: string;
    session_id?: string;
    // turn_context
    model?: string;
    // token_count
    info?: {
      last_token_usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        cache_write_input_tokens?: number;
        output_tokens?: number;
        reasoning_output_tokens?: number;
      };
    };
    // response_item: function_call / function_call_output
    name?: string;
    arguments?: string;
    output?: string;
    call_id?: string;
  };
}

interface CodexHead {
  cwd?: string;
  sessionId?: string;
  model?: string;
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  displayName: 'Codex',

  defaultDir(): string {
    if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
    return path.join(os.homedir(), '.codex');
  },

  listFiles(dir: string): string[] {
    return listJsonlRecursive(path.join(dir, 'sessions'));
  },

  parseFull(file: string): ParseOutcome {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    const stat = fs.statSync(file);
    return { ...parseCodexLines(lines, file, undefined), nextOffset: stat.size };
  },

  parseIncremental(file: string, offset: number, ctx: AdapterContext): ParseOutcome {
    const tail = readFileTail(file, offset);
    const head: CodexHead | undefined = ctx.entry?.head ? safeParseHead(ctx.entry.head) : readHead(file);
    const out = parseCodexLines(tail.lines, file, head);
    return { ...out, nextOffset: tail.nextOffset };
  },
};

function parseCodexLines(
  lines: string[],
  file: string,
  prevHead: CodexHead | undefined,
): { events: UsageEvent[]; traces: TurnTrace[]; head?: string } {
  const records = parseJsonLines<CodexRecord>(lines);
  const head: CodexHead = { ...prevHead };
  const events: UsageEvent[] = [];
  const traces: TurnTrace[] = [];
  let pendingTools: TurnTrace['tools'] = [];
  let pendingTokens: TokenTotals | undefined;
  let pendingTs = '';

  const flush = () => {
    if (!pendingTokens) return;
    const sessionId = head.sessionId || path.basename(file, '.jsonl');
    traces.push({
      ts: pendingTs,
      agent: 'codex',
      sessionId,
      projectDir: head.cwd || '',
      model: head.model || 'unknown',
      tokens: pendingTokens,
      tools: pendingTools,
      flags: {},
    });
    pendingTools = [];
    pendingTokens = undefined;
  };

  for (const rec of records) {
    const p = rec.payload || {};
    if (rec.type === 'session_meta') {
      head.cwd = p.cwd || head.cwd;
      head.sessionId = p.session_id || head.sessionId;
      continue;
    }
    if (rec.type === 'turn_context' && p.model) {
      head.model = p.model.toLowerCase();
      continue;
    }
    if (rec.type === 'response_item' && p.type === 'function_call' && p.name) {
      const args = safeParseJson(p.arguments);
      const fp = args?.file_path || args?.path || args?.filePath || args?.absolute_path;
      pendingTools.push({ name: p.name, path: typeof fp === 'string' ? fp : undefined });
      continue;
    }
    if (rec.type === 'response_item' && p.type === 'function_call_output') {
      const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
      if (looksLikeError(out)) {
        pendingTools.push({ name: 'unknown-tool', error: true, errSig: errorSigOf(out) });
      }
      continue;
    }
    if (rec.type === 'event_msg' && p.type === 'token_count') {
      const u = p.info?.last_token_usage;
      if (!u) continue;
      flush();
      pendingTs = rec.timestamp || new Date().toISOString();
      pendingTokens = {
        input: Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0)),
        output: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0),
        cacheRead: u.cached_input_tokens || 0,
        cacheWrite: u.cache_write_input_tokens || 0,
      };
      const sessionId = head.sessionId || path.basename(file, '.jsonl');
      events.push({
        ts: pendingTs,
        agent: 'codex',
        sessionId,
        projectDir: head.cwd || '',
        model: head.model || 'unknown',
        inputTokens: pendingTokens.input,
        outputTokens: pendingTokens.output,
        cacheReadTokens: pendingTokens.cacheRead,
        cacheWriteTokens: pendingTokens.cacheWrite,
        meta: { sourceFile: file },
      });
    }
  }
  // 挂起的 token 事件也要出 trace
  flush();

  return { events, traces, head: JSON.stringify(head) };
}

/** 文件头部的 session_meta（增量模式下没有它，需要单独读） */
function readHead(file: string): CodexHead | undefined {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(65536, fs.statSync(file).size));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.toString('utf8', 0, n);
      const firstLine = text.split('\n')[0];
      const rec = JSON.parse(firstLine) as CodexRecord;
      if (rec.type === 'session_meta') {
        return { cwd: rec.payload?.cwd, sessionId: rec.payload?.session_id };
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return undefined;
}

function safeParseJson(text?: string): any {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function looksLikeError(text: string): boolean {
  const t = text.slice(0, 300);
  return /^\s*(error|exception|traceback|failed)/i.test(t) || /"error"\s*:/.test(t);
}

function errorSigOf(text: string): string {
  return errorSignature(text.slice(0, 500));
}

function safeParseHead(raw: string): CodexHead | undefined {
  try {
    return JSON.parse(raw) as CodexHead;
  } catch {
    return undefined;
  }
}
