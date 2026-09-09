import { TokenTotals } from '../core/model.js';

/** 终端渲染：颜色 / 数字 / 表格。零依赖，自绘。 */

let colorEnabled: boolean | null = null;

export function useColor(enabled: boolean): void {
  colorEnabled = enabled;
}

function c(code: string, s: string): string {
  if (colorEnabled === false) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}

export const C = {
  dim: (s: string) => c('2', s),
  bold: (s: string) => c('1', s),
  red: (s: string) => c('31', s),
  green: (s: string) => c('32', s),
  yellow: (s: string) => c('33', s),
  blue: (s: string) => c('34', s),
  magenta: (s: string) => c('35', s),
  cyan: (s: string) => c('36', s),
  gray: (s: string) => c('90', s),
};

export function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

/** 1234567 → 1.23M */
export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

export function fmtUsd(n: number): string {
  if (n >= 100) return '$' + n.toFixed(0);
  if (n >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(n < 0.01 ? 4 : 3);
}

export function fmtPct(x: number, digits = 0): string {
  return (x * 100).toFixed(digits) + '%';
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

/** 终端可见宽度（非 TTY 时 100） */
export function termWidth(): number {
  return (process.stdout.columns && process.stdout.columns > 0) ? process.stdout.columns : 100;
}

export interface Column {
  header: string;
  /** 数字列右对齐 */
  align?: 'left' | 'right';
  color?: (s: string) => string;
  width?: number;
}

export function renderTable(cols: Column[], rows: string[][], opts?: { maxWidth?: number }): string {
  const widths = cols.map((col, i) => {
    const dataW = Math.max(col.header.length, ...rows.map((r) => stripAnsi(r[i] || '').length));
    const w = Math.min(col.width ?? dataW, dataW);
    return w;
  });
  const pad = (s: string, w: number, align: 'left' | 'right') => {
    const visible = stripAnsi(s);
    const gap = Math.max(0, w - visible.length);
    return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
  };
  const headerLine = cols
    .map((col, i) => pad(col.header, widths[i], col.align || 'left'))
    .join('  ');
  const sepLine = widths.map((w) => '─'.repeat(w)).join('  ');
  const lines = [C.bold(headerLine), C.gray(sepLine)];
  for (const row of rows) {
    lines.push(cols.map((col, i) => {
      const cell = pad(row[i] || '', widths[i], col.align || 'left');
      return col.color ? col.color(cell) : cell;
    }).join('  '));
  }
  return lines.join('\n');
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** 横向柱状图（按最大值归一） */
export function bar(value: number, max: number, width = 20): string {
  if (max <= 0) return '';
  const filled = Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width));
  return '█'.repeat(Math.min(filled, width)) + C.gray('░'.repeat(Math.max(0, width - filled)));
}

export function colorForAgent(agent: string): (s: string) => string {
  switch (agent) {
    case 'claude': return C.magenta;
    case 'zcode': return C.cyan;
    case 'codex': return C.green;
    case 'opencode': return C.yellow;
    default: return (s: string) => s;
  }
}

export function shortenDir(dir: string, max = 38): string {
  const s = dir.replace(/^\/Users\/[^/]+/, '~');
  if (s.length <= max) return s;
  return '…' + s.slice(-(max - 1));
}

export function totalsBreakdown(t: TokenTotals): string {
  return [
    `in ${fmtTokens(t.input)}`,
    `out ${fmtTokens(t.output)}`,
    `cacheR ${fmtTokens(t.cacheRead)}`,
    `cacheW ${fmtTokens(t.cacheWrite)}`,
  ].join('  ');
}
