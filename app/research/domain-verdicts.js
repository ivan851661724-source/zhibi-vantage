'use strict';
// ============================================================
// domain-verdicts.js —— voice / channel 域 verdict 构建器（PRD R2.4 / R3.3）
// 独立模块便于单测；decorate 经 runEnabledDomains 注入调用。
// 纪律（PRD §7 红线 4）：
//   · voice：≥3 家对手有声音数据才出群体结论，置信封顶 medium（口碑主观性）；
//   · channel：覆盖率 ≥70% 才出渠道分布结论；"没占"必须来自"查过没找到"
//     （全部确认缺席才 verified，含未探测 → inferred 封顶）。
// ============================================================

// ---- R2.4：voice 域 ----
function voiceVerdict(st) {
  const opp = st && st.opportunity || {};
  const themes = opp.themes || [];
  const brandsWithVoice = opp.brandsWithVoice || 0;
  const MIN_BRANDS = 3;
  if (!themes.length || brandsWithVoice < MIN_BRANDS) {
    return {
      subjectCount: themes.length, items: [],
      basis: 'unverified', confidence: 'low', level: 'undetected',
      note: '有用户声音的对手 ' + brandsWithVoice + ' 家（<' + MIN_BRANDS + '），不出群体口碑结论；机会视图仅展示初步信号',
    };
  }
  const items = themes.slice(0, 8).map(t => ({
    subjectId: 'voice:' + t.oid,
    claim: t.label,
    confidence: t.confidence === 'low' ? 'low' : 'medium', // 口碑主观性：置信封顶 medium（high 也压到 medium）
    basis: 'inferred',
    sources: (t.sources || []).filter(x => x && (x.url || x.detail)).slice(0, 6)
      .map(x => ({ label: String(x.detail || x.name || '').slice(0, 48), url: x.url || '', tier: x.url ? 2 : 3 })),
    evidenceIds: (t.sources || []).map(x => x.url).filter(Boolean),
    posMentions: t.posMentions, negMentions: t.negMentions,
    brandsMentioned: t.brandsMentioned,
    denominatorText: t.denominatorText,
  }));
  return {
    subjectCount: themes.length, items,
    basis: 'inferred', confidence: 'medium', level: 'opportunity',
    denominator: brandsWithVoice + ' 家对手有声音数据',
  };
}

// ---- R3.3：channel 域 ----
// channels：平台键数组（vocab.CHANNELS）；excludedSetOf(state) 返回应剔除的竞品 id 集合
function channelVerdict(st, channels, excludedSetOf) {
  const exSet = excludedSetOf ? excludedSetOf(st) : new Set(st && st.excluded || []);
  const comps = ((st && st.competitors) || []).filter(c => c && c.status === 'done' && !exSet.has(c.id));
  const total = comps.length;
  const withCh = comps.filter(c => c.channels && Object.keys(c.channels).length);
  const coverage = total ? withCh.length / total : 0;
  const pctText = Math.round(coverage * 100) + '%';
  if (total === 0 || coverage < 0.7) {
    return {
      subjectCount: 0, items: [],
      basis: 'unverified', confidence: 'low', level: 'undetected',
      note: '渠道探测覆盖率 ' + pctText + ' < 70%，不出渠道分布结论（未探测不当作缺席）',
    };
  }
  const chans = Array.isArray(channels) ? channels : [];
  const items = chans.map(k => {
    const recs = comps.map(c => ({ c, rec: (c.channels || {})[k] })).filter(x => x.rec);
    const present = recs.filter(x => x.rec.present === true);
    const verifiedAbsent = recs.filter(x => x.rec.present === false && x.rec.basis === 'verified');
    const undetected = recs.filter(x => x.rec.present === false && x.rec.basis !== 'verified');
    // 判定纪律（R3.2）：单源不升级——全部确认缺席才 verified；有未探测 → inferred 封顶
    const verifiedPresent = present.some(x => x.rec.basis === 'verified');
    const basis = verifiedPresent ? 'verified' // 渠道被占用有实抓证据 → 实查
      : (recs.length && verifiedAbsent.length === recs.length) ? 'verified' // 全部确认缺席 → 实查
      : (recs.length ? 'inferred' : 'unverified'); // 有未探测/纯推断 → 封顶 inferred
    const srcUrls = [];
    for (const x of present) {
      const fsList = ((x.c.fieldSources || {})['channels.' + k]) || [];
      for (const e of fsList) {
        if (e && e.url) srcUrls.push({ label: String(e.title || e.kind || k).slice(0, 48), url: e.url, tier: e.tier || 2 });
        if (srcUrls.length >= 4) break;
      }
      if (srcUrls.length >= 4) break;
    }
    return {
      subjectId: 'channel:' + k,
      claim: k + '：' + present.length + '/' + recs.length + ' 家确认在售' + (undetected.length ? '（另 ' + undetected.length + ' 家未探测）' : ''),
      confidence: basis === 'verified' ? 'high' : (basis === 'inferred' ? 'medium' : 'low'),
      basis,
      presentCount: present.length, confirmedAbsent: verifiedAbsent.length, undetectedCount: undetected.length,
      sources: srcUrls, evidenceIds: srcUrls.map(x => x.url),
    };
  });
  return {
    subjectCount: items.length, items,
    basis: items.every(i => i.basis === 'verified') ? 'verified' : 'inferred',
    confidence: 'medium', level: 'opportunity',
    coverage,
    denominator: withCh.length + '/' + total + ' 家有渠道探测数据',
  };
}

module.exports = { voiceVerdict, channelVerdict };
