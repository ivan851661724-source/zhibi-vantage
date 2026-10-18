'use client';
// 报告详情（SC-04）：正文 / 生成范围 / 数据覆盖 / 事实引用 / 机会与限制 / 版本与生成时间 / 纠错入口。
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ReportDetailView } from '@/components/brand/report-panel';

export default function ReportDetailPage() {
  const params = useParams<{ reportId: string }>();
  const reportId = String(params?.reportId || '');
  return (
    <div className="core-page">
      <p className="hint"><Link href="/report">← 返回报告列表</Link></p>
      <h2>调研报告</h2>
      <ReportDetailView reportId={reportId} />
      <p className="hint">
        发现数据有误？可在 <Link href="/intel">情报库</Link> 中打开对应证据并提交纠错。
      </p>
    </div>
  );
}
