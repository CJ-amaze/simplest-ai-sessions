import { REGISTER_GRACE_MS } from './mapper';
import { computeStatus } from './status';
import type {
  AgentKind, HookEvent, MappingConfidence, SessionPatch, SessionState, SessionView,
} from './types';

export const PRUNE_AFTER_MS = 5 * 60_000;

export class StateStore {
  private sessions = new Map<string, SessionState & { exitedAt?: number }>();
  private listeners = new Set<() => void>();
  // 턴 종료 신호 신뢰도: codex는 rollout 파일 자체에 턴 이벤트가 있어 기본 신뢰,
  // claude는 Stop 훅 설치가 확인되어야 신뢰 (미설치 degraded 모드에서 영구 running 방지)
  private turnTracking: Record<AgentKind, boolean> = { claude: false, codex: true };

  setTurnTracking(agent: AgentKind, reliable: boolean): void {
    if (this.turnTracking[agent] === reliable) return;
    this.turnTracking[agent] = reliable;
    this.emit();
  }

  applyPatch(p: SessionPatch, now: number = Date.now()): void {
    const key = `${p.agent}:${p.sessionId}`;
    const cur = this.sessions.get(key);
    const base: SessionState & { exitedAt?: number } = cur ?? {
      key, agent: p.agent, sessionId: p.sessionId, filePath: p.filePath,
      totalTokens: 0, contextTokens: 0, lastActivityAt: 0, lastEventAt: 0, mapping: 'none',
      registeredAt: now,
    };
    const next = { ...base };
    for (const [k, v] of Object.entries(p.fields)) {
      if (v !== undefined) (next as Record<string, unknown>)[k] = v;
    }
    if (p.fields.lastActivityAt !== undefined && p.fields.lastActivityAt < base.lastActivityAt) {
      next.lastActivityAt = base.lastActivityAt; // 단조 증가
    }
    // 파일·훅 다중 소스가 병합되는 시각 필드는 뒤로 가지 않음 (예: 과거 Esc 마커 재발행이
    // 더 새로운 훅 stop을 덮어쓰지 않도록)
    for (const k of ['stoppedAt', 'approvalAt', 'turnStartedAt', 'lastWorkAt'] as const) {
      const nv = p.fields[k];
      const old = base[k];
      if (nv !== undefined && old !== undefined && nv < old) next[k] = old;
    }
    // patch 유래 상태 이벤트(codex rollout의 approval/turn-complete)도 stale 판정에 참여
    for (const t of [p.fields.approvalAt, p.fields.stoppedAt]) {
      if (t !== undefined && t > next.lastEventAt) next.lastEventAt = t;
    }
    // 부활: exited로 기록된 세션에 더 새로운 활동이 오면 종료 상태 해제 (resume 대응)
    if (next.exitedAt !== undefined && next.lastActivityAt > base.lastActivityAt) {
      next.exitedAt = undefined;
      next.processAlive = undefined;
      next.pid = undefined;
      next.mapping = 'none';
      next.parentKey = undefined;
      next.everAlive = undefined; // 재생존 확인 전까지는 미확인 취급 (유령 부활 방지)
      next.registeredAt = now;    // grace도 재시작
      next.terminalName = undefined; // 이전 터미널 잔재 — 새 매핑이 다시 채움
      next.shellPid = undefined;
    }
    this.sessions.set(key, next);
    this.emit();
  }

