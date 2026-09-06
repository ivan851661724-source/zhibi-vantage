'use client';
// 设置页（Phase 3，复刻旧版 settingsModal index.html L425-465 + bindSettings app.js L4243-4303）
// 数据源：GET /api/config（密钥状态速览，misc.js configGet）
//         POST /api/config（保存，RBAC 仅 admin——403 时展示后端人类可读信息）
//         POST /api/searchtest（搜索源交叉验证）
// 注意：密钥输入框不回填（旧版行为：GET 只回传 has* 布尔与 ownBrands，密钥永不回传前端）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { isDemoMode } from '@/lib/demo';
import { DemoPageGuard } from '@/components/demo-page-guard';

interface ConfigResp {
  hasKeys?: boolean;
  provider?: string;
  hasTavily?: boolean;
  hasSerper?: boolean;
  hasBrave?: boolean;
  hasBocha?: boolean;
  serperKeyCount?: number;
  serperKeysDisabled?: number;
  ownBrands?: string[];
}
interface SaveResp {
  ok?: boolean;
  hasKeys?: boolean;
  serperKeyCount?: number;
}
interface TestResult {
  providers: Record<string, {
    ok?: boolean;
    count?: number;
    error?: string;
    results?: { title?: string; url?: string; snippet?: string }[];
  }>;
}

const PROVIDERS: { value: string; label: string }[] = [
  { value: 'tavily', label: 'Tavily' },
  { value: 'serper', label: 'Serper（Google SERP · 北美最强 · $50 起充）' },
  { value: 'brave', label: 'Brave（独立索引 · 每月 2000 次免费）' },
  { value: 'bocha', label: '博查 Bocha（国产 · 人民币计费 · 中文强）' },
];

const splitList = (raw: string): string[] =>
  raw.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);

export default function SettingsPage() {
  // 演示模式：本页依赖 /api/config 真实会话，替换为提示屏（F-04 配套）
  if (isDemoMode()) return <DemoPageGuard label="设置" />;
  return <SettingsPageInner />;
}

