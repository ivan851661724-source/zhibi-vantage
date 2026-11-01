'use client';
// discover 流程状态机（移植 app.js discover()/onSSEEvent()/onStage() L687-811 的 React 版）
// 行为契约：
//   · start() → POST /api/discover（202 accepted，进度由 SSE typed 事件推送）
//   · discover_stage → 进度条；brand_found/removed → 实时骨架卡；complete → 全量拉 state；error → 原地失败面板
// P0 整改（2026-11「新用户品牌发现恢复与 LLM 故障显式化」）：
//   · 错误文案供应商中立：统一称「品牌识别服务」，删除 DeepSeek 等供应商绑定文案
//   · 错误分类显式化：品牌识别服务暂不可用 / 模型未获授权 / 服务额度受限 / 搜索服务
//     额度不足 / 今日发现额度用完 / 识别成功但未找到已核验品牌，逐一区分
//   · SSE 断开恢复：发现进行中（track 有值 + discoverDone=false + 无失败态）时周期轮询
//     /api/state，凭状态查询拿到最终成功/失败，不依赖单条 SSE 消息
//   · 失败终态从 state.discoverError 恢复（后端持久化），绝不把失败渲染成空品牌列表
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiPost, ApiError } from '@/lib/api';
import { useZhibiState } from '@/hooks/use-zhibi-state';

export interface DiscoverCard {
  id: string;
  name: string;
  url?: string;
  tier?: string;
  matchScore?: number;
  why?: string;
}

export interface DiscoverError {
  code?: string;
  message: string;
  /** r2 §四.5：本次更新失败，但上一次成功结果仍可查看（旧结果未被覆盖） */
  keptPrevious?: boolean;
}

/** 后端持久化的任务失败态（/api/state.discoverError；成功重试后不再出现） */
export interface DiscoverTaskError {
  errorCode: string;
  errorMessage: string;
  failedAt: string;
  previousProjectId?: string | null;
  /** r2 §四.5：本次更新失败，但上一次成功结果仍保留在同一项目内 */
  keptPrevious?: boolean;
  attemptNo?: number;
}

/** r2：一次运行的内部标识（用户可见项目仍是同一个） */
export interface DiscoverRunInfo {
  runId?: string | null;
  attemptNo?: number | null;
  /** true = 同项目重新识别（复用原 projectId，不新建项目） */
  retry?: boolean;
  /** true = 本次请求命中了进行中的运行（双击/双开页幂等复用） */
  reused?: boolean;
}

// 归一错误码 → 用户可读文案（与后端 discoverUserMessage 保持一致；仅作后端缺省时的兜底）
export function discoverErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'NO_KEYS': return '品牌识别服务尚未配置，请联系平台管理员完成配置。';
    case 'quota': return '今日免费调研次数已用完，明天再来或联系平台管理员。';
    case 'SEARCH_QUOTA': return '搜索服务额度不足，请稍后再试或联系平台管理员。';
    case 'SEARCH_FAILED': return '搜索服务暂不可用，请稍后重新识别。';
    case 'LLM_AUTH_REJECTED': return '品牌识别服务鉴权失败（密钥无效或模型未获授权），请联系平台管理员。';
    case 'LLM_MODEL_UNAVAILABLE': return '品牌识别服务当前模型不可用，请联系平台管理员。';
    case 'LLM_RATE_LIMITED': return '品牌识别服务额度受限，请稍后重新识别。';
    case 'LLM_TIMEOUT':
    case 'LLM_PROVIDER_UNAVAILABLE':
    case 'LLM_INVALID_RESPONSE': return '品牌识别服务暂不可用，请稍后重新识别。';
    case 'DISCOVER_QUOTA': return '今日免费调研次数已用完。明天再来，或加入候补名单优先解锁。';
    default: return '本次品牌识别未完成，请稍后重新识别。';
  }
}

interface ZhibiDiscoverFields {
  track?: string;
  discoverDone?: boolean;
  discoverEmpty?: boolean;
  discoverError?: DiscoverTaskError;
}

const DISCOVER_POLL_MS = 4000;
const DISCOVER_POLL_MAX_MS = 5 * 60 * 1000; // 轮询兜底上限 5 分钟（正常发现 1-3 分钟）

