'use client';
// 演示模式页面守卫（F-04 配套）：历史调研 / 设置 / 算法资产 三页依赖真实后端会话，
// 演示态（demo-token）下调 API 会 401 踢回登录——统一替换为提示屏，保住演示会话。
import { isDemoMode } from '@/lib/demo';

export function DemoPageGuard({ label }: { label: string }) {
  if (!isDemoMode()) return null;
  return (
    <div className="empty">
      <div className="big">演示模式不支持「{label}」</div>
      <div className="sub">
        该页面依赖真实账号数据（API 密钥 / 调研档案 / 服务端计算）。退出演示模式注册工作区即可体验完整功能；
        演示数据请前往工作台 / 竞品雷达 / 情报库 / 机会视图 / 赛道档案查看。
      </div>
    </div>
  );
}
