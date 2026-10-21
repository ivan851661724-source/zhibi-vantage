'use client';
// SC-07 r2 §四：项目级采集覆盖条（竞品数据库 / 情报库统一组件）。
// 数据来自后端 collectionCoverage（真实 attempt / 持久任务 / 就绪状态派生），
// 七态口径与逐品牌徽章一致；排队/采集中未到终态时由父页面定时刷新。
// 展示纪律：不把运行中的任务写成「尚未开始」；失败明细保留品牌、原因与时间。
import type { CollectionCoverage } from '@/lib/core-api';

export function CollectionCoverageStrip({ coverage, projectId }: { coverage: CollectionCoverage | null; projectId?: string }) {
  if (!coverage) return null;
  const c = coverage.counts || {};
  const order: { key: keyof CollectionCoverage['counts']; cls: string }[] = [
    { key: 'collecting', cls: 'core-coll-collecting' },
    { key: 'queued', cls: 'core-coll-queued' },
    { key: 'has_data', cls: 'core-coll-has_data' },
    { key: 'empty', cls: 'core-coll-empty' },
    { key: 'failed', cls: 'core-coll-failed' },
    { key: 'source_pending', cls: 'core-coll-source_pending' },
    { key: 'not_started', cls: 'core-coll-not_started' },
  ];
  const labels: Record<string, string> = {
    queued: '排队中', collecting: '采集中', has_data: '有证据数据', empty: '检查完成但无结果',
    failed: '采集失败', source_pending: '来源待配置', not_started: '尚未开始',
  };
  const inFlight = (c.queued || 0) + (c.collecting || 0) > 0;
  return (
    <section className="core-coll-cov" data-testid="collection-coverage" data-project={projectId || undefined}>
      <h4>项目采集状态</h4>
      <p className="core-coll-cov-line">
        {order.map(({ key, cls }) => (
          <span key={key} className={cls}>{labels[key]} <b>{c[key] || 0}</b></span>
        ))}
        <span className="hint">{inFlight ? '（有任务进行中，状态自动刷新）' : '（状态由采集任务与 attempt 派生）'}</span>
      </p>
      {coverage.failures && coverage.failures.length ? (
        <ul className="core-coll-cov-failures">
          {coverage.failures.map((f) => (
            <li key={f.brandId}>{f.brandName || f.brandId}：{f.reason || '采集失败'}{f.at ? `（${String(f.at).slice(0, 16).replace('T', ' ')}）` : ''}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
