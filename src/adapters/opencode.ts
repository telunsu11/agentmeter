import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { AgentAdapter, ParseOutcome } from '../core/scanner.js';
import { TurnTrace, UsageEvent } from '../core/model.js';
import { isoFromEpochMs } from '../core/util.js';

/**
 * OpenCode 适配器（snapshot 模式）
 * 数据：~/.local/share/opencode/opencode.db（SQLite）
 * 通过系统 sqlite3 CLI 读取（零原生依赖）；message.data JSON 内带 tokens。
 */

export const opencodeAdapter: AgentAdapter = {
  id: 'opencode',
  displayName: 'OpenCode',
  mode: 'snapshot',

  defaultDir(): string {
    if (process.env.OPENCODE_HOME) return path.join(process.env.OPENCODE_HOME, 'data');
    return path.join(os.homedir(), '.local', 'share', 'opencode');
  },

  listFiles(dir: string): string[] {
    const db = path.join(dir, 'opencode.db');
    return fs.existsSync(db) ? [db] : [];
  },

  parseIncremental(file: string): ParseOutcome {
    return this.parseFull(file);
  },

  parseFull(file: string): ParseOutcome {
    const events: UsageEvent[] = [];
    const traces: TurnTrace[] = [];

    const dirs = queryJson(file, 'SELECT id AS sid, directory AS dir FROM session;');
    const dirBySession = new Map<string, string>();
    for (const row of dirs) {
      if (row.sid) dirBySession.set(String(row.sid), row.dir ? String(row.dir) : '');
    }

    const rows = queryJson(
      file,
      "SELECT m.id AS mid, m.session_id AS sid, m.time_created AS t, m.data AS data FROM message m WHERE json_extract(m.data,'$.tokens') IS NOT NULL ORDER BY m.time_created;",
    );

    for (const row of rows) {
      try {
        const data = JSON.parse(row.data);
        const tokens = data?.tokens || {};
        const cache = tokens.cache || {};
        const model = String(data?.model?.modelID || 'unknown').toLowerCase();
        const sessionId = String(row.sid || '');
        const projectDir = dirBySession.get(sessionId) || '';
        const ts = isoFromEpochMs(Number(row.t) || 0);
        const input = Number(tokens.input) || 0;
        const output = (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0);
        const cacheRead = Number(cache.read) || 0;
        const cacheWrite = Number(cache.write) || 0;
        const event: UsageEvent = {
          ts,
          agent: 'opencode',
          sessionId,
          projectDir,
          model,
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          meta: { sourceFile: file },
        };
        events.push(event);
        traces.push({
          ts,
          agent: 'opencode',
          sessionId,
          projectDir,
          model,
          tokens: { input, output, cacheRead, cacheWrite },
          tools: [],
          flags: {},
        });
      } catch {
        /* 单行坏数据跳过 */
      }
    }

    const stat = fs.statSync(file);
    return { events, traces, nextOffset: stat.size };
  },
};

/** sqlite3 CLI → JSON 行 */
function queryJson(db: string, sql: string): any[] {
  let stdout: string;
  try {
    stdout = execFileSync('sqlite3', ['-json', db, sql], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return [];
  }
  const text = stdout.trim();
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch {
    // sqlite3 -json 输出多段 JSON（大数据集）时按行拼接处理
    const parsed: any[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        parsed.push(...JSON.parse(line));
      } catch {}
    }
    return parsed;
  }
}
