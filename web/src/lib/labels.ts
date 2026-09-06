'use client';
// 展示标签字典 + 信号分类 + 格式化函数（移植 app.js L6-16 LABELS / chgClass / fmtPrice / fmtChannels / fmtHero）
export const LABELS: Record<string, Record<string, string>> = {
  channels: {
    tiktokShop: 'TikTok Shop',
    amazon: 'Amazon',
    shopifyDTC: 'Shopify 独立站',
    xiaohongshu: '小红书',
    instagramShop: 'Instagram Shop',
    etsy: 'Etsy',
    offlineRetail: '线下零售',
    tmallJD: '天猫/京东',
  },
  regions: { us: '美国', uk: '英国', eu: '欧洲', cn: '中国', jp: '日本', sea: '东南亚' },
  tier: { large: '头部', mid: '腰部', small: '小体量', emerging: '新兴', unknown: '体量未明' },
  priceBands: { mass: '大众档', mid: '中端', premium: '高端', ultra: '超高端' },
};

export function lbl(group: string, k: string): string {
  return (LABELS[group] && LABELS[group][k]) || k;
}

// 动作/信号文本 → 涨跌性质（移植 app.js chgClass，L1990-1996）
export function chgClass(label: string): 'down' | 'up' | 'crisis' | 'info' {
  const l = label || '';
  if (/降价|价格|跌|降|促销|折扣|调价/.test(l)) return 'down';
  if (/上新|新渠道|开通|开店|上架|新品|独立站|迁移|拓展|进|开/.test(l)) return 'up';
  if (/差评|暴涨|危机|负面/.test(l)) return 'crisis';
  return 'info';
}

// 竞品卡价格行（移植 app.js fmtPrice，L1906-1917）
export function fmtPrice(c: Record<string, unknown>): string {
  const hp = (c.heroProduct as { corePriceBand?: { min?: number; max?: number; currency?: string } } | null) || null;
  const band = hp && hp.corePriceBand;
  if (band && (band.min != null || band.max != null)) {
    const cur = band.currency || (c.currency as string) || '';
    const lo = band.min != null ? band.min : '?';
    const hi = band.max != null ? band.max : '?';
    return `${cur}${lo}–${hi}`;
  }
  const pb = c.priceBand as { range?: string } | undefined;
  if (pb && pb.range) return pb.range;
  const pf = c.priceField as { display?: string } | undefined;
  if (pf && pf.display) return pf.display;
  return '价位未明';
}

// 渠道摘要（移植 app.js fmtChannels，L1926-1931）
export function fmtChannels(c: Record<string, unknown>): string {
  const ch = (c.channels || {}) as Record<string, { present?: boolean }>;
  const present = Object.keys(ch).filter((k) => ch[k] && ch[k].present);
  if (!present.length) return '渠道未明';
  return present.slice(0, 4).map((k) => lbl('channels', k)).join('、');
}

// 主推产品（移植 app.js fmtHero，L1932-1936）
export function fmtHero(c: Record<string, unknown>): string {
  const hp = c.heroProduct as { heroProducts?: { name: string }[] } | null | undefined;
  if (!hp || !hp.heroProducts || !hp.heroProducts.length) return '未识别主推';
  return hp.heroProducts[0].name;
}
