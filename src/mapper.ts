import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentKind, SessionState } from './types';

const execFileP = promisify(execFile);

// 파일 등록 직후 ps 클레임 전에 exited로 오판하지 않기 위한 시작 레이스 grace
export const REGISTER_GRACE_MS = 10_000;

// busy 판정 CPU 임계값(%) — 실측: 생성 중 claude 7~12%, 유휴 0~2%, 유휴 MCP 서버 0.0%
export const BUSY_CPU_PCT = 5;

export interface ProcInfo {
  pid: number;
  ppid: number;
  pcpu: number;
  command: string;
}

export function parsePsOutput(text: string): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const raw of text.split('\n')) {
    const m = raw.trim().match(/^(\d+)\s+(\d+)\s+([\d.,]+)\s+(.+)$/);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pcpu: Number(m[3].replace(',', '.')) || 0, command: m[4] });
  }
  return out;
}

/** 프로세스 자신 또는 자손 중 CPU가 임계값 이상이면 busy — 유휴 MCP 서버(0%)는 무시됨 */
export function isBusy(pid: number, byPid: Map<number, ProcInfo>): boolean {
  const children = new Map<number, number[]>();
  for (const p of byPid.values()) {
    const arr = children.get(p.ppid);
    if (arr) arr.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const queue = [pid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const proc = byPid.get(cur);
    if (proc && proc.pcpu >= BUSY_CPU_PCT) return true;
    for (const c of children.get(cur) ?? []) queue.push(c);
  }
  return false;
}

export function detectAgent(command: string): AgentKind | null {
  const tokens = command.split(/\s+/);
  // argv[0], 또는 node/bun 래퍼면 argv[1]의 basename 검사
  const candidates = [tokens[0]];
  const first = tokens[0]?.split('/').pop();
  if ((first === 'node' || first === 'bun') && tokens[1]) candidates.push(tokens[1]);
  for (const c of candidates) {
    const base = c?.split('/').pop();
    if (base === 'claude') return 'claude';
    if (base === 'codex') return 'codex';
  }
  return null;
}

export function ancestorChain(pid: number, byPid: Map<number, ProcInfo>): number[] {
  const chain: number[] = [];
  const seen = new Set<number>([pid]);
  let cur = byPid.get(pid);
  while (cur && cur.ppid > 0 && !seen.has(cur.ppid)) {
    chain.push(cur.ppid);
    seen.add(cur.ppid);
    cur = byPid.get(cur.ppid);
  }
  return chain;
}

// singleton pairing에서 "활발히 기록 중"으로 인정하는 마지막 활동 창
export const PAIRING_FRESH_MS = 60_000;

type ReconcileSession = Pick<
  SessionState,
  | 'key' | 'agent' | 'pid' | 'hookPid' | 'cwd' | 'launchCwd'
  | 'lastActivityAt' | 'processAlive' | 'registeredAt'
>;

export interface ReconcileInput {
  agents: ProcInfo[];
  byPid: Map<number, ProcInfo>;
  /** VS Code 터미널 shell pid → 터미널 이름 */
  shellPids: Map<number, string | undefined>;
  sessions: ReadonlyArray<ReconcileSession>;
  /** 사전 조회된 agent 프로세스 cwd (없으면 휴리스틱 매칭 불가) */
  cwdByPid: Map<number, string | undefined>;
  /** Claude Code 자체 선언 바인딩 (~/.claude/sessions/<pid>.json) — 최우선 신호 */
  nativeBindings?: Map<number, { sessionId: string; status?: 'busy' | 'idle' }>;
  now: number;
}

export interface ReconcileResult {
  claims: Array<{
    key: string; pid: number; mapping: 'exact' | 'heuristic';
    terminalName?: string; shellPid?: number;
    busy: boolean; // 프로세스 트리에 유의미한 CPU 사용 존재 (Esc 중단 vs 긴 도구 실행 판별)
    nativeStatus?: 'busy' | 'idle'; // Claude Code 자체 선언 상태 (있을 때만)
  }>;
  /** 어느 프로세스도 클레임하지 않은 세션 — 즉시 exited 처리 대상 (등록 grace 지난 것만) */
  exited: string[];
  /** 서브에이전트 연결: parentKey=null은 "부모 없음 확인 → 기존 연결 해제" */
  parentLinks: Array<{ key: string; parentKey: string | null }>;
  /** 세션 파일이 아직 없는 살아있는 agent 프로세스 (예: 첫 쿼리 전 codex) — 플레이스홀더 카드 대상 */
  orphanProcs: Array<{
    agent: AgentKind; pid: number; terminalName?: string; shellPid?: number;
    parentKey: string | null;
  }>;
}

/**
 * 프로세스 ↔ 세션 reconciliation (순수 함수 — 직접 테스트 가능).
 * 클레임 우선순위: (1) s.hookPid — 훅이 커널에서 보증하는 $PPID, 가장 강한 증거이므로
 * 잘못 고착된 저장 pid도 매 pass 교정한다 → (2) s.pid(이전 pass의 결과) → (3) cwd 휴리스틱
 * (launchCwd 우선 — 세션 내부 cd로 표시용 cwd가 바뀌어도 프로세스 OS cwd는 시작 디렉토리)
 * → (4) singleton pairing. 프로세스·세션 모두 1회만 소비. 클레임 실패 세션은 즉시 exited
 * — "카드 수 = 살아있는 agent 프로세스 수" 불변식.
 */
export function reconcileSessions(input: ReconcileInput): ReconcileResult {
  const { byPid, shellPids, sessions, cwdByPid, nativeBindings, now } = input;
  // 래퍼 collapse: "직계 부모"가 같은 agent인 프로세스만 제외 (node 래퍼 → 바이너리는 항상
  // 직접 부모-자식). 진짜 동종 서브에이전트는 셸(zsh -c)을 거쳐 스폰되므로 걸러지지 않음.
  const agents = input.agents.filter((p) => {
    const parent = byPid.get(p.ppid);
    return !(parent && detectAgent(parent.command) === detectAgent(p.command));
  });
  const claimedSessions = new Set<string>();
  const sessionByProc = new Map<number, string>();
  const claims: ReconcileResult['claims'] = [];

  const byAgentRecent = (agent: AgentKind): ReconcileSession[] =>
    sessions
      .filter((s) => s.agent === agent)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  const claim = (proc: ProcInfo, s: ReconcileSession, mapping: 'exact' | 'heuristic'): void => {
    claimedSessions.add(s.key);
    sessionByProc.set(proc.pid, s.key);
    const shellPid = ancestorChain(proc.pid, byPid).find((p) => shellPids.has(p));
    claims.push({
      key: s.key, pid: proc.pid, mapping,
      terminalName: shellPid !== undefined ? shellPids.get(shellPid) : undefined,
      shellPid,
      busy: isBusy(proc.pid, byPid),
      nativeStatus: nativeBindings?.get(proc.pid)?.status,
    });
  };

  // pass 0: Claude Code 자체 선언 (~/.claude/sessions/<pid>.json) — 추측이 아닌 사실.
  // 어떤 휴리스틱·저장값과 충돌해도 이것이 이긴다
  if (nativeBindings) {
    for (const proc of agents) {
      if (sessionByProc.has(proc.pid)) continue;
      const agent = detectAgent(proc.command);
      if (!agent) continue;
      const nat = nativeBindings.get(proc.pid);
      if (!nat) continue;
      const key = `${agent}:${nat.sessionId}`;
      const match = sessions.find((s) => s.key === key && !claimedSessions.has(key));
      if (match) claim(proc, match, 'exact');
    }
  }
  // pass 1/2: exact — hookPid(가장 강한 신호)가 먼저, 저장된 pid는 그다음.
  // 순서가 반대면 재시작 레이스 등으로 한 번 잘못 저장된 pid가 영원히 고착되어
  // 올바른 hookPid가 도착해도 교정 기회를 얻지 못한다 (우선순위 역전)
  for (const field of ['hookPid', 'pid'] as const) {
    for (const proc of agents) {
      if (sessionByProc.has(proc.pid)) continue;
      const agent = detectAgent(proc.command);
      if (!agent) continue;
      const match = byAgentRecent(agent).find(
        (s) => s[field] === proc.pid && !claimedSessions.has(s.key),
      );
      if (match) claim(proc, match, 'exact');
    }
  }
  // pass 3: cwd 휴리스틱 — 세션의 "시작 디렉토리"(launchCwd)와 프로세스 OS cwd를 대조.
  // 세션이 내부에서 cd해도 프로세스 cwd는 시작 디렉토리 그대로이므로 launchCwd가 정답.
  // exited로 기록된 세션은 제외 (유령 부활은 exact 신호만 가능)
  for (const proc of agents) {
    if (sessionByProc.has(proc.pid)) continue;
    const agent = detectAgent(proc.command);
    if (!agent) continue;
    const cwd = cwdByPid.get(proc.pid);
    if (cwd === undefined) continue;
    const match = byAgentRecent(agent).find(
      (s) => (s.launchCwd ?? s.cwd) === cwd && s.processAlive !== false && !claimedSessions.has(s.key),
    );
    if (match) claim(proc, match, 'heuristic');
  }
  // pass 4: singleton pairing — cwd가 안 맞아도(codex exec --cd는 chdir하지 않음) 같은 agent의
  // 미클레임 프로세스와 "활발히 기록 중"인 미클레임 세션이 정확히 1:1이면 짝지음
  for (const kind of ['claude', 'codex'] as const) {
    const procs = agents.filter(
      (p) => detectAgent(p.command) === kind && !sessionByProc.has(p.pid),
    );
    if (procs.length !== 1) continue;
    // pid 이력이 있는 세션 제외 — 방금 죽은 세션이 새 프로세스를 선점(유령 부활)하지 않도록.
    // 새로 시작한 세션은 아직 매핑된 적이 없어 pid가 undefined다.
    const cands = byAgentRecent(kind).filter(
      (s) => !claimedSessions.has(s.key) && s.processAlive !== false &&
        s.pid === undefined && now - s.lastActivityAt < PAIRING_FRESH_MS,
    );
    if (cands.length !== 1) continue;
    claim(procs[0], cands[0], 'heuristic');
  }

  // 미클레임 세션 → exited (등록 직후 grace 내는 다음 pass로 유예)
  const exited: string[] = [];
  for (const s of sessions) {
    if (claimedSessions.has(s.key)) continue;
    if (s.processAlive === false) continue; // 이미 exited — 반복 마킹으로 재렌더 유발 방지
    if (s.registeredAt !== undefined && now - s.registeredAt < REGISTER_GRACE_MS) continue;
    exited.push(s.key);
  }

  // 서브에이전트 연결: 조상 체인에서 "세션을 클레임한" 첫 프로세스가 부모
  // (클레임 없는 래퍼·중간 셸은 건너뜀 — node 래퍼가 진짜 부모 claude를 가리는 것 방지)
  const parentOf = (procPid: number, selfKey?: string): string | null => {
    for (const anc of ancestorChain(procPid, byPid)) {
      const owner = sessionByProc.get(anc);
      if (owner !== undefined && owner !== selfKey) return owner;
    }
    return null;
  };
  const parentLinks: ReconcileResult['parentLinks'] = [];
  for (const [procPid, key] of sessionByProc) {
    parentLinks.push({ key, parentKey: parentOf(procPid, key) });
  }

  // 세션 파일이 아직 없는 살아있는 agent 프로세스 (첫 쿼리 전 codex 등) — 플레이스홀더 대상
  const orphanProcs: ReconcileResult['orphanProcs'] = [];
  for (const proc of agents) {
    if (sessionByProc.has(proc.pid)) continue;
    const agent = detectAgent(proc.command);
    if (!agent) continue;
    const shellPid = ancestorChain(proc.pid, byPid).find((p) => shellPids.has(p));
    orphanProcs.push({
      agent, pid: proc.pid,
      terminalName: shellPid !== undefined ? shellPids.get(shellPid) : undefined,
      shellPid,
      parentKey: parentOf(proc.pid),
    });
  }

  return { claims, exited, parentLinks, orphanProcs };
}

export class ProcessMapper {
  async snapshot(): Promise<{ ok: boolean; byPid: Map<number, ProcInfo>; agents: ProcInfo[] }> {
    try {
      const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,pcpu=,command='], {
        maxBuffer: 8 * 1024 * 1024,
      });
      const procs = parsePsOutput(stdout);
      const byPid = new Map(procs.map((p) => [p.pid, p]));
      // ps 출력이 비정상적으로 비면 liveness 판정 근거가 없음 → ok=false로 pass 전체 skip
      return { ok: procs.length > 0, byPid, agents: procs.filter((p) => detectAgent(p.command) !== null) };
    } catch {
      return { ok: false, byPid: new Map(), agents: [] };
    }
  }

  async cwdOf(pid: number): Promise<string | undefined> {
    try {
      const { stdout } = await execFileP('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
      const m = stdout.match(/^n(.+)$/m);
      return m ? m[1] : undefined;
    } catch {
      return undefined;
    }
  }
}
