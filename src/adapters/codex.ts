import type { SessionFields } from '../types';

const TOPIC_MAX = 60;

export interface CodexAccum {
  model?: string;
  approvalPolicy?: string;
  effort?: string;          // turn_context.effort — max/high 등
  sandbox?: string;
  cwd?: string;
  launchCwd?: string;
  lastUserMessage?: string;
  totalTokens: number;
  contextTokens: number;
  contextWindow?: number;
  // rollout 라인 자체 timestamp(ms) 기반 턴/승인 신호 — 스캔 배치·부트스트랩 시점과 무관한
  // 실제 시각이라 배치 내 순서 붕괴가 없고, 확장 리로드 후에도 진행 중인 턴이 복원됨
  turnStartedAtMs?: number;
  turnCompletedAtMs?: number;
  approvalAtMs?: number;
  // 실작업 라인(event_msg)의 마지막 timestamp — running 판정 전용
  lastWorkAt?: number;
}

export function newCodexAccum(): CodexAccum {
  return { totalTokens: 0, contextTokens: 0 };
}

export function applyCodexLine(acc: CodexAccum, line: string): boolean {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(line);
  } catch {
    return false;
  }
  if (!d || typeof d !== 'object') return false;
  const p = (d.payload ?? {}) as Record<string, unknown>;
  let changed = false;
  const ts = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN;

  if (d.type === 'session_meta') {
    if (typeof p.cwd === 'string') {
      acc.cwd = p.cwd;
      if (acc.launchCwd === undefined) acc.launchCwd = p.cwd;
      changed = true;
    }
  } else if (d.type === 'turn_context') {
    if (typeof p.model === 'string') { acc.model = p.model; changed = true; }
    if (typeof p.approval_policy === 'string') { acc.approvalPolicy = p.approval_policy; changed = true; }
    if (typeof p.effort === 'string') { acc.effort = p.effort; changed = true; }
    const sb = p.sandbox_policy as Record<string, unknown> | undefined;
    if (sb && typeof sb.type === 'string') { acc.sandbox = sb.type; changed = true; }
    if (typeof p.cwd === 'string') { acc.cwd = p.cwd; changed = true; }
  } else if (d.type === 'event_msg') {
    const pt = p.type;
    // 모든 event_msg는 런타임 이벤트 = 실작업 증거 (session_meta/turn_context 같은 설정 기록과 구분)
    if (!Number.isNaN(ts)) { acc.lastWorkAt = ts; changed = true; }
    if (pt === 'user_message' && typeof p.message === 'string') {
      acc.lastUserMessage = p.message;
      changed = true;
    } else if (pt === 'token_count') {
      const info = (p.info ?? p) as Record<string, unknown>;
      const total = info.total_token_usage as Record<string, number> | undefined;
      const last = info.last_token_usage as Record<string, number> | undefined;
      if (total?.total_tokens != null) { acc.totalTokens = total.total_tokens; changed = true; }
      if (last?.total_tokens != null) acc.contextTokens = last.total_tokens;
      else if (total?.total_tokens != null) acc.contextTokens = total.total_tokens;
      if (typeof info.model_context_window === 'number') acc.contextWindow = info.model_context_window;
    } else if (pt === 'task_started') {
      if (typeof p.model_context_window === 'number') { acc.contextWindow = p.model_context_window; changed = true; }
      if (!Number.isNaN(ts)) { acc.turnStartedAtMs = ts; changed = true; }
    } else if (
      pt === 'task_complete' || pt === 'turn_complete' ||
      pt === 'turn_aborted' || pt === 'task_aborted'
    ) {
      if (!Number.isNaN(ts)) { acc.turnCompletedAtMs = ts; changed = true; }
    } else if (typeof pt === 'string' && pt.includes('approval')) {
      if (!Number.isNaN(ts)) { acc.approvalAtMs = ts; changed = true; }
    }
  }
  return changed;
}

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function codexFields(acc: CodexAccum): SessionFields {
  return {
    model: acc.model,
    mode: [acc.effort, acc.approvalPolicy, acc.sandbox].filter(Boolean).join('·') || undefined,
    topic: truncate(acc.lastUserMessage, TOPIC_MAX),
    cwd: acc.cwd,
    launchCwd: acc.launchCwd,
    totalTokens: acc.totalTokens,
    contextTokens: acc.contextTokens,
    contextWindow: acc.contextWindow,
    costUsd: undefined, // 비-claude 단가 테이블 없음 → 카드에 "–"
  };
}
