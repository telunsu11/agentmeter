import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  AgentAdapter,
  AdapterContext,
  ParseOutcome,
  listJsonl,
} from '../core/scanner.js';
import { TokenTotals, TurnTrace, UsageEvent } from '../core/model.js';
import { inferProjectDir, parseJsonLines, readFileTail } from '../core/util.js';
import { pickPath } from './claude.js';

/**
 * ZCode 适配器
 * 数据：~/.zcode/cli/rollout/model-io-[sess_<id>].jsonl
 * 每行一次完整模型请求：request.body + response.usage（camelCase token 字段）。
 * 日志本身不含 cwd —— 项目目录从 system 提示词中的 workspace/工作目录声明提取，
 * 提取不到时从工具调用路径推断。
 */

interface ZCodeRecord {
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  requestId?: string;
  attempt?: number;
  turnId?: string;
  sessionId?: string;
  querySource?: string; // main_turn | session_title | web_fetch_processing
  model?: { modelId?: string; providerId?: string; role?: string; variant?: string };
  request?: { body?: { model?: string; max_tokens?: number; system?: any; messages?: any[] } };
  response?: {
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    finishReason?: string;
    toolCalls?: { id?: string; name?: string; input?: any }[];
    modelId?: string;
  };
}

const DIR_RE = /(?:working directory|workspace|project directory|工作目录|项目目录)[:\s`«»"']*(\/[^\s`"'\]]+)/i;

interface ZCodeHead {
  /** system 提示词中声明的工作目录 */
  dir?: string;
  /** 见过的工具路径样本（推断项目目录用） */
  samplePaths?: string[];
}

export const zcodeAdapter: AgentAdapter = {
  id: 'zcode',
  displayName: 'ZCode',

  defaultDir(): string {
    if (process.env.ZCODE_HOME) return process.env.ZCODE_HOME;
    return path.join(os.homedir(), '.zcode');
  },

  listFiles(dir: string): string[] {
    return listJsonl(path.join(dir, 'cli', 'rollout'));
  },

  parseFull(file: string): ParseOutcome {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    const stat = fs.statSync(file);
    return { ...parseZCodeLines(lines, file, undefined), nextOffset: stat.size };
  },

  parseIncremental(file: string, offset: number, ctx: AdapterContext): ParseOutcome {
    const tail = readFileTail(file, offset);
    const head: ZCodeHead | undefined = ctx.entry?.head ? safeParseHead(ctx.entry.head) : undefined;
    const out = parseZCodeLines(tail.lines, file, head);
    return { ...out, nextOffset: tail.nextOffset };
  },
};

function parseZCodeLines(
  lines: string[],
  file: string,
  prevHead: ZCodeHead | undefined,
): { events: UsageEvent[]; traces: TurnTrace[]; head?: string } {
  const records = parseJsonLines<ZCodeRecord>(lines);
  const events: UsageEvent[] = [];
  const traces: TurnTrace[] = [];
  const head: ZCodeHead = { dir: prevHead?.dir, samplePaths: [...(prevHead?.samplePaths || [])] };

  const fileSessionId = matchSessionId(file);

  for (const rec of records) {
    const usage = rec.response?.usage;
    if (!usage) continue; // 未完成/被中断的请求不产生用量

    const ts = rec.completedAt || rec.startedAt || new Date().toISOString();
    const model = (
      rec.model?.modelId ||
      rec.response?.modelId ||
      rec.request?.body?.model ||
      'unknown'
    ).toLowerCase();
    const sessionId = rec.sessionId || fileSessionId;
    const internal = rec.querySource === 'session_title';

    // 先收集工具路径（推断项目目录要用），再解析目录
    const tools = (rec.response?.toolCalls || [])
      .filter((tc) => tc?.name)
      .map((tc) => {
        const p = pickPath(tc.input);
        if (p && p.startsWith('/') && (head.samplePaths?.length || 0) < 64) {
          if (!head.samplePaths!.includes(p)) head.samplePaths!.push(p);
        }
        return { name: tc.name as string, path: p };
      });
    const projectDir = resolveDir(rec, head);
    const isApiError = (rec.response?.finishReason || '').toLowerCase().includes('error');

    const event: UsageEvent = {
      ts,
      agent: 'zcode',
      sessionId,
      turnId: rec.turnId,
      projectDir,
      model,
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      cacheReadTokens: usage.cacheReadTokens || 0,
      cacheWriteTokens: usage.cacheWriteTokens || 0,
      meta: {
        attempt: rec.attempt,
        isApiError,
        requestId: rec.requestId,
        durationMs: rec.durationMs,
        internal,
        sourceFile: file,
      },
    };
    events.push(event);

    const tokens: TokenTotals = {
      input: event.inputTokens,
      output: event.outputTokens,
      cacheRead: event.cacheReadTokens,
      cacheWrite: event.cacheWriteTokens,
    };
    traces.push({
      ts,
      agent: 'zcode',
      sessionId,
      projectDir,
      model,
      tokens,
      tools,
      flags: { isApiError, attempt: rec.attempt, internal },
    });
  }

  return { events, traces, head: JSON.stringify(head) };
}

function resolveDir(rec: ZCodeRecord, head: ZCodeHead): string {
  if (head.dir) return head.dir;
  const system = rec.request?.body?.system;
  const texts: string[] = [];
  if (typeof system === 'string') texts.push(system);
  else if (Array.isArray(system)) {
    for (const s of system) {
      if (typeof s === 'string') texts.push(s);
      else if (s && typeof s.text === 'string') texts.push(s.text);
    }
  }
  for (const t of texts) {
    const m = DIR_RE.exec(t);
    if (m) {
      head.dir = m[1];
      return head.dir;
    }
  }
  if (head.samplePaths && head.samplePaths.length > 0 && !head.dir) {
    head.dir = inferProjectDir(head.samplePaths);
    return head.dir;
  }
  return '';
}

function matchSessionId(file: string): string {
  const m = /sess_([0-9a-f-]+)/.exec(path.basename(file));
  return m ? m[1] : path.basename(file, '.jsonl');
}

function safeParseHead(raw: string): ZCodeHead | undefined {
  try {
    return JSON.parse(raw) as ZCodeHead;
  } catch {
    return undefined;
  }
}
