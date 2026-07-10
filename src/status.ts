import type { Status } from './types';

export const RUNNING_WINDOW_MS = 30_000;
// stop 직후 도착하는 메타/잔여 기록이 running을 되살리지 않도록 하는 가드
export const STRAGGLER_GRACE_MS = 10_000;
// 최후 안전장치: 턴 종료 신호(Stop/마커/idle 알림)가 전부 유실된 경우에만 —
// 장시간 실작업도 CPU도 없으면 강등. 정상 작업 강등용이 아님 (원격 MCP 대기는 CPU 0이므로
// 시간을 길게 잡는다; 통상 Esc는 마커나 60초 idle 알림이 먼저 닫아준다)
export const OPEN_TURN_STALL_MS = 30 * 60_000;
export const APPROVAL_TTL_MS = 30 * 60_000;
export const APPROVAL_GRACE_MS = 2_000;
export const EXTERNAL_EXIT_MS = 10 * 60_000;

export interface StatusInput {
  now: number;
  processAlive?: boolean;
  lastActivityAt: number;
  lastWorkAt?: number;             // 실작업 시각 — 없으면 lastActivityAt 폴백 (외부/구버전 어댑터)
  busy?: boolean;                  // 프로세스 트리 CPU 사용 중 (mapper 5초 주기 측정)
  approvalAt?: number;
  stoppedAt?: number;
  turnStartedAt?: number;          // 마지막 턴 시작 (claude=사용자 프롬프트, codex=task_started)
  turnTrackingReliable?: boolean;  // 턴 종료 신호를 신뢰 가능한가 (codex=rollout, claude=Stop 훅 확인 시)
}

export function computeStatus(s: StatusInput): Status {
  // 스펙 §5: exited는 무조건 최종 우선 (생존 판정은 모든 append 포함 lastActivityAt 기준)
  if (s.processAlive === false) return 'exited';
  if (s.processAlive === undefined && s.now - s.lastActivityAt > EXTERNAL_EXIT_MS) return 'exited';

  // running/approval 판정은 실작업 시각 기준 — system/ai-title 등 턴 종료 후 늦게 도착하는
  // 메타 기록이 "작업 중"을 되살리거나 승인대기를 해제하지 않도록 함
  const work = s.lastWorkAt ?? s.lastActivityAt;

  const approvalActive =
    s.approvalAt !== undefined &&
    work <= s.approvalAt + APPROVAL_GRACE_MS &&
    (s.stoppedAt === undefined || s.stoppedAt <= s.approvalAt) &&
    s.now - s.approvalAt < APPROVAL_TTL_MS;
  if (approvalActive) return 'approval';

  const reliable = s.turnTrackingReliable === true && s.processAlive === true;
  if (reliable) {
    // 원칙: 사용자가 지금 입력할 수 있는 상태만 '대기' — 턴이 열려 있으면 무조건 '작업 중'.
    // (원격 MCP 대기처럼 기록도 CPU도 없는 구간이 몇 분씩 이어져도 흔들리지 않는다)
    // 턴 열림 = 턴 시작 신호가 stop보다 나중이거나, stop 이후 실작업이 존재(스트래글러 제외)
    const turnOpen =
      s.turnStartedAt !== undefined &&
      (s.stoppedAt === undefined || s.stoppedAt < s.turnStartedAt);
    const workAfterStop = s.stoppedAt === undefined
      ? work > 0
      : work > s.stoppedAt + STRAGGLER_GRACE_MS;
    // 최후 안전장치: 턴 종료 신호가 전부 유실된 극단 케이스 — 장시간 실작업도 CPU도 없을 때만
    const stalled =
      s.now - Math.max(work, s.turnStartedAt ?? 0) > OPEN_TURN_STALL_MS && s.busy !== true;
    if ((turnOpen || workAfterStop) && !stalled) return 'running';
    return 'idle';
  }

  // 비신뢰(외부/훅 미설치) 폴백: 30초 활동 창
  if (s.now - work < RUNNING_WINDOW_MS && (s.stoppedAt === undefined || s.stoppedAt < work)) {
    return 'running';
  }
  return 'idle';
}
