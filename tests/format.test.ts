import { describe, it, expect } from 'vitest';
import { visualWidth, padVisual, renderTable, stripAnsi } from '../src/cli/format.js';

describe('终端视觉宽度', () => {
  it('CJK/全角/emoji 占 2 列，ASCII 占 1 列', () => {
    expect(visualWidth('abc')).toBe(3);
    expect(visualWidth('加权')).toBe(4);
    expect(visualWidth('发生时间')).toBe(8);
    expect(visualWidth('３')).toBe(2); // 全角数字
    expect(visualWidth('⚡')).toBe(2);
  });

  it('ANSI 颜色码不计宽', () => {
    expect(visualWidth('\x1b[31m加权\x1b[0m')).toBe(4);
    expect(visualWidth('\x1b[1magent\x1b[0m')).toBe(5);
  });

  it('padVisual 按视觉宽度补齐', () => {
    expect(visualWidth(padVisual('加权', 8))).toBe(8);
    expect(visualWidth(padVisual('abc', 5))).toBe(5);
    expect(padVisual('7', 3, 'right')).toBe('  7');
  });
});

describe('表格对齐', () => {
  it('中文表头与 ASCII 数据列对齐（每行视觉总宽严格一致）', () => {
    const rows = [
      ['API 错误/重试', '45.99M', '232'],
      ['失败循环', '1.55M', '17'],
    ];
    const headers = ['类型', '加权', '请求'];
    const out = renderTable(
      headers.map((h, i) => ({ header: h, align: i === 0 ? ('left' as const) : ('right' as const) })),
      rows,
    );
    const lines = stripAnsi(out).split('\n');
    expect(lines.length).toBe(4);

    // 期望列宽 = max(表头视觉宽, 各数据行视觉宽)
    const widths = headers.map((h, i) =>
      Math.max(visualWidth(h), ...rows.map((r) => visualWidth(r[i]))),
    );
    // padVisual 会把每列（含末列）补齐到列宽，因此每行视觉总宽 = Σ宽 + 2×(n-1)
    const expectTotal = widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1);
    for (const [idx, line] of lines.entries()) {
      expect(visualWidth(line), `第 ${idx} 行未对齐: "${line}"`).toBe(expectTotal);
    }
  });

  it('右对齐数字列：数据在各自列内右缘对齐', () => {
    const out = renderTable(
      [{ header: '项' }, { header: '数值', align: 'right' }],
      [['甲', '7'], ['乙', '1234']],
    );
    const lines = stripAnsi(out).split('\n');
    // 列宽：第0列=2（项/甲/乙 均为 2 视觉宽），第1列=4（表头"数值"=4，数据 max=4）
    // 每行总视觉宽 = 2 + 2 + 4 = 8
    for (const line of lines) {
      expect(visualWidth(line)).toBe(8);
    }
    // 右对齐：数字贴列右缘
    expect(lines[2].endsWith('   7')).toBe(true);
    expect(lines[3].endsWith('1234')).toBe(true);
  });
});