export function useDiscover() {
  const { subscribe, refresh, state } = useZhibiState();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ pct: number; label: string; found: number } | null>(null);
  const [cards, setCards] = useState<Record<string, DiscoverCard>>({});
  const [error, setError] = useState<DiscoverError | null>(null);
  const [runInfo, setRunInfo] = useState<DiscoverRunInfo | null>(null);
  const pollStopRef = useRef(false);

  // —— 持久失败态恢复：state.discoverError → 本地 error（刷新后依然可见） ——
  // 只有当前项目就是失败项目时才显示（成功重试产生新项目后自动消失）。
  const st = (state || null) as (ZhibiDiscoverFields & Record<string, unknown>) | null;
  const stError = st?.discoverError || null;
  const stProjectId = typeof state?.projectId === 'string' ? state.projectId : '';
  useEffect(() => {
    if (running) return;
    if (stError) setError({ code: stError.errorCode, message: stError.errorMessage, keptPrevious: !!stError.keptPrevious });
  }, [stError?.failedAt, stError?.errorCode, running, stProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // —— SSE 丢失兜底：发现进行中 → 周期轮询状态查询，拿到最终成功/失败 ——
  const inflight = !!(st && st.track && st.discoverDone === false && !st.discoverError);
  useEffect(() => {
    if (running || !inflight) return;
    pollStopRef.current = false;
    const startedAt = Date.now();
    const t = setInterval(() => {
      if (pollStopRef.current || Date.now() - startedAt > DISCOVER_POLL_MAX_MS) {
        clearInterval(t);
        return;
      }
      void refresh();
    }, DISCOVER_POLL_MS);
    return () => { pollStopRef.current = true; clearInterval(t); };
  }, [running, inflight, stProjectId, refresh]);

  useEffect(
    () =>
      subscribe((evt) => {
        switch (evt.type) {
          case 'discover_stage': {
            setProgress({
              pct: typeof evt.pct === 'number' ? evt.pct : 10,
              label: (evt.label as string) || '正在发现竞争品牌…',
              found: typeof evt.found === 'number' ? evt.found : 0,
            });
            break;
          }
          case 'brand_found': {
            const card = evt.card as DiscoverCard | undefined;
            if (card && card.id) setCards((prev) => ({ ...prev, [card.id]: card }));
            break;
          }
          case 'brand_removed': {
            const id = evt.id as string | undefined;
            if (id)
              setCards((prev) => {
                const next = { ...prev };
                delete next[id];
                return next;
              });
            break;
          }
          case 'discover_complete': {
            setRunning(false);
            setCards({});
            setProgress(null);
            void refresh(); // 全量拉权威状态（对齐 onDiscoverComplete；discoverEmpty 由页面按 state 渲染）
            break;
          }
          case 'discover_error': {
            // 后端已持久化失败态并附用户可读文案（不含内部细节/供应商原始错误）
            setRunning(false);
            const code = evt.code as string | undefined;
            setError({
              code,
              message: (evt.message as string | undefined) || discoverErrorMessage(code),
              keptPrevious: evt.keptPrevious === true,
            });
            break;
          }
          default:
            break;
        }
      }),
    [subscribe, refresh],
  );

  const start = useCallback(
    async (track: string, intent: Record<string, unknown>, opts?: { retryProjectId?: string }) => {
      setRunning(true);
      setError(null);
      setCards({});
      setRunInfo(null);
      setProgress({ pct: 5, label: opts?.retryProjectId ? '正在重新识别（旧结果仍可查看）…' : '正在理解你的赛道…', found: 0 });
      try {
        // r2 §三：重新识别必须复用原 projectId —— 携带 retryProjectId，后端在同项目内新起一次运行
        // （不新建用户可见项目；赛道/地区/核心条件变化时后端自动改走新项目）。
        const res = await apiPost('/api/discover', { track, intent, retryProjectId: opts?.retryProjectId });
        const body = (res || {}) as Record<string, unknown>;
        setRunInfo({
          runId: typeof body.runId === 'string' ? body.runId : null,
          attemptNo: typeof body.attemptNo === 'number' ? body.attemptNo : null,
          retry: body.retry === true,
          reused: body.reused === true,
        });
        // 发现启动即拉一次空状态（对齐 F1 加固：用户立即看到「赛道 + 研究中」而非空白）
        await refresh();
      } catch (e) {
        setRunning(false);
        setProgress(null);
        // R5.2：每日免费额度用尽 → 明确提示 + 候补名单入口（后端 429 DISCOVER_QUOTA）
        if (e instanceof ApiError && e.body && e.body.error === 'DISCOVER_QUOTA') {
          setError({ code: 'DISCOVER_QUOTA', message: e.body.message || '今日免费调研次数已用完（每租户每日 3 次）。' });
          return;
        }
        // 后端 401 NO_KEYS：品牌识别服务未配置（供应商中立文案，配置由平台管理员负责）
        if (e instanceof ApiError && e.body && e.body.error === 'NO_KEYS') {
          setError({ code: 'NO_KEYS', message: e.body.message || discoverErrorMessage('NO_KEYS') });
          return;
        }
        const m = e instanceof Error ? e.message : '未知错误';
        setError({
          message: /NO_KEYS/.test(m)
            ? discoverErrorMessage('NO_KEYS')
            : /TOO_BUSY|RATE_LIMIT/.test(m)
              ? '研究服务正忙或请求过于频繁，请稍后再试。'
              : '识别失败：' + m,
        });
      }
    },
    [refresh],
  );

  const reset = useCallback(() => {
    setError(null);
    setProgress(null);
    setCards({});
    setRunInfo(null);
  }, []);

  return { running, progress, cards, error, runInfo, start, reset };
}
