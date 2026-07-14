import { describe, expect, it } from 'vitest';
import { REGISTER_GRACE_MS } from '../src/mapper';
import { PRUNE_AFTER_MS, StateStore } from '../src/store';

const T = 1_000_000_000_000;

function patch(store: StateStore, sid: string, lastActivityAt: number, extra = {}) {
  store.applyPatch({
    agent: 'claude', sessionId: sid, filePath: `/tmp/${sid}.jsonl`,
    fields: { lastActivityAt, ...extra },
  }, lastActivityAt);
}

describe('StateStore', () => {
  it('patch 병합 + undefined 필드는 기존값 유지', () => {
    const s = new StateStore();
    patch(s, 'a', T, { model: 'claude-fable-5', totalTokens: 100 });
    patch(s, 'a', T + 1000, { totalTokens: 200 });
    const v = s.all()[0];
    expect(v.model).toBe('claude-fable-5');
    expect(v.totalTokens).toBe(200);
  });

  it('lastActivityAt은 단조 증가 (과거 patch가 되돌리지 않음)', () => {
    const s = new StateStore();
    patch(s, 'a', T + 5000);
    patch(s, 'a', T); // bootstrap 재스캔 등
    expect(s.all()[0].lastActivityAt).toBe(T + 5000);
  });

  it('hook event: approval → approvalAt, stale 이벤트 무시', () => {
    const s = new StateStore();
    patch(s, 'a', T);
    s.applyHookEvent({ agent: 'claude', kind: 'approval', sessionId: 'a', observedAt: T + 2000 });
    expect(s.all()[0].approvalAt).toBe(T + 2000);
    s.applyHookEvent({ agent: 'claude', kind: 'stop', sessionId: 'a', observedAt: T + 1000 }); // stale
    expect(s.all()[0].stoppedAt).toBeUndefined();
  });

  it('hook event: notification은 승인대기 증거가 아님 — approvalAt 미설정', () => {
    const s = new StateStore();
    patch(s, 'a', T);
    s.applyHookEvent({ agent: 'claude', kind: 'notification', sessionId: 'a', observedAt: T + 2000 });
    expect(s.all()[0].approvalAt).toBeUndefined();
    expect(s.all()[0].lastEventAt).toBe(T + 2000); // stale 판정에는 참여
  });

  it('hook event: idle("waiting for input") → stoppedAt 설정, lastActivityAt 불변', () => {
    const s = new StateStore();
    patch(s, 'a', T);
    s.applyHookEvent({ agent: 'claude', kind: 'idle', sessionId: 'a', observedAt: T + 60_000 });
    expect(s.all()[0].stoppedAt).toBe(T + 60_000);
    expect(s.all()[0].lastActivityAt).toBe(T); // 입력 대기는 활동이 아님
  });

  it('hook event: 명시된 sessionId가 미등록이면 폴백 없이 무시 (오귀속 방지)', () => {
    const s = new StateStore();
    patch(s, 'a', T);
    s.applyHookEvent({ agent: 'claude', kind: 'approval', sessionId: 'ghost', observedAt: T + 2000 });
    expect(s.all()[0].approvalAt).toBeUndefined();
    expect(s.all()).toHaveLength(1); // ghost 세션이 새로 생기지도 않음
  });

  it('F1: applyHookEvent는 미등록 sessionId에 false, 등록된 세션에 true 반환', () => {
    const s = new StateStore();
    patch(s, 'a', T);
    expect(s.applyHookEvent({ agent: 'claude', kind: 'approval', sessionId: 'ghost', observedAt: T + 2000 }))
      .toBe(false);
    expect(s.applyHookEvent({ agent: 'claude', kind: 'approval', sessionId: 'a', observedAt: T + 2000 }))
      .toBe(true);
  });

  it('F3: hook 이벤트의 pid는 s.pid가 아닌 hookPid 힌트로만 저장 (mapper만 pid 기록)', () => {
    const s = new StateStore();
    patch(s, 'a', T);
    s.applyHookEvent({ agent: 'claude', kind: 'approval', sessionId: 'a', pid: 4242, observedAt: T + 2000 });
    expect(s.all()[0].pid).toBeUndefined();
    expect(s.all()[0].hookPid).toBe(4242);
  });

  it('hookPid는 sessionId 명시 이벤트에서만 저장 (폴백 매칭 이벤트는 힌트 불신)', () => {
    const s = new StateStore();
    patch(s, 'a', T);
    s.applyHookEvent({ agent: 'claude', kind: 'stop', pid: 4242, observedAt: T + 2000 });
    expect(s.all()[0].hookPid).toBeUndefined();
  });

  it('hook event: sessionId 없으면 같은 agent의 최근 활동 세션으로', () => {
    const s = new StateStore();
    patch(s, 'old', T - 60_000);
    patch(s, 'recent', T);
    s.applyHookEvent({ agent: 'claude', kind: 'approval', observedAt: T + 1000 });
    expect(s.all().find((x) => x.sessionId === 'recent')!.approvalAt).toBe(T + 1000);
    expect(s.all().find((x) => x.sessionId === 'old')!.approvalAt).toBeUndefined();
  });

  it('list: 등록순 고정 정렬 — 상태가 바뀌어도 카드 순서는 유지', () => {
    const s = new StateStore();
    patch(s, 'first', T - 60_000);           // 먼저 등록 (지금은 idle)
    patch(s, 'second', T - 1000);            // 나중 등록 (지금은 running)
    patch(s, 'third', T - 500, { approvalAt: T - 100 }); // 승인대기지만 순서는 마지막
    s.setProcess('claude:first', { alive: true });
    s.setProcess('claude:second', { alive: true });
    s.setProcess('claude:third', { alive: true });
    expect(s.list(T).map((v) => v.sessionId)).toEqual(['first', 'second', 'third']);
    patch(s, 'first', T + 100); // first가 다시 활동해도 순서 불변
    expect(s.list(T + 200).map((v) => v.sessionId)).toEqual(['first', 'second', 'third']);
  });

  it('살다가 죽은 세션: dim 5분 유지 후 prune', () => {
    const s = new StateStore();
    patch(s, 'dead', T);
    s.setProcess('claude:dead', { alive: true }, T);
    s.setProcess('claude:dead', { alive: false }, T);
    expect(s.list(T + 1000)).toHaveLength(1);
    expect(s.list(T + 1000)[0].status).toBe('exited');
    expect(s.list(T + PRUNE_AFTER_MS + 1)).toHaveLength(0);
  });

  it('생존 확인된 적 없는 세션은 죽음 확인 즉시 조용히 제거 — grace는 미확인(undefined)에만 적용', () => {
    const s = new StateStore();
    patch(s, 'ghost', T);
    s.setProcess('claude:ghost', { alive: false }, T); // 매핑 pass가 명시적으로 죽음 판정
    expect(s.list(T + 1000)).toHaveLength(0);
  });

  it('외부 세션(프로세스 미확인)도 장기 무활동 시 조용히 제거 (everAlive 아님)', () => {
    const s = new StateStore();
    patch(s, 'ext', T); // setProcess 호출 없음 = processAlive undefined
    const firstExited = T + 11 * 60_000; // EXTERNAL_EXIT_MS 초과 (grace도 초과)
    expect(s.list(firstExited)).toHaveLength(0);
  });

  it('매핑 확정 전에는 표시하지 않되 grace 동안 보존 (팝인/아웃 방지 + 살아있는 idle 세션 오삭제 방지)', () => {
    const s = new StateStore();
    // 15분 전 mtime 파일을 지금(T) 부트스트랩 등록 — lastActivityAt은 과거, registeredAt은 T
    s.applyPatch({
      agent: 'claude', sessionId: 'quiet', filePath: '/tmp/quiet.jsonl',
      fields: { lastActivityAt: T - 15 * 60_000 },
    }, T);
    expect(s.list(T + 1000)).toHaveLength(0);  // 표시 안 함
    expect(s.all()).toHaveLength(1);           // 하지만 grace 동안 보존 (삭제 아님)
    s.setProcess('claude:quiet', { alive: true }, T + 2000); // 매핑 pass가 생존 확인
    const views = s.list(T + REGISTER_GRACE_MS + 1);
    expect(views).toHaveLength(1);             // 확정 후 표시
    expect(views[0].status).toBe('idle');
  });

  it('부활: exited 세션에 새 활동 patch가 오면 종료 해제 + 매핑/부모/터미널 초기화, 재확정 전 숨김', () => {
    const s = new StateStore();
    patch(s, 'a', T);
    s.setProcess('claude:a', {
      alive: true, parentKey: 'claude:p', terminalName: 'old-term', shellPid: 42,
    }, T);
    s.setProcess('claude:a', { alive: false }, T);
    patch(s, 'a', T + 2000); // resume — transcript append
    expect(s.list(T + 3000)).toHaveLength(0); // 매핑 재확정 전에는 숨김
    s.setProcess('claude:a', { alive: true }, T + 4000); // 매핑 pass가 재확인
    const v = s.list(T + 5000)[0];
    expect(v.status).toBe('running');
    expect(v.parentKey).toBeUndefined();
    expect(v.terminalName).toBeUndefined(); // 죽은 터미널로 포커스 가지 않도록
    expect(v.shellPid).toBeUndefined();
  });

  it('patch의 approvalAt/stoppedAt은 lastEventAt에도 반영 → 더 오래된 훅 이벤트 무시', () => {
    const s = new StateStore();
    patch(s, 'a', T, { approvalAt: T + 5000 }); // codex rollout 유래
    s.applyHookEvent({ agent: 'claude', kind: 'stop', sessionId: 'a', observedAt: T + 1000 }); // stale
    expect(s.all()[0].stoppedAt).toBeUndefined();
  });

  it('setTurnTracking: claude 턴 열림 running은 신뢰도 켜졌을 때만', () => {
    const s = new StateStore();
    patch(s, 'a', T - 60_000, { turnStartedAt: T - 60_000 }); // 30초 창 밖
    s.setProcess('claude:a', { alive: true });
    expect(s.list(T)[0].status).toBe('idle'); // 기본 claude=false → 창 폴백
    s.setTurnTracking('claude', true);
    expect(s.list(T)[0].status).toBe('running'); // 턴 열림
  });

  it('children: parentKey로 부모 카드 아래 그룹핑, 최상위에서 제외', () => {
    const s = new StateStore();
    patch(s, 'parent', T);
    s.applyPatch({
      agent: 'codex', sessionId: 'child', filePath: '/tmp/child.jsonl',
      fields: { lastActivityAt: T },
    }, T);
    s.setProcess('claude:parent', { alive: true });
    s.setProcess('codex:child', { alive: true, parentKey: 'claude:parent' });
    const views = s.list(T + 1000);
    expect(views).toHaveLength(1);
    expect(views[0].key).toBe('claude:parent');
    expect(views[0].children?.map((c) => c.key)).toEqual(['codex:child']);
    expect(views[0].children?.[0].children).toBeUndefined(); // 1단계 강제
  });

  it('children: 부모 세션이 없으면 최상위로 승격', () => {
    const s = new StateStore();
    s.applyPatch({
      agent: 'codex', sessionId: 'orphan', filePath: '/tmp/o.jsonl',
      fields: { lastActivityAt: T },
    }, T);
    s.setProcess('codex:orphan', { alive: true, parentKey: 'claude:gone' });
    const views = s.list(T + 1000);
    expect(views.map((v) => v.key)).toEqual(['codex:orphan']);
  });

  it('setProcess parentKey null → 기존 연결 해제', () => {
    const s = new StateStore();
    patch(s, 'a', T);
    s.setProcess('claude:a', { parentKey: 'claude:p' });
    s.setProcess('claude:a', { parentKey: null });
    expect(s.all()[0].parentKey).toBeUndefined();
  });

  it('플레이스홀더: 세션 파일 없는 프로세스는 idle 카드로 표시, 사라지면 dim 없이 즉시 제거', () => {
    const s = new StateStore();
    patch(s, 'parent', T);
    s.setProcess('claude:parent', { alive: true });
    s.syncPlaceholders(
      [{ agent: 'codex', pid: 800, parentKey: 'claude:parent' }], T,
    );
    const views = s.list(T + 1000);
    expect(views).toHaveLength(1); // 부모 카드 아래 중첩
    expect(views[0].children?.[0].key).toBe('codex:pending-800');
    expect(views[0].children?.[0].status).toBe('idle'); // 실작업 전엔 running 아님
    s.syncPlaceholders([], T + 5000); // 프로세스 종료 or 실세션 클레임
    expect(s.list(T + 6000)[0].children).toBeUndefined();
  });

  it('플레이스홀더 topic: 바인딩 세션 이름이 있으면 기본 문구 대신 표시, 없으면 유지', () => {
    const s = new StateStore();
    s.syncPlaceholders([{ agent: 'claude', pid: 800, parentKey: null }], T);
    expect(s.list(T + 1000)[0].topic).toBe('Waiting for first query…');
    // 다음 pass에서 바인딩 이름이 도착하면 갱신
    s.syncPlaceholders([{ agent: 'claude', pid: 800, parentKey: null, topic: '관세 환급 관련 논의' }], T + 100);
    expect(s.list(T + 1000)[0].topic).toBe('관세 환급 관련 논의');
  });

  it('플레이스홀더는 all()에 포함되지 않음 (reconcile 클레임 대상 아님) — 단 find()로는 조회 가능 (터미널 포커스)', () => {
    const s = new StateStore();
    s.syncPlaceholders([{ agent: 'codex', pid: 800, shellPid: 600, parentKey: null }], T);
    expect(s.all()).toHaveLength(0);
    expect(s.list(T + 1000)).toHaveLength(1);
    expect(s.find('codex:pending-800')?.shellPid).toBe(600);
  });

  it('setProcess는 과거 stoppedAt patch 재발행이 최신 훅 stop을 덮어쓰지 않음 (단조 병합)', () => {
    const s = new StateStore();
    patch(s, 'a', T);
    s.applyHookEvent({ agent: 'claude', kind: 'stop', sessionId: 'a', observedAt: T + 5000 });
    patch(s, 'a', T + 6000, { stoppedAt: T + 1000 }); // 과거 Esc 마커 재발행 등
    expect(s.all()[0].stoppedAt).toBe(T + 5000);
  });

  it('onChange 알림 + 해제', () => {
    const s = new StateStore();
    let n = 0;
    const off = s.onChange(() => n++);
    patch(s, 'a', T);
    expect(n).toBe(1);
    off();
    patch(s, 'a', T + 1);
    expect(n).toBe(1);
  });
});
