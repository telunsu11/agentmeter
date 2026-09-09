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
import { errorSignature, fnv1a, parseJsonLines, readFileTail, unmungeClaudeDir } from '../core/util.js';

/**
 * Claude Code 适配器
 * 数据：~/.claude/projects/<munged-cwd>/<sessionId>.jsonl
 * 每行一条消息记录；assistant 记录带 message.usage。
 * 重复计数防御：Claude Code 偶尔会把同一 message.id 重复落盘，按 id 去重。
 */

interface ClaudeRecord {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  requestId?: string;
  cwd?: string;
  uuid?: string;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  message?: {
    id?: string;
    model?: string;
    content?: any;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

const DEDUP_CAP = 5000;

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  displayName: 'Claude Code',

  defaultDir(): string {
    if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
    return path.join(os.homedir(), '.claude');
  },

  listFiles(dir: string): string[] {
    return listJsonlRecursive(path.join(dir, 'projects'));
  },

  parseFull(file: string): ParseOutcome {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    const stat = fs.statSync(file);
    const outcome = parseClaudeLines(lines, file, undefined);
    return { ...outcome, nextOffset: stat.size };
  },

  parseIncremental(file: string, offset: number, ctx: AdapterContext): ParseOutcome {
    const tail = readFileTail(file, offset);
    const outcome = parseClaudeLines(tail.lines, file, ctx.entry);
    return { ...outcome, nextOffset: tail.nextOffset };
  },
};

function parseClaudeLines(
  lines: string[],
  file: string,
  prev?: { dedup?: string[] },
): { events: UsageEvent[]; traces: TurnTrace[]; dedup?: string[] } {
  const records = parseJsonLines<ClaudeRecord>(lines);
  const events: UsageEvent[] = [];
  const traces: TurnTrace[] = [];
  const dedup = new Set<string>(prev?.dedup || []);
  const newKeys: string[] = [];

  // 跨 assistant 事件的挂起工具结果（错误信息），归入下一个 trace
  let pendingErrors: { name: string; error: boolean; errSig?: string }[] = [];
  const toolUseNames = new Map<string, string>(); // tool_use_id -> tool name

  for (const rec of records) {
    if (rec.type === 'user') {
      collectToolResults(rec, toolUseNames, (e) => pendingErrors.push(e));
      continue;
    }
    if (rec.type !== 'assistant' || !rec.message?.usage) continue;

    const msg = rec.message;
    const key = fnv1a(`${msg.id || rec.uuid || ''}:${rec.requestId || ''}`);
    if (dedup.has(key)) continue;
    dedup.add(key);
    newKeys.push(key);

    const u = msg.usage || {};
    const model = (msg.model || 'unknown').toLowerCase();
    const ts = rec.timestamp || new Date().toISOString();
    const projectDir = rec.cwd || unmungeClaudeDir(path.basename(path.dirname(file)));

    const event: UsageEvent = {
      ts,
      agent: 'claude',
      sessionId: rec.sessionId || path.basename(file, '.jsonl'),
      projectDir,
      model,
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cacheReadTokens: u.cache_read_input_tokens || 0,
      cacheWriteTokens: u.cache_creation_input_tokens || 0,
      meta: {
        requestId: rec.requestId,
        isApiError: rec.isApiErrorMessage === true,
        subagent: rec.isSidechain === true,
        sourceFile: file,
      },
    };
    events.push(event);

    // trace：本条消息里的 tool_use + 上一轮积累的 tool_result 错误
    const tools: TurnTrace['tools'] = [];
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (block?.type === 'tool_use' && block.name) {
        const p = pickPath(block.input);
        tools.push({ name: block.name, path: p });
        if (block.id) toolUseNames.set(block.id, block.name);
      }
    }
    for (const pe of pendingErrors) tools.push({ name: pe.name, error: true, errSig: pe.errSig });
    pendingErrors = [];
    const tokens: TokenTotals = {
      input: event.inputTokens,
      output: event.outputTokens,
      cacheRead: event.cacheReadTokens,
      cacheWrite: event.cacheWriteTokens,
    };
    traces.push({
      ts,
      agent: 'claude',
      sessionId: event.sessionId,
      projectDir,
      model,
      tokens,
      tools,
      flags: { isApiError: event.meta?.isApiError === true },
    });
  }

  // dedup 数组封顶，防止无界增长
  const keep = [...dedup].slice(-DEDUP_CAP);
  return { events, traces, dedup: keep };
}

/** 从 user 记录的 tool_result 里提取错误（归入 pendingErrors） */
function collectToolResults(
  rec: ClaudeRecord,
  toolUseNames: Map<string, string>,
  onError: (e: { name: string; error: boolean; errSig?: string }) => void,
): void {
  const content = rec.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type !== 'tool_result') continue;
    const text = extractText(block.content);
    const isError = block.is_error === true || /^\s*error\b/i.test(text) || text.includes('<error>');
    if (!isError) continue;
    onError({
      name: toolUseNames.get(block.tool_use_id) || 'unknown-tool',
      error: true,
      errSig: errorSignature(text.slice(0, 500)),
    });
  }
}

function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === 'string' ? c : c?.text || ''))
      .join(' ');
  }
  return '';
}

export function pickPath(input: any): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  return input.file_path || input.path || input.filePath || input.notebook_path || input.absolute_path;
}
