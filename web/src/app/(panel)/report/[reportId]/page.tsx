'use client';
// 报告详情（SC-04 UI 框架轮）：正文 / 生成范围 / 数据覆盖 / 事实引用 / 版本与生成时间 / 纠错入口。
// projectId 由列表页带入 URL，返回链接保持项目上下文。
import { Suspense } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ReportDetailView } from '@/components/brand/report-panel';

export default function ReportDetailPage() {
  return (
    <Suspense fallback={<p className="hint">加载报告…</p>}>
      <ReportDetailInner />
    </Suspense>
  );
}

function ReportDetailInner() {
  const params = useParams<{ reportId: string }>();
  const sp = useSearchParams();
  const reportId = String(params?.reportId || '');
  const projectId = String(sp?.get('projectId') || '');
  return (
    <div className="core-page">
      <p className="hint">
        <Link href={projectId ? `/report?projectId=${encodeURIComponent(projectId)}` : '/report'}>← 返回报告列表</Link>
      </p>
      <h2>分析报告</h2>
      <ReportDetailView reportId={reportId} />
      <p className="hint">
        发现数据有误？可在 <Link href={projectId ? `/intel?projectId=${encodeURIComponent(projectId)}` : '/intel'}>每日变化</Link> 中打开对应证据并提交纠错。
      </p>
    </div>
  );
}
