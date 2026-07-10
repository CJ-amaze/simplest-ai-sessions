import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TTL_MS, computeStatus, EXTERNAL_EXIT_MS,
  OPEN_TURN_STALL_MS, STRAGGLER_GRACE_MS,
} from '../src/status';

const T = 1_000_000_000_000;

describe('computeStatus', () => {
  it('exited가 최종 우선 — 승인대기 중이어도 프로세스 죽으면 exited', () => {
    expect(computeStatus({ now: T, processAlive: false, lastActivityAt: T, approvalAt: T })).toBe('exited');
  });
  it('approval: 권한 요청 후 활동 없음', () => {
    expect(computeStatus({ now: T + 10_000, processAlive: true, lastActivityAt: T, approvalAt: T + 1_000 })).toBe('approval');
  });
  it('approval 직후 2초 내 파일 활동은 승인대기 해제하지 않음 (grace)', () => {
    expect(computeStatus({ now: T + 10_000, processAlive: true, lastActivityAt: T + 1_500, approvalAt: T })).toBe('approval');
  });
  it('approval 해제: 이후 실제 활동', () => {
    expect(computeStatus({ now: T + 10_000, processAlive: true, lastActivityAt: T + 5_000, approvalAt: T })).toBe('running');
  });
  it('approval 해제: Stop hook', () => {
    expect(computeStatus({ now: T + 100_000, processAlive: true, lastActivityAt: T, approvalAt: T + 1_000, stoppedAt: T + 2_000 })).toBe('idle');
  });
  it('approval TTL 경과 시 idle로 강등', () => {
    expect(computeStatus({ now: T + APPROVAL_TTL_MS + 1, processAlive: true, lastActivityAt: T, approvalAt: T })).toBe('idle');
  });
  it('running: 30초 내 활동', () => {
    expect(computeStatus({ now: T + 10_000, processAlive: true, lastActivityAt: T })).toBe('running');
  });
  it('idle: 30초 무활동', () => {
    expect(computeStatus({ now: T + 60_000, processAlive: true, lastActivityAt: T })).toBe('idle');
  });
  it('외부 세션(processAlive=undefined)은 장기 무활동 시 exited 추정', () => {
    expect(computeStatus({ now: T + EXTERNAL_EXIT_MS + 1, lastActivityAt: T })).toBe('exited');
    expect(computeStatus({ now: T + 60_000, lastActivityAt: T })).toBe('idle');
  });

  // ── 턴 기반 running (긴 도구 실행 중 가짜 idle 수정) ──
  const openTurn = {
    processAlive: true as const, turnTrackingReliable: true,
    lastActivityAt: T, turnStartedAt: T,
  };
  it('턴 열림 = 무조건 작업중 — 기록·CPU 없는 원격 MCP 대기가 몇 분 이어져도 흔들리지 않음', () => {
    expect(computeStatus({ now: T + 10 * 60_000, ...openTurn, busy: false })).toBe('running');
    expect(computeStatus({ now: T + 25 * 60_000, ...openTurn })).toBe('running');
  });
  it('최후 안전장치: 턴 종료 신호 전부 유실 + 30분 무작업 + CPU 없음일 때만 강등', () => {
    expect(computeStatus({ now: T + OPEN_TURN_STALL_MS + 1, ...openTurn, busy: false })).toBe('idle');
    expect(computeStatus({ now: T + OPEN_TURN_STALL_MS + 1, ...openTurn, busy: true })).toBe('running'); // CPU 있으면 유지
  });
  it('턴 닫힘: stoppedAt >= turnStartedAt → idle', () => {
    expect(computeStatus({ now: T + 60_000, ...openTurn, stoppedAt: T + 1000 })).toBe('idle');
  });
  it('턴 재개: stop 이후 새 turnStartedAt → running', () => {
    expect(computeStatus({ now: T + 60_000, ...openTurn, stoppedAt: T + 1000, turnStartedAt: T + 2000 })).toBe('running');
  });
  it('신뢰도 꺼짐(claude 훅 미설치)이면 턴 무시 — 30초 창 폴백', () => {
    expect(computeStatus({ now: T + 60_000, ...openTurn, turnTrackingReliable: false })).toBe('idle');
  });
  it('프로세스 미확인(외부) 세션은 턴 무시', () => {
    expect(computeStatus({ now: T + 60_000, lastActivityAt: T, turnStartedAt: T, turnTrackingReliable: true })).toBe('idle');
  });
  it('턴 열림 중에도 approval이 우선', () => {
    expect(computeStatus({ now: T + 60_000, ...openTurn, approvalAt: T + 1000 })).toBe('approval');
  });

  // ── 신뢰 세션: stop 이후 실작업 존재 = 턴 열림 증거 (리로드로 턴 시작 신호를 잃어도 복원) ──
  const reliable = { processAlive: true as const, turnTrackingReliable: true };
  it('신뢰 세션: stop 없이 실작업이 있으면 시간이 지나도 running (턴이 닫힌 적 없음)', () => {
    expect(computeStatus({ now: T + 2 * 60_000, ...reliable, lastActivityAt: T })).toBe('running');
    expect(computeStatus({ now: T + 20 * 60_000, ...reliable, lastActivityAt: T })).toBe('running');
    // 안전장치(30분+CPU없음)만이 예외
    expect(computeStatus({ now: T + OPEN_TURN_STALL_MS + 1, ...reliable, lastActivityAt: T })).toBe('idle');
  });
  it('신뢰 세션: stop 직후 스트래글러(ai-title 등) 기록은 긴 창을 되살리지 않음', () => {
    expect(computeStatus({
      now: T + 60_000, ...reliable, stoppedAt: T, lastActivityAt: T + STRAGGLER_GRACE_MS - 1,
    })).toBe('idle');
    expect(computeStatus({
      now: T + 60_000, ...reliable, stoppedAt: T, lastActivityAt: T + STRAGGLER_GRACE_MS + 1,
    })).toBe('running'); // 충분히 지난 뒤의 활동은 진짜 새 턴
  });
  it('비신뢰 세션은 기존 30초 창 유지', () => {
    expect(computeStatus({ now: T + 60_000, processAlive: true, lastActivityAt: T })).toBe('idle');
  });

  // ── 실작업(lastWorkAt) 기준 판정 — 늦은 메타 기록의 "작업 중" 부활 방지 ──
  it('턴 종료 후 늦게 온 메타 기록(system/ai-title)은 running을 되살리지 않음', () => {
    // 실작업은 stop 전에 끝났고(lastWorkAt < stoppedAt), 3분 뒤 메타 기록이 mtime만 갱신한 상황
    expect(computeStatus({
      now: T + 8 * 60_000, ...reliable,
      stoppedAt: T, lastWorkAt: T - 1000, lastActivityAt: T + 3 * 60_000,
    })).toBe('idle');
  });
  it('실작업이 이어지는 동안은 running (메타 분리와 무관)', () => {
    expect(computeStatus({
      now: T + 5 * 60_000, ...reliable,
      stoppedAt: T, lastWorkAt: T + 4 * 60_000, lastActivityAt: T + 4 * 60_000,
    })).toBe('running');
  });
  it('메타 기록은 approval도 해제하지 않음', () => {
    expect(computeStatus({
      now: T + 60_000, processAlive: true,
      approvalAt: T, lastWorkAt: T - 1000, lastActivityAt: T + 30_000, // 승인 요청 후 메타만 기록됨
    })).toBe('approval');
  });
});
