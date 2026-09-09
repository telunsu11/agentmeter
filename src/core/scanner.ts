import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentId, TurnTrace, UsageEvent, AgentMeterConfig } from './model.js';
import { readFileTail } from './util.js';

/**
 * 增量扫描器：
 * - 首次扫描解析全部日志文件，结果（小体积的 UsageEvent/TurnTrace）落盘缓存
 * - 之后只对 size/mtime 变化的文件从上次 offset 继续解析
 * - 缓存只存聚合事件与脱敏轨迹，绝不落任何对话正文 —— 隐私承诺的一部分
 */

const CACHE_VERSION = 4;

export interface FileScanEntry {
  size: number;
  mtimeMs: number;
  offset: number;
  events: UsageEvent[];
  traces: TurnTrace[];
  /** adapter 私有的跨增量上下文（如 codex 的 session 元信息），opaque to scanner */
  head?: string;
  /** 已发出的去重键（fnv 哈希），防追加解析重复计数 */
  dedup?: string[];
}

export interface AgentCache {
  version: number;
  files: Record<string, FileScanEntry>;
}

export interface AdapterContext {
  /** 缓存条目（可能是 undefined = 全新文件） */
  entry?: FileScanEntry;
}

export interface ParseOutcome {
  /** 本轮新解析出的事件/轨迹（增量模式）或全量（整文件模式） */
  events: UsageEvent[];
  traces: TurnTrace[];
  /** 新 offset；整文件模式 = 文件大小 */
  nextOffset: number;
  head?: string;
  dedup?: string[];
}

export interface AgentAdapter {
  id: AgentId;
  displayName: string;
  /**
   * append：日志是追加式 JSONL，支持 offset 增量（默认）
   * snapshot：数据是单个数据库/索引文件，mtime 变化时整体重解析替换
   */
  mode?: 'append' | 'snapshot';
  /** 数据根目录（默认；可被 config.paths 覆盖） */
  defaultDir(): string;
  /** 枚举数据文件 */
  listFiles(dir: string): string[];
  /** 增量解析：offset 起的新内容 */
  parseIncremental(file: string, offset: number, ctx: AdapterContext): ParseOutcome;
  /** 整文件解析（新文件 / 截断 / --rescan） */
  parseFull(file: string): ParseOutcome;
}

export interface SourceInfo {
  agent: AgentId;
  dir: string;
  files: number;
  events: number;
  cached: boolean;
}

export interface ScanResult {
  events: UsageEvent[];
  traces: TurnTrace[];
  sources: SourceInfo[];
  /** 本次扫描实际解析的文件数（0 = 全部命中缓存） */
  parsedFiles: number;
  scanMs: number;
}

export function defaultCacheDir(): string {
  return process.env.AGENTMETER_CACHE_DIR || path.join(os.homedir(), '.cache', 'agentmeter');
}

export interface ScanOptions {
  adapters: AgentAdapter[];
  config?: AgentMeterConfig;
  cacheDir?: string;
  /** 无视缓存全量重扫 */
  rescan?: boolean;
  /** 只要事件、不要轨迹（省内存） */
  withTraces?: boolean;
}

export class Scanner {
  private cacheDir: string;
  private adapters: AgentAdapter[];
  private config: AgentMeterConfig;
  private rescan: boolean;

  constructor(opts: ScanOptions) {
    this.cacheDir = opts.cacheDir || defaultCacheDir();
    this.adapters = opts.adapters;
    this.config = opts.config || {};
    this.rescan = opts.rescan || false;
  }

  private cacheFile(agent: AgentId): string {
    return path.join(this.cacheDir, `cache-${agent}.json`);
  }

