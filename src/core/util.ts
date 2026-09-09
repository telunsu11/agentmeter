import * as fs from 'node:fs';
import * as path from 'node:path';

/** FNV-1a 32bit 哈希，输出 8 位十六进制。用于错误签名/去重键，不存原文。 */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 归一化错误文本 → 签名：去掉数字、十六进制、引号内容、绝对路径后哈希。
 * 目标是让"同一类错误"（只有 id/路径/数字不同）得到同一签名。
 */
export function errorSignature(text: string): string {
  const norm = text
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, 'h')
    .replace(/[0-9]+/g, 'n')
    .replace(/"[^"]*"|'[^']*'/g, '"s"')
    .replace(/(\/[\w.@-]+)+\/?/g, 'path')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return fnv1a(norm);
}

export interface FileTail {
  /** offset 起的完整行（含末尾不完整但已是合法 JSON 的行） */
  lines: string[];
  /** 下次应使用的 offset */
  nextOffset: number;
  size: number;
}

/** 从 offset 起读文件尾部，只返回完整行；最后一行若能成功 JSON.parse 也视为完整。 */
export function readFileTail(file: string, offset: number): FileTail {
  const stat = fs.statSync(file);
  const size = stat.size;
  if (offset >= size) return { lines: [], nextOffset: offset, size };
  const fd = fs.openSync(file, 'r');
  try {
    const len = size - offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    const text = buf.toString('utf8');
    const lines: string[] = [];
    let lastNl = text.lastIndexOf('\n');
    let nextOffset = offset;
    if (lastNl === -1) {
      // 没有换行符：可能仍在写入中
      if (isCompleteJson(text)) {
        lines.push(text);
        nextOffset = size;
      }
      return { lines, nextOffset, size };
    }
    const complete = text.slice(0, lastNl);
    nextOffset = offset + Buffer.byteLength(complete, 'utf8') + 1;
    for (const line of complete.split('\n')) {
      if (line.trim()) lines.push(line);
    }
    const rest = text.slice(lastNl + 1);
    if (rest.trim() && isCompleteJson(rest)) {
      lines.push(rest);
      nextOffset = size;
    }
    return { lines, nextOffset, size };
  } finally {
    fs.closeSync(fd);
  }
}

function isCompleteJson(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/** 逐行解析 JSON，坏行跳过（可选回调收集坏行数） */
export function parseJsonLines<T = any>(lines: string[]): T[] {
  const out: T[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 日志写入中途的坏行，忽略 */
    }
  }
  return out;
}

/** Claude Code 的目录名编码：/Users/carry/foo → -Users-carry-foo（尽力还原） */
export function unmungeClaudeDir(name: string): string {
  return name.replace(/^-/, '/').replace(/-/g, '/');
}

/** 从一组绝对路径推断"项目目录"：最长公共前缀目录 */
export function inferProjectDir(paths: string[]): string {
  const abs = paths.filter((p) => p && p.startsWith('/'));
  if (abs.length === 0) return '';
  if (abs.length === 1) {
    // 单一路径：向上找到含 .git 的最近祖先，否则取上两级
    let dir = path.dirname(abs[0]);
    let cur = dir;
    for (let i = 0; i < 8 && cur !== '/'; i++) {
      try {
        if (fs.existsSync(path.join(cur, '.git'))) return cur;
      } catch {}
      cur = path.dirname(cur);
    }
    return dir;
  }
  let prefix = path.dirname(abs[0]);
  for (const p of abs.slice(1)) {
    while (prefix !== '/' && !path.dirname(p).startsWith(prefix)) {
      prefix = path.dirname(prefix);
    }
  }
  if (prefix === '/') {
    // 公共前缀太浅没有意义，退回单路径策略
    return inferProjectDir([abs[0]]);
  }
  return prefix;
}

export function isoFromEpochMs(ms: number): string {
  return new Date(ms).toISOString();
}

/** 本地时区（可被配置覆盖） */
export function localTimezone(override?: string): string {
  if (override) return override;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** 在指定时区下取"某时间戳所在自然日"的 YYYY-MM-DD */
export function dayKey(tsIso: string, tz: string): string {
  const d = new Date(tsIso);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function monthKey(tsIso: string, tz: string): string {
  return dayKey(tsIso, tz).slice(0, 7);
}

/** 时区感知的日期解析（把 YYYY-MM-DD 当作 tz 内的日期，返回 UTC 时间戳） */
export function dateKeyToUtc(dateKey: string, tz: string): number {
  // en-CA 格式 YYYY-MM-DD → 用"本地=目标时区"技巧：构造 UTC 午夜再按偏移校正
  const [y, m, d] = dateKey.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 12); // 取中午避免边界
  // 求该时刻在 tz 的日期，再算 tz 午夜对应 UTC
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  for (let deltaH = -14; deltaH <= 14; deltaH++) {
    const t = guess + deltaH * 3600_000;
    if (fmt.format(new Date(t)) === dateKey) {
      // t 是该日中午附近；回推到当天 00:00
      const hourInTz = Number(
        new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(t)),
      );
      return t - hourInTz * 3600_000;
    }
  }
  return guess;
}