function SettingsPageInner() {
  const [cfg, setCfg] = useState<ConfigResp | null>(null);
  const [provider, setProvider] = useState('tavily');
  const [ds, setDs] = useState('');
  const [tavily, setTavily] = useState('');
  const [serper, setSerper] = useState('');
  const [serperPool, setSerperPool] = useState('');
  const [brave, setBrave] = useState('');
  const [bocha, setBocha] = useState('');
  const [ownBrands, setOwnBrands] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadErr, setLoadErr] = useState('');

  // 搜索源对比测试
  const [stQuery, setStQuery] = useState('');
  const [stResult, setStResult] = useState<{ text: string } | { data: TestResult } | { error: string } | null>(null);
  const [stBusy, setStBusy] = useState(false);

  const cfgRef = useRef<ConfigResp | null>(null);

  const load = useCallback(() => {
    setLoadErr('');
    apiGet<ConfigResp>('/api/config')
      .then((c) => {
        cfgRef.current = c;
        setCfg(c);
        if (c.provider) setProvider(c.provider);
        if (Array.isArray(c.ownBrands)) setOwnBrands(c.ownBrands.join('\n'));
      })
      .catch((e: Error) => {
        setLoadErr('配置读取失败：' + (e.message || String(e)));
      });
  }, []);

  useEffect(() => { load(); }, [load]);

  // 复刻 refreshKeyHints：各源 key 提示（已配置=留空保持；当前选中=需填；其他=可留空）
  const hint = (pv: string, has: boolean | null | undefined, label: string): string => {
    if (has) return '（已配置，留空则保持）';
    return provider === pv ? `（当前选中 ${label}，需填 Key）` : '（可留空）';
  };
  const serperHint = cfg && cfg.hasSerper && cfg.serperKeyCount
    ? `（已配置 ${cfg.serperKeyCount} 个 key，可用 ${Math.max(cfg.serperKeyCount - (cfg.serperKeysDisabled || 0), 0)} 个）`
    : hint('serper', !!(cfg && cfg.hasSerper), 'Serper');

  // 复刻 btnSettingsSave：主 key + 备用池合并传后端；选中源无 key 且未配置过 → 拦截
  const save = async () => {
    setStatus('');
    const c = cfgRef.current || {};
    const providerKey: Record<string, { v: string; has: boolean | undefined; label: string }> = {
      serper: { v: serper || serperPool, has: c.hasSerper, label: 'Serper' },
      brave: { v: brave, has: c.hasBrave, label: 'Brave' },
      bocha: { v: bocha, has: c.hasBocha, label: '博查' },
    };
    const need = providerKey[provider];
    if (need && !need.v && !need.has) {
      setStatus(`请先填 ${need.label} API Key，否则无法搜索`);
      return;
    }
    // 主 key + 备用池合并成一个数组传给后端（后端再做归一化）
    let serperKeys = splitList(serperPool);
    const s = serper.trim();
    if (s && !serperKeys.includes(s)) serperKeys = [s, ...serperKeys];
    setSaving(true);
    try {
      const r = await apiPost<SaveResp>('/api/config', {
        llm: { apiKey: ds.trim() },
        search: { provider, apiKey: tavily.trim(), serperKey: s, serperKeys, braveKey: brave.trim(), bochaKey: bocha.trim() },
        ownBrands: splitList(ownBrands),
      });
      setStatus(r.hasKeys ? `已保存 ✓（Serper ${r.serperKeyCount || 0} 个 key）` : '已保存（搜索源密钥仍缺失）');
      load(); // 刷新提示状态（has* / keyCount）
    } catch (e) {
      setStatus('保存失败：' + ((e as Error).message || String(e)));
    } finally {
      setSaving(false);
    }
  };

  // 复刻 btnSearchTest：同一查询词打到所有已配 key 的源
  const runTest = async () => {
    const q = stQuery.trim();
    if (!q) { setStResult({ text: '请填写测试查询词' }); return; }
    setStBusy(true);
    setStResult({ text: '各源并行查询中…' });
    try {
      const r = await apiPost<TestResult>('/api/searchtest', { query: q });
      setStResult({ data: r });
    } catch (e) {
      setStResult({ error: '测试失败：' + ((e as Error).message || String(e)) });
    } finally {
      setStBusy(false);
    }
  };

  return (
    <div className="settings-wrap">
      <div className="page-head">
        <div>
          <h2>设置</h2>
          <p className="desc">API 密钥与数据卫生配置。密钥仅存于本机 data/config.json，不会回传到前端。</p>
        </div>
      </div>
      {loadErr ? <p className="ob-status">{loadErr}</p> : null}

      <div className="modal-card" style={{ maxWidth: 720, margin: '0 auto' }}>
        <h3>设置 API 密钥</h3>
        <p className="modal-sub">用于自动搜索对手与综合情报。密钥仅存于本机 <code>data/config.json</code>。</p>
        <label className="field-label">DeepSeek API Key</label>
        <input className="text-input" type="password" placeholder="sk-…" value={ds} onChange={(e) => setDs(e.target.value)} />
        <label className="field-label">搜索源</label>
        <select className="text-input" value={provider} onChange={(e) => setProvider(e.target.value)}>
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        <label className="field-label">Tavily API Key <span className="field-hint">{hint('tavily', cfg && cfg.hasTavily, 'Tavily')}</span></label>
        <input className="text-input" type="password" placeholder="tvly-…" value={tavily} onChange={(e) => setTavily(e.target.value)} />
        <label className="field-label">Serper API Key（主 key）<span className="field-hint">{serperHint}</span></label>
        <input className="text-input" type="password" placeholder="serper.dev 申请的主 key" value={serper} onChange={(e) => setSerper(e.target.value)} />
        <label className="field-label">备用 Serper Key 池（额度用完自动切换）</label>
        <textarea className="text-input" rows={3} style={{ resize: 'vertical' }} placeholder="每行一个，或用逗号 / 分号分隔。留空则保留当前已配置的全部 key；填写则整体替换。" value={serperPool} onChange={(e) => setSerperPool(e.target.value)}></textarea>
        <label className="field-label">Brave API Key <span className="field-hint">{hint('brave', cfg && cfg.hasBrave, 'Brave')}</span></label>
        <input className="text-input" type="password" placeholder="api-dashboard.search.brave.com 申请的 key" value={brave} onChange={(e) => setBrave(e.target.value)} />
        <label className="field-label">博查 API Key <span className="field-hint">{hint('bocha', cfg && cfg.hasBocha, '博查')}</span></label>
        <input className="text-input" type="password" placeholder="open.bochaai.com 申请的 key（sk-…）" value={bocha} onChange={(e) => setBocha(e.target.value)} />
        <hr className="modal-sep" />
        <label className="field-label">我的自有品牌（自动排除，不计入竞品与空白分母）</label>
        <textarea className="text-input" rows={2} style={{ resize: 'vertical' }} placeholder="每行一个，或用逗号 / 分号分隔。如：PetLux / petlux.com。留空则不做自有品牌排除。" value={ownBrands} onChange={(e) => setOwnBrands(e.target.value)}></textarea>
        <p className="modal-sub">输入你自己的品牌名或官网域名，研究时会自动从竞品集与空白视图分母中剔除，避免自有实体污染空白结论（数据卫生②）。</p>
        <p className="modal-sub" style={{ marginTop: 8 }}>切换搜索源即时生效，无需重启；发现成本取决于所选源。保存需管理员权限。</p>

        <details style={{ marginTop: 10 }}>
          <summary className="field-label" style={{ cursor: 'pointer' }}>🔍 搜索源对比测试（同一查询词打到所有已配 key 的源）</summary>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input className="text-input" style={{ flex: 1, margin: 0 }} placeholder='如：site:etsy.com/shop "jellycat"' value={stQuery} onChange={(e) => setStQuery(e.target.value)} />
            <button className="btn-ghost" type="button" style={{ whiteSpace: 'nowrap' }} disabled={stBusy} onClick={runTest}>对比</button>
          </div>
          <div className="st-result">
            {stResult && 'text' in stResult ? <p className="muted">{stResult.text}</p> : null}
            {stResult && 'error' in stResult ? <p className="muted">{stResult.error}</p> : null}
            {stResult && 'data' in stResult && stResult.data
              ? Object.keys(stResult.data.providers).map((name) => {
                  const p = stResult.data.providers[name];
                  if (!p.ok) {
                    return (
                      <div className="st-block" key={name}>
                        <b>{name}</b> <span className="tag warn-tag">失败 {p.error}</span>
                      </div>
                    );
                  }
                  return (
                    <div className="st-block" key={name}>
                      <b>{name}</b> <span className="muted">{p.count} 条</span>
                      <ul>
                        {(p.results || []).map((x, i) => (
                          <li key={i}>
                            <a href={x.url || '#'} target="_blank" rel="noopener">{x.title || x.url}</a><br />
                            <span className="muted">{x.snippet}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })
              : null}
          </div>
        </details>

        <div className="modal-actions">
          <button className="btn-primary" type="button" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存'}</button>
        </div>
        {status ? <p className="ob-status">{status}</p> : null}
      </div>
    </div>
  );
}