  private loadCache(agent: AgentId): AgentCache {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile(agent), 'utf8'));
      if (raw && raw.version === CACHE_VERSION) return raw as AgentCache;
    } catch {}
    return { version: CACHE_VERSION, files: {} };
  }

  private saveCache(agent: AgentId, cache: AgentCache): void {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const tmp = this.cacheFile(agent) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, this.cacheFile(agent));
  }

  async scan(): Promise<ScanResult> {
    const t0 = Date.now();
    const allEvents: UsageEvent[] = [];
    const allTraces: TurnTrace[] = [];
    const sources: SourceInfo[] = [];
    let parsedFiles = 0;

    for (const adapter of this.adapters) {
      const dir = this.config.paths?.[adapter.id] || adapter.defaultDir();
      const files = safeList(adapter, dir);
      const cache = this.rescan ? ({ version: CACHE_VERSION, files: {} } as AgentCache) : this.loadCache(adapter.id);
      let dirty = this.rescan;

      for (const file of files) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        const prev = cache.files[file];
        const unchanged = prev && !this.rescan && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs;
        if (unchanged) continue;

        // 已删除的文件：保留缓存中的历史事件（用户清日志不丢统计）
        if (prev && !fs.existsSync(file)) continue;

        parsedFiles++;
        dirty = true;
        try {
          const isSnapshot = adapter.mode === 'snapshot';
          const truncated = prev ? stat.size < prev.offset : false;
          const incremental = !isSnapshot && prev && !truncated && !this.rescan && stat.size > prev.offset;
          const outcome = incremental
            ? adapter.parseIncremental(file, prev.offset, { entry: prev })
            : adapter.parseFull(file);
          cache.files[file] = collapseDedup(
            stat.size,
            stat.mtimeMs,
            outcome,
            incremental ? prev : undefined,
          );
        } catch (err) {
          // 单文件解析失败不拖垮整体；保留旧缓存条目
          if (prev) cache.files[file] = { ...prev, size: stat.size, mtimeMs: stat.mtimeMs };
        }
      }

      // 无论当前是否还有文件（可能被清理），缓存里的历史事件都要进入报告
      if (dirty) this.saveCache(adapter.id, cache);

      let evCount = 0;
      for (const entry of Object.values(cache.files)) {
        allEvents.push(...entry.events);
        allTraces.push(...entry.traces);
        evCount += entry.events.length;
      }
      sources.push({ agent: adapter.id, dir, files: files.length, events: evCount, cached: parsedFiles === 0 });
    }

    return {
      events: allEvents,
      traces: allTraces,
      sources,
      parsedFiles,
      scanMs: Date.now() - t0,
    };
  }
}

function safeList(adapter: AgentAdapter, dir: string): string[] {
  try {
    return adapter.listFiles(dir);
  } catch {
    return [];
  }
}

/**
 * 按 meta.dedupKey 折叠事件/轨迹：同一 key 保留用量最大的一对。
 * 背景：Claude Code 流式写入会把一条 assistant 消息拆成多行（共用 message.id），
 * 首行 usage 常为 0、末行才是完整用量；且消息可能跨越两次增量扫描。
 * usage 随流式单调递增，取 max 即真实值。
 */
function collapseDedup(
  size: number,
  mtimeMs: number,
  outcome: ParseOutcome,
  prev?: FileScanEntry,
): FileScanEntry {
  let events = prev ? [...prev.events, ...outcome.events] : outcome.events;
  let traces = prev ? [...prev.traces, ...outcome.traces] : outcome.traces;

  if (events.some((e) => e.meta?.dedupKey)) {
    const byKey = new Map<string, number>(); // key -> 当前最优事件下标
    const kept: UsageEvent[] = [];
    const keptTraces: TurnTrace[] = [];
    for (let i = 0; i < events.length; i++) {
      const key = events[i].meta?.dedupKey;
      if (!key) {
        kept.push(events[i]);
        if (traces[i]) keptTraces.push(traces[i]);
        continue;
      }
      const cur = byKey.get(key);
      if (cur === undefined) {
        byKey.set(key, kept.length);
        kept.push(events[i]);
        if (traces[i]) keptTraces.push(traces[i]);
      } else {
        // 保留用量更大的那条（流式 usage 单调递增）；
        // 但被折叠行的工具调用块（可能分布在不同行）要合并进来，供浪费审计使用
        if (traces[i] && keptTraces[cur]) {
          keptTraces[cur].tools = mergeTools(keptTraces[cur].tools, traces[i].tools);
        }
        if (eventTotal(events[i]) > eventTotal(kept[cur])) {
          kept[cur] = events[i];
          if (traces[i]) keptTraces[cur] = traces[i];
        }
      }
    }
    events = kept;
    traces = keptTraces;
  }

  return {
    size,
    mtimeMs,
    offset: outcome.nextOffset,
    events,
    traces,
    head: outcome.head ?? (prev ? prev.head : undefined),
    dedup: outcome.dedup ?? (prev ? prev.dedup : undefined),
  };
}

function eventTotal(e: UsageEvent): number {
  return e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
}

/** 合并两个工具摘要列表，按 (name|path|errSig|error) 去重 */
function mergeTools(a: TurnTrace['tools'], b: TurnTrace['tools']): TurnTrace['tools'] {
  if (!b || b.length === 0) return a;
  const seen = new Set(a.map((t) => `${t.name}|${t.path || ''}|${t.errSig || ''}|${t.error ? 1 : 0}`));
  const out = [...a];
  for (const t of b) {
    const k = `${t.name}|${t.path || ''}|${t.errSig || ''}|${t.error ? 1 : 0}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

/** 列目录下的 *.jsonl（一层） */
export function listJsonl(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f))
    .sort();
}

/** 递归列 *.jsonl */
export function listJsonlRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}
