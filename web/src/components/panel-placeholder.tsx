'use client';
// 面板占位组件（Phase 3 逐面板迁入完整实现，docs/03-迁移实施方案.md §3）
import type { ReactNode } from 'react';

export function PanelPlaceholder({
  title,
  phase,
  source,
  children,
}: {
  title: string;
  phase: string;
  source: string;
  children?: ReactNode;
}) {
  return (
    <section>
      <h2>{title}</h2>
      <p className="hint">
        本面板完整功能将在 {phase} 迁入（源：app.js 的 {source}）。数据链路已就绪。
      </p>
      {children}
    </section>
  );
}