  /** 세션을 찾아 이벤트를 적용하면 true, 스토어에 아직 없어 적용 못하면 false (호출부가 재시도 큐에 보관) */
  applyHookEvent(e: HookEvent): boolean {
    const s = this.findForEvent(e);
    if (!s) return false;
    if (e.observedAt < s.lastEventAt) return true; // stale (스펙 §5 이벤트 스키마 계약) — 세션은 찾았으므로 재시도 불필요
    s.lastEventAt = e.observedAt;
    // sessionId가 명시된 이벤트의 pid($PPID)는 매핑 힌트로 보관 — s.pid와 달리 생사 판정에
    // 직접 쓰지 않고 mapper가 살아있는 agent 프로세스와 대조 후에만 신뢰 (F3 안전)
    if (e.sessionId && e.pid !== undefined) s.hookPid = e.pid;
    switch (e.kind) {
      case 'approval':
        s.approvalAt = e.observedAt;
        break;
      case 'idle':
        // "waiting for your input" — 턴 종료 신호. 실제 활동은 아니므로 lastActivityAt 불변
        s.stoppedAt = e.observedAt;
        break;
      case 'stop':
      case 'turn-complete':
        s.stoppedAt = e.observedAt;
        s.lastActivityAt = Math.max(s.lastActivityAt, e.observedAt);
        break;
      case 'notification':
        break; // 분류 안 된 일반 알림 — 승인대기 증거가 아님 (lastEventAt만 갱신)
    }
    this.emit();
    return true;
  }

  setProcess(
    key: string,
    info: {
      pid?: number; alive?: boolean; mapping?: MappingConfidence;
      terminalName?: string; shellPid?: number; parentKey?: string | null;
      busy?: boolean;
    },
    now: number = Date.now(),
  ): void {
    const s = this.sessions.get(key);
    if (!s) return;
    if (info.pid !== undefined) s.pid = info.pid;
    if (info.busy !== undefined) s.busy = info.busy;
    if (info.mapping !== undefined) s.mapping = info.mapping;
    if (info.terminalName !== undefined) s.terminalName = info.terminalName;
    if (info.shellPid !== undefined) s.shellPid = info.shellPid;
    if (info.parentKey === null) s.parentKey = undefined;
    else if (info.parentKey !== undefined) s.parentKey = info.parentKey;
    if (info.alive !== undefined) {
      s.processAlive = info.alive;
      if (info.alive === false && s.exitedAt === undefined) s.exitedAt = now;
      if (info.alive === true) {
        s.exitedAt = undefined;
        s.everAlive = true;
      }
    }
    this.emit();
  }

  all(): SessionState[] {
    // 플레이스홀더는 reconcile 클레임 대상이 아님 — 실제 세션만 반환
    return [...this.sessions.values()].filter((s) => !s.key.includes(':pending-'));
  }

  /** 플레이스홀더 포함 단건 조회 — 카드 클릭 → 터미널 포커스용 */
  find(key: string): SessionState | undefined {
    return this.sessions.get(key);
  }

  /**
   * 세션 파일이 아직 없는 살아있는 agent 프로세스의 플레이스홀더 카드 동기화.
   * 프로세스가 죽거나 실제 세션을 클레임하면 다음 pass에서 조용히 제거된다 (dim 없음).
   */
  syncPlaceholders(
    orphans: Array<{
      agent: AgentKind; pid: number; terminalName?: string; shellPid?: number;
      parentKey: string | null;
    }>,
    now: number = Date.now(),
  ): void {
    const want = new Set(orphans.map((o) => `${o.agent}:pending-${o.pid}`));
    let changed = false;
    for (const key of [...this.sessions.keys()]) {
      if (key.includes(':pending-') && !want.has(key)) {
        this.sessions.delete(key);
        changed = true;
      }
    }
    for (const o of orphans) {
      const key = `${o.agent}:pending-${o.pid}`;
      const cur = this.sessions.get(key);
      const s: SessionState & { exitedAt?: number } = cur ?? {
        key, agent: o.agent, sessionId: `pending-${o.pid}`, filePath: '',
        topic: 'Waiting for first query…', totalTokens: 0, contextTokens: 0,
        lastActivityAt: now, lastEventAt: 0, registeredAt: now,
        mapping: 'heuristic',
      };
      if (!cur) changed = true;
      s.pid = o.pid;
      s.processAlive = true;
      s.everAlive = true;
      s.lastActivityAt = now; // 외부 exited 판정 방지 (프로세스 생존이 곧 근거)
      s.stoppedAt = now;      // 실작업 증거가 없는 한 항상 idle (running 오판 방지)
      if (s.terminalName !== o.terminalName && o.terminalName !== undefined) {
        s.terminalName = o.terminalName;
        changed = true;
      }
      if (o.shellPid !== undefined) s.shellPid = o.shellPid;
      const parent = o.parentKey ?? undefined;
      if (s.parentKey !== parent) { s.parentKey = parent; changed = true; }
      this.sessions.set(key, s);
    }
    if (changed) this.emit();
  }

