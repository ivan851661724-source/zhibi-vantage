'use client';
// 演示模式（F-04，复刻 app.js L194-257 的 DEMO_MODE/mockDemoState）
// URL 带 ?demo=1 直进工作台，用 public/mock 演示数据构造 state（/api/state 契约），不连后端。
// 闸门：服务端 GET /api/public-config 返回 demoAllowed（由环境变量 ZB_DEMO_ALLOWED=1 控制），
//       生产未开启时登录页拦截并显示「演示模式未启用」屏。
// 跨路由保持：进入演示时写 sessionStorage 标记（Next.js 多路由跳转后 URL 参数会丢失），
//             退出登录（clearToken）时清除。

export const DEMO_FLAG = 'zhibi_demo';
export const DEMO_TOKEN = 'demo-token'; // 与旧版一致的占位 token（仅过前端鉴权门，不调后端）

export function isDemoMode(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (/[?&]demo=1/.test(window.location.search)) return true;
    return window.sessionStorage.getItem(DEMO_FLAG) === '1';
  } catch {
    return false;
  }
}

/** 进入演示模式（登录页闸门放行后调用）：写标记，供后续路由识别 */
export function enterDemo(): void {
  try {
    window.sessionStorage.setItem(DEMO_FLAG, '1');
  } catch {
    /* 隐私模式等场景静默 */
  }
}

/** 退出演示模式（登出时调用） */
export function exitDemo(): void {
  try {
    window.sessionStorage.removeItem(DEMO_FLAG);
  } catch {
    /* 同上 */
  }
}

// ---------- mock 数据视图模型（对应 public/mock/*.json） ----------
interface MockRival {
  id: string;
  name: string;
  relation?: string;
  relationLabel?: string;
  price?: { from?: number; currency?: string; band?: string };
  channels?: { label?: string; tier?: string }[];
  latestAction?: { text?: string; detail?: string; when?: string };
}
interface MockMaterial {
  id: string;
  [k: string]: unknown;
}
interface MockOpp {
  id: string;
  title: string;
  desc: string;
  score: number;
  breadth: string;
  confidence?: string;
  confidenceLabel: string;
  methodKey?: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  try {
    const r = await fetch(url);
    if (!r.ok) return [] as unknown as T;
    return (await r.json()) as T;
  } catch {
    return [] as unknown as T;
  }
}

/** 构造演示 state（逐行移植 app.js mockDemoState L197-256） */
export async function buildDemoState(): Promise<Record<string, unknown>> {
  const [mats, rivals, opps] = await Promise.all([
    fetchJson<MockMaterial[]>('/mock/materials.json'),
    fetchJson<MockRival[]>('/mock/rivals.json'),
    fetchJson<MockOpp[]>('/mock/opportunities.json'),
  ]);
  const REL_CODE: Record<string, string> = { direct: 'direct', ref: 'indirect', cheap: 'unrelated' };
  const SYM: Record<string, string> = { GBP: '£', USD: '$', JPY: '¥', EUR: '€' };
  const competitors = (Array.isArray(rivals) ? rivals : []).map((r, i) => {
    const ch: Record<string, unknown> = {};
    (r.channels || []).forEach((c) => {
      ch['ch_' + i + '_' + (c.label || i)] = {
        present: c.tier === 'ok',
        state: c.tier === 'ok' ? 'present' : 'undetected',
        label: c.label,
      };
    });
    const dom = String(r.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return {
      id: r.id,
      name: r.name,
      status: 'done',
      rankScore: 92 - i * 6,
      category: '潮流玩具',
      tier: i === 0 ? 'large' : i < 3 ? 'mid' : 'small',
      url: 'https://' + (dom || 'brand') + '.com',
      relationship: { code: REL_CODE[r.relation || ''] || 'undetermined', label: r.relationLabel || '直接对手' },
      priceBand: { band: 'mid', range: (r.price && r.price.band) || '', currency: (r.price && r.price.currency) || 'USD', basis: 'verified' },
      pricePoints: r.price && r.price.from != null ? [r.price.from] : [],
      priceField: r.price ? { display: (SYM[r.price.currency || ''] || '$') + r.price.from, basis: 'verified' } : null,
      channels: ch,
      currency: (r.price && r.price.currency) || 'USD',
      reviews: { rating: +(4.2 + (i % 3) * 0.2).toFixed(1), basis: 'verified' },
      launchCadence: { value: i % 2 ? '季度系列制' : '月更', basis: 'verified' },
      recentActions: r.latestAction
        ? { hasAction: true, action: { label: r.latestAction.text, desc: r.latestAction.detail, when: r.latestAction.when } }
        : { hasAction: false },
      heroProduct: { heroProducts: [{ name: (r.latestAction && r.latestAction.detail) || '主推款' }] },
      evidenceCount: 3,
    };
  });
  // 材料直接复用（mock 格式与工作台视图模型一致）
  const materials = (Array.isArray(mats) ? mats : []).map((m) => ({ ...m, id: 'demo_' + m.id }));
  // 机会 themes
  const themes = (Array.isArray(opps) ? opps : []).map((o) => ({
    id: o.id,
    label: o.title,
    note: o.desc,
    opportunity: o.score,
    denominatorText: o.breadth,
    zone: o.confidence === 'low' || o.confidenceLabel.includes('低') ? 'served' : 'underserved',
    method: '机会引擎',
    oid: o.methodKey,
  }));
  // 信号条：按材料聚合
  const groups: Record<string, string[]> = {};
  materials.forEach((raw) => {
    const m = raw as Record<string, unknown>;
    const t = String(m.type || '').toLowerCase();
    const s = String(m.signal || '');
    let g = '上新';
    if (t.includes('down') || (t.includes('price') && s === 'down') || s === 'down') g = '降价';
    else if (t.includes('crisis') || s === 'crisis') g = '差评暴涨';
    else if (t.includes('channel')) g = '开新店';
    else if (t.includes('up') || s === 'up') g = '涨价';
    const nm = ((m.brand as { name?: string } | undefined)?.name as string) || '品牌';
    if (!groups[g]) groups[g] = [];
    groups[g].push(nm);
  });
  const gs = Object.entries(groups)
    .slice(0, 5)
    .map(([label, cs]) => ({ label, note: '', competitors: cs }));
  return {
    projectId: 'demo',
    track: '定制手办 · 潮流玩具',
    intent: {
      goals: ['pricing', 'newlaunch'],
      regions: ['us', 'uk'],
      profile: { priceBand: { min: 199, max: 329, currency: 'CNY' }, sellingPoints: ['customization'] },
      platforms: ['amazon', 'etsy', 'shopifyDTC'],
    },
    competitors,
    materials,
    excluded: [],
    opportunity: { hidden: false, doneBrands: 6, brandsWithVoice: 4, preliminaryThemes: themes, themes },
    radar: { groupSignals: gs },
    whiteSpace: null,
    excludedReasons: {},
    addedCompetitors: [],
    marketCurrency: 'USD',
  };
}
