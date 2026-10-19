'use strict';
// M1: a versioned, unweighted distribution of this explicitly supplied catalog
// observation. Numeric samples come only from Facts, never legacy items or input prices.
// 00 §§1.4/8/17–20/26/38/42/56; 02 §6; 03 §17; 06 Traceability.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA } = require('../core/paths.js');
const { sanitizeNs } = require('../core/state-store.js');
const als = require('../core/als.js');
const { isSafeId, isWithinDir } = require('../core/safe-id.js');
const Snapshot = require('./source-snapshot.js');
const Evidence = require('./evidence-store.js');
const Fact = require('./fact-store.js');
const Extract = require('./evidence-extract.js');
const { medianOf, percentileOf } = require('../lib/price-stats.js');
const ALGORITHM_VERSION = 'catalog-active-product-price-1';
const CONFIG_VERSION = 'catalog-active-product-price-config-1';
const CONFIG = Object.freeze({ minimum_product_sample: 3, product_price: 'median_active_positive_variants', quartiles: 'floor_p_times_n_minus_1', weighting: 'one_per_product',
  // Product buckets count products containing a matching variant and may overlap.
  // Variant buckets count each native variant once within its product.
  count_units: Object.freeze({ product_counts: 'products_containing_variant_non_exclusive', variant_counts: 'unique_variants_per_product' }) });
const stable = Evidence.stableStringify;
const digest = x => crypto.createHash('sha256').update(x).digest('hex');
const ids = xs => [...new Set(xs)].sort();
const tenant = x => x?.tenant?.tenant_id;
const project = x => x?.tenant?.project_ref ?? null;
const fail = reason => ({ recorded: false, reason });
const dirOf = tid => path.join(DATA, 'metrics', sanitizeNs(tid));
const pathOf = (tid, id) => path.join(dirOf(tid), id + '.json');
const equal = (a, b) => stable(a) === stable(b);
const validObservedAt = value => typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));

function getMetricById(tenantId, id) {
  if (!tenantId || !isSafeId(id)) return null;
  const file = pathOf(tenantId, id);
  if (!isWithinDir(dirOf(tenantId), file)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    return tenant(m) === tenantId && m.metric_id === id ? m : null;
  } catch (_) { return null; }
}
function sourceHost(s, expectedPath) {
  try {
    const u = new URL(s.source_url), f = new URL(s.final_url || s.source_url);
    if ([u, f].some(x => !['http:', 'https:'].includes(x.protocol) || x.username || x.password || x.pathname !== expectedPath) || u.host !== f.host) return null;
    return u.host;
  } catch (_) { return null; }
}
function replay(s) {
  if (s.raw_truncated) return { error: 'raw_truncated' };
  const raw = Snapshot.readRawPayload(s);
  if (!raw) return { error: 'raw_unresolvable' };
  if (s.content_hash !== 'sha256:' + digest(raw)) return { error: 'raw_hash_mismatch' };
  try { return { json: JSON.parse(raw.toString('utf8')), raw }; } catch (_) { return { error: 'raw_json_invalid' }; }
}
function productKey(p) {
  if (p?.id != null && String(p.id).trim()) return 'shopify_product:' + String(p.id);
  if (typeof p?.handle === 'string' && p.handle.trim()) return 'shopify_product:' + p.handle;
  return null;
}
// Sort by native variant identity; names and source array ordering do not decide
// semantic equality. Repeated variant IDs must agree before collapsing duplicates.
function semanticPrices(prices) {
  const seen = new Map(), out = [];
  for (const p of prices) {
    // No array-position/title fallback: without a native ID we cannot know
    // whether repeated rows represent one variant or different variants.
    if (p.variant_id == null || !String(p.variant_id).trim()) return { error: 'variant_identity_missing' };
    const v = { variant_id: p.variant_id == null ? null : String(p.variant_id), price: p.price, available: typeof p.available === 'boolean' ? p.available : null };
    if (v.variant_id != null) {
      const old = seen.get(v.variant_id);
      if (old && !equal(old, v)) return { error: 'variant_conflict' };
      if (old) continue;
      seen.set(v.variant_id, v);
    }
    out.push(v);
  }
  out.sort((a, b) => stable(a).localeCompare(stable(b)));
  return { prices: out };
}
function median(values) {
  return medianOf(values.slice().sort((a, b) => a - b));
}

