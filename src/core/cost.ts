import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelPrice, TokenTotals, UsageEvent, AgentMeterConfig } from './model.js';

/**
 * 成本估算：离线价格表 + 用户覆盖。
 * 订阅制（Claude Max / GLM Coding Plan）用户的真实成本与此无关——
 * 所有输出都标注"估算"，报告默认隐藏成本列（--cost 开启）。
 */

export class CostCalculator {
  private table: ModelPrice[] = [];

  constructor(config?: AgentMeterConfig) {
    this.table = loadDefaultPricing();
    if (config?.pricing) {
      // 用户覆盖排最前（最长 match 优先的整体排序保持不变，覆盖项参与同一排序）
      for (const [pattern, price] of Object.entries(config.pricing)) {
        this.table.unshift({ match: pattern, ...price });
      }
    }
    // 最长匹配优先
    this.table.sort((a, b) => b.match.length - a.match.length);
  }

  priceFor(model: string): ModelPrice | undefined {
    const m = model.toLowerCase();
    return this.table.find((p) => m.includes(p.match));
  }

  /** totals + model → USD；未知价格返回 undefined */
  cost(totals: TokenTotals, model: string): number | undefined {
    const p = this.priceFor(model);
    if (!p) return undefined;
    const c =
      ((totals.input * (p.input ?? 0) +
        totals.output * (p.output ?? 0) +
        totals.cacheRead * (p.cacheRead ?? 0) +
        totals.cacheWrite * (p.cacheWrite ?? 0)) /
        1e6);
    return c > 0 ? c : undefined;
  }

  costOfEvent(e: UsageEvent): number | undefined {
    return this.cost(
      { input: e.inputTokens, output: e.outputTokens, cacheRead: e.cacheReadTokens, cacheWrite: e.cacheWriteTokens },
      e.model,
    );
  }

  /** 一组事件的成本合计；部分未知时返回 {known, unknownTokens} */
  costOfEvents(events: UsageEvent[]): { known: number; unknownTokens: number } {
    let known = 0;
    let unknownTokens = 0;
    for (const e of events) {
      const c = this.costOfEvent(e);
      if (c === undefined) {
        unknownTokens += e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
      } else {
        known += c;
      }
    }
    return { known, unknownTokens };
  }
}

function loadDefaultPricing(): ModelPrice[] {
  const candidates = [
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../pricing/defaults.json'),
    // npm 安装后：dist/core/cost.js → 包根/pricing/defaults.json
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../pricing/defaults.json'),
  ];
  for (const p of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(raw.models)) return raw.models as ModelPrice[];
    } catch {}
  }
  return [];
}