  list(now: number): SessionView[] {
    // prune
    for (const [key, s] of this.sessions) {
      if (s.exitedAt !== undefined && now - s.exitedAt > PRUNE_AFTER_MS) this.sessions.delete(key);
    }
    const views: SessionView[] = [];
    for (const [key, s] of this.sessions) {
      const status = computeStatus({
        ...s,
        now,
        processAlive: s.exitedAt !== undefined ? false : s.processAlive,
        turnTrackingReliable: this.turnTracking[s.agent],
      });
      if (s.everAlive !== true) {
        // 매핑이 생존을 확정하기 전에는 표시하지 않음 — 부트스트랩 유령·서브에이전트가
        // 최상위에 잠깐 떴다 사라지는 팝인/아웃 방지. 확정되면 다음 pass에서 나타남.
        const inGrace =
          s.processAlive === undefined &&
          s.registeredAt !== undefined && now - s.registeredAt < REGISTER_GRACE_MS;
        // grace 내(미확인)는 보존만, 그 외(죽음 확인·grace 만료 후 exited 판정)는 조용히 제거
        if (s.processAlive === false || (status === 'exited' && !inGrace)) {
          this.sessions.delete(key);
        }
        continue;
      }
      // 외부 세션(processAlive undefined)이 시간 경과로 exited 판정되면 exitedAt 물질화
      // — 물질화하지 않으면 prune 대상이 되지 못해 영구 잔류함
      if (status === 'exited' && s.exitedAt === undefined) s.exitedAt = now;
      views.push({ ...s, status });
    }
    // 서브에이전트 그룹핑: parentKey가 "최상위(자신은 부모 없음)" 세션을 가리킬 때만 자식으로
    // 편입 (1단계 강제 — 사이클/다단계는 최상위로 승격되어 재귀 불가)
    const byKey = new Map(views.map((v) => [v.key, v]));
    const isChild = (v: SessionView): boolean => {
      if (!v.parentKey) return false;
      const p = byKey.get(v.parentKey);
      return p !== undefined && !p.parentKey;
    };
    // 정렬은 등록순 고정 — 상태 변화로 카드 순서가 오락가락하지 않음 (승인대기는 색/뱃지로 강조)
    const stable = (a: SessionView, b: SessionView) =>
      (a.registeredAt ?? 0) - (b.registeredAt ?? 0) || a.key.localeCompare(b.key);
    const top = views.filter((v) => !isChild(v));
    for (const parent of top) {
      const kids = views.filter((c) => isChild(c) && c.parentKey === parent.key).sort(stable);
      if (kids.length > 0) parent.children = kids;
    }
    top.sort(stable);
    return top;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private findForEvent(e: HookEvent): (SessionState & { exitedAt?: number }) | undefined {
    if (e.sessionId) {
      // sessionId가 명시된 이벤트는 그 세션이 스토어에 없어도 다른 세션으로 폴백하지 않음
      // (pid/최근세션 폴백은 sessionId 부재 시에만 — 오귀속 방지)
      return this.sessions.get(`${e.agent}:${e.sessionId}`);
    }
    if (e.pid !== undefined) {
      for (const s of this.sessions.values()) if (s.agent === e.agent && s.pid === e.pid) return s;
    }
    // 폴백: 같은 agent에서 가장 최근 활동한 비-exited 세션
    let best: (SessionState & { exitedAt?: number }) | undefined;
    for (const s of this.sessions.values()) {
      if (s.agent !== e.agent || s.exitedAt !== undefined) continue;
      if (!best || s.lastActivityAt > best.lastActivityAt) best = s;
    }
    return best;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