function recordPriceMetric(input = {}) {
  const tenantId = input.tenantId || als.getTenantCtx();
  if (!tenantId) return fail('no_tenant_context');
  if (!Array.isArray(input.factIds) || !Array.isArray(input.snapshotIds)) return fail('invalid_input_refs');
  if (![...input.factIds, ...input.snapshotIds, ...(input.currencySnapshotId ? [input.currencySnapshotId] : [])].every(isSafeId)) return fail('invalid_input_refs');
  const factIds = ids(input.factIds), collectionIds = ids(input.snapshotIds);
  if (!factIds.length) return fail('no_price_facts');
  if (!collectionIds.length) return fail('no_collection_snapshots');
  const collection = [], pages = new Map(), rawProducts = new Map(), collectionIssues = [];
  let scope = null, partial = false;
  // 合流：SC-02 r3 后页级快照只记页事实（success），扫描级 partial 由调用方经
  // scanMeta 显式传入——枚举不完整不得谎报完整覆盖（05 §5.2 冻结术语）。
  if (input.partialScan === true) {
    partial = true;
    if (input.partialScanReason) collectionIssues.push({ snapshot_id: null, source_status: null, reason: input.partialScanReason, empty: false });
  }
  const checkScope = (s, expectedPath, expectedCapability) => {
    if (tenant(s) !== tenantId) return 'snapshot_tenant_mismatch';
    const host = sourceHost(s, expectedPath);
    if (!host || !s.fetched_at || s.capability !== (expectedCapability || 'product_catalog')) return 'snapshot_scope_invalid';
    const current = { domain: host, fetched_at: s.fetched_at, project_ref: project(s) };
    if (scope && !equal(scope, current)) return 'snapshot_scope_mismatch';
    scope = current; return null;
  };
  for (const sid of collectionIds) {
    const s = Snapshot.getById(tenantId, sid);
    if (!s) return fail('collection_snapshot_not_found');
    const error = checkScope(s, '/products.json');
    if (error) return fail(error);
    if (s.provider !== 'shopify_products_json') return fail('snapshot_source_mismatch');
    collection.push(s);
    if (s.partial_scan || s.source_status !== 'success') partial = true;
    if (!['success', 'partial'].includes(s.source_status)) {
      collectionIssues.push({ snapshot_id: sid, source_status: s.source_status, reason: s.error_code || s.source_status, empty: false });
      continue;
    }
    const r = replay(s);
    if (r.error) return fail(r.error);
    if (!Array.isArray(r.json?.products)) return fail('raw_products_invalid');
    const parsed = Extract.parseProductPriceObservations(r.raw.toString('utf8'));
    if (parsed.error) return fail(parsed.error);
    pages.set(sid, { s, parsed });
    if (!r.json.products.length) collectionIssues.push({ snapshot_id: sid, source_status: s.source_status, reason: null, empty: true });
    if (s.partial_scan) collectionIssues.push({ snapshot_id: sid, source_status: s.source_status, reason: s.partial_scan_reason || 'partial_scan', empty: !r.json.products.length });
    for (const p of r.json.products) {
      const key = productKey(p);
      if (!key) return fail('product_identity_missing');
      const variants = Array.isArray(p.variants) ? p.variants : [];
      const rawSemantics = semanticPrices(variants.map(v => ({ variant_id: v?.id, price: Number.isFinite(parseFloat(v?.price)) ? parseFloat(v.price) : null, available: v?.available })));
      if (rawSemantics.error) return fail(rawSemantics.error);
      const native = { prices: rawSemantics.prices };
      const old = rawProducts.get(key);
      if (old && !equal(old.native, native)) return fail('product_observation_conflict');
      if (!old) rawProducts.set(key, { native, variants, facts: [] });
    }
  }
  let currencySnapshot = null, sourceCurrency = null;
  if (input.currencySnapshotId) {
    currencySnapshot = Snapshot.getById(tenantId, input.currencySnapshotId);
    if (!currencySnapshot) return fail('currency_snapshot_not_found');
    const error = checkScope(currencySnapshot, '/cart.js', 'storefront_currency');
    if (error) return fail(error);
    if (currencySnapshot.provider !== 'shopify_cart_js_json' || currencySnapshot.capability !== 'storefront_currency') return fail('currency_snapshot_source_mismatch');
    if (currencySnapshot.source_status === 'success') {
      const c = replay(currencySnapshot);
      if (!c.error && typeof c.json?.currency === 'string' && /^[A-Za-z]{3}$/.test(c.json.currency)) {
        if (!validObservedAt(currencySnapshot.observed_at)) return fail('currency_observed_at_invalid');
        sourceCurrency = c.json.currency.toUpperCase();
      }
    }
  }
  const facts = [], evidenceIds = [], supportedIds = [], semanticByProduct = new Map();
  let context = null;
  const covered = new Set();
  for (const fid of factIds) {
    const f = Fact.getFactById(tenantId, fid);
    if (!f) return fail('fact_not_found');
    if (tenant(f) !== tenantId) return fail('fact_tenant_mismatch');
    if (!validObservedAt(f.observed_at)) return fail('fact_observed_at_invalid');
    if (project(f) !== scope.project_ref || f.fact_type !== Fact.FACT_TYPE || !f.entity_key || f.source !== 'shopify' || f.provider !== 'shopify_products_json') return fail('fact_scope_mismatch');
    if (!equal(f.claim, { field: Fact.CLAIM_FIELD, scope: Fact.CLAIM_SCOPE })) return fail('fact_claim_mismatch');
    if (!Array.isArray(f.evidence_ids) || !f.evidence_ids.length || !Array.isArray(f.source_snapshot_ids)) return fail('fact_chain_missing');
    if (!f.value || !Number.isFinite(f.value.price_min) || !Number.isFinite(f.value.price_max) || !Array.isArray(f.value.prices) || !f.value.prices.length || f.value.prices.some(p => !Number.isFinite(p?.price))) return fail('fact_value_invalid');
    const sem = semanticPrices(f.value.prices);
    if (sem.error) return fail(sem.error);
    const fContext = { currency: f.currency ?? null, market: f.market ?? null, unit: f.unit ?? null };
    if (context && !equal(context, fContext)) return fail('fact_context_conflict');
    context = fContext;
    if (f.currency != null && (f.currency !== sourceCurrency || !currencySnapshot)) return fail('currency_provenance_mismatch');
    const evidenceSnapshots = [];
    for (const eid of f.evidence_ids) {
      const e = Evidence.getEvidenceById(tenantId, eid);
      if (!e) return fail('evidence_not_found');
      if (tenant(e) !== tenantId) return fail('evidence_tenant_mismatch');
      if (project(e) !== scope.project_ref || e.entity_key !== f.entity_key || !equal(e.claim, f.claim) || e.source !== f.source || e.provider !== f.provider || e.evidence_status !== 'verified') return fail('evidence_scope_mismatch');
      if (!equal(e.extracted_value, f.value) || !equal({ currency: e.currency ?? null, market: e.market ?? null, unit: e.unit ?? null }, fContext) || e.observed_at !== f.observed_at) return fail('evidence_value_mismatch');
      if (!Array.isArray(e.source_snapshot_ids) || !e.source_snapshot_ids.length) return fail('evidence_chain_missing');
      if (f.currency != null && !e.source_snapshot_ids.includes(input.currencySnapshotId)) return fail('currency_support_missing');
      let rawMatch = false;
      for (const sid of e.source_snapshot_ids) {
        evidenceSnapshots.push(sid);
        const s = Snapshot.getById(tenantId, sid);
        if (!s) return fail('support_snapshot_not_found');
        if (tenant(s) !== tenantId) return fail('snapshot_tenant_mismatch');
        const isCurrency = sid === input.currencySnapshotId;
        const scopeError = checkScope(s, isCurrency ? '/cart.js' : '/products.json', isCurrency ? 'storefront_currency' : undefined);
        if (scopeError) return fail(scopeError);
        if (isCurrency) {
          if (!sourceCurrency || f.currency !== sourceCurrency) return fail('currency_provenance_mismatch');
          const r = replay(s); if (r.error) return fail(r.error);
        } else {
          const page = pages.get(sid);
          if (!page) return fail('support_snapshot_outside_collection');
          if (!validObservedAt(s.observed_at)) return fail('snapshot_observed_at_invalid');
          if (f.observed_at !== s.observed_at) return fail('fact_observation_mismatch');
          const candidates = page.parsed.products.filter(p => p.entity_key === f.entity_key);
          if (!candidates.length) return fail('raw_product_identity_mismatch');
          for (const p of candidates) {
            if ((f.entity_ref?.product_id ?? null) !== (p.entity_ref.product_id ?? null) || (f.entity_ref?.handle ?? null) !== (p.entity_ref.handle ?? null)) return fail('raw_product_identity_mismatch');
            // Legacy Facts may lack availability; absence remains unknown even if raw
            // has the field. Never promote that legacy value into an active sample.
            const expected = p.prices.map(v => ({ ...v }));
            for (const v of expected) {
              const actual = f.value.prices.find(a => a.variant_id === v.variant_id && a.price === v.price);
              if (actual && !Object.hasOwn(actual, 'available')) delete v.available;
            }
            const exp = semanticPrices(expected);
            if (exp.error || p.price_min !== f.value.price_min || p.price_max !== f.value.price_max || !equal(exp.prices, sem.prices)) return fail('raw_fact_value_mismatch');
          }
          rawMatch = true; covered.add(sid + '|' + f.entity_key);
        }
      }
      if (!rawMatch) return fail('raw_product_support_missing');
      evidenceIds.push(eid);
    }
    if (!equal(ids(evidenceSnapshots), ids(f.source_snapshot_ids))) return fail('fact_snapshot_refs_mismatch');
    const product = rawProducts.get(f.entity_key);
    if (!product) return fail('product_identity_missing');
    const semantic = { ...fContext, prices: sem.prices };
    if (semanticByProduct.has(f.entity_key) && !equal(semanticByProduct.get(f.entity_key), semantic)) return fail('product_observation_conflict');
    semanticByProduct.set(f.entity_key, semantic); product.facts.push(f);
    facts.push(f); supportedIds.push(...f.source_snapshot_ids);
  }
  // The catalog scope cannot silently include valid numeric observations omitted
  // from the explicit Fact input set. Invalid/missing prices remain counted below.
  for (const [sid, page] of pages) for (const p of page.parsed.products) {
    if (!covered.has(sid + '|' + p.entity_key)) return fail('collection_fact_missing');
  }
  const productCounts = { observed: rawProducts.size, active_paid: 0, free: 0, unknown_availability: 0, sold_out: 0, invalid: 0, missing_price: 0 };
  const variantCounts = { observed: 0, active_paid: 0, active_free: 0, unknown_availability: 0, sold_out: 0, invalid: 0 };
  const samples = [];
  for (const [key, product] of rawProducts) {
    const values = semanticByProduct.get(key)?.prices || [];
    const paid = values.filter(v => v.available === true && v.price > 0).map(v => v.price);
    if (paid.length) { productCounts.active_paid++; samples.push(median(paid)); }
    if (values.some(v => v.available === true && v.price === 0)) productCounts.free++;
    if (values.some(v => v.available === null && v.price >= 0)) productCounts.unknown_availability++;
    if (values.some(v => v.available === false && v.price >= 0)) productCounts.sold_out++;
    const invalid = product.native.prices.filter(v => v.price == null || v.price < 0).length;
    if (invalid) productCounts.invalid++;
    if (!values.length) productCounts.missing_price++;
    variantCounts.observed += product.native.prices.length;
    variantCounts.invalid += invalid;
    for (const v of values) {
      if (v.price < 0) continue;
      if (v.available === true) { if (v.price > 0) variantCounts.active_paid++; else variantCounts.active_free++; }
      else if (v.available === false) variantCounts.sold_out++;
      else variantCounts.unknown_availability++;
    }
  }
  samples.sort((a, b) => a - b);
  const enough = samples.length >= CONFIG.minimum_product_sample;
  const rank = q => enough ? percentileOf(samples, q) : null;
  const limitations = [];
  if (!enough) limitations.push('insufficient_sample');
  if (context.currency == null) limitations.push('currency_unknown');
  if (context.market == null) limitations.push('market_unknown');
  if (context.unit == null) limitations.push('unit_unknown');
  if (productCounts.unknown_availability) limitations.push('availability_unknown');
  if (productCounts.invalid || productCounts.missing_price) limitations.push('invalid_or_missing_price');
  if (partial) limitations.push('partial_scan');
  const identity = { tenantId, factIds, collectionIds, currencySnapshotId: input.currencySnapshotId || null, algorithm: ALGORITHM_VERSION, configVersion: CONFIG_VERSION, config: CONFIG, scope };
  const key = digest(stable(identity)), id = 'metric_' + key.slice(0, 24);
  const existing = getMetricById(tenantId, id);
  if (existing) {
    if (existing.idempotency_key !== key) throw new Error('price-metric: append-only identity collision');
    return { recorded: true, meta: existing, duplicate: true };
  }
  const observed = facts.map(f => f.observed_at).sort((a, b) => Date.parse(a) - Date.parse(b));
  const meta = { metric_id: id, schema_version: 1, metric_type: 'catalog_active_product_price', evidence_status: 'derived',
    tenant: { tenant_id: tenantId, project_ref: scope.project_ref }, domain: scope.domain, fetched_at: scope.fetched_at,
    algorithm_version: ALGORITHM_VERSION, config_version: CONFIG_VERSION, config: CONFIG, computed_at: new Date().toISOString(),
    observed_from: observed[0] || null, observed_to: observed.at(-1) || null,
    ...context, value: { p25: rank(.25), median: enough ? medianOf(samples) : null, p75: rank(.75) }, sample_product_count: samples.length,
    product_counts: productCounts, variant_counts: variantCounts, partial_scan: partial, limitations,
    fact_ids: factIds, evidence_ids: ids(evidenceIds), source_snapshot_ids: ids(supportedIds),
    collection_snapshot_ids: collectionIds, currency_snapshot_id: input.currencySnapshotId || null, collection_issues: collectionIssues,
    idempotency_key: key };
  fs.mkdirSync(dirOf(tenantId), { recursive: true });
  fs.writeFileSync(pathOf(tenantId, id), JSON.stringify(meta, null, 1), { flag: 'wx' });
  return { recorded: true, meta, duplicate: false };
}

// State keeps only the display projection. Full reference ID sets stay in Metric storage.
function metricSummary(m) {
  const fields = ['metric_id', 'metric_type', 'evidence_status', 'algorithm_version', 'config_version', 'computed_at', 'observed_from', 'observed_to',
    'currency', 'market', 'unit', 'value', 'sample_product_count', 'product_counts', 'variant_counts', 'partial_scan', 'limitations'];
  return Object.fromEntries(fields.map(k => [k, m[k]]));
}
module.exports = { ALGORITHM_VERSION, CONFIG_VERSION, CONFIG, recordPriceMetric, getMetricById, metricSummary };
