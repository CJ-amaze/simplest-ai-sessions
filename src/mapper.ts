import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { AgentKind, SessionState, TmuxRef } from './types';

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

// claude 데몬 아키텍처(2.1.20x)의 인프라 프로세스 — 세션이 아니므로 카드 대상 아님.
// (bg 세션의 "진짜" 프로세스는 versions/<semver> 바이너리로 떠서 여기 안 걸리고,
// 네이티브 바인딩 보강으로 별도 인정된다)
const CLAUDE_INFRA_ARGS = new Set(['daemon', 'bg-pty-host', 'bg-spare', '--bg-pty-host', '--bg-spare']);

export function detectAgent(command: string): AgentKind | null {
  const tokens = command.split(/\s+/);
  // argv[0], 또는 node/bun 래퍼면 argv[1]의 basename 검사
  const candidates = [tokens[0]];
  const first = tokens[0]?.split('/').pop();
  if ((first === 'node' || first === 'bun') && tokens[1]) candidates.push(tokens[1]);
  for (let i = 0; i < candidates.length; i++) {
    const base = candidates[i]?.split('/').pop();
    if (base === 'claude') {
      const arg = tokens[i + 1];
      return arg !== undefined && CLAUDE_INFRA_ARGS.has(arg) ? null : 'claude';
    }
    if (base === 'codex') return 'codex';
  }
  return null;
}

const TRANSCRIPT_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/;

export interface CodexBinding { sessionId: string; filePath: string }

/** lsof's process records identify the rollout actually held open by Codex. */
export function parseCodexBindings(output: string): Map<number, CodexBinding> {
  const files = new Map<number, Map<string, CodexBinding>>();
  let pid: number | undefined;
  for (const line of output.split('\n')) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    if (pid === undefined || !line.startsWith('n/')) continue;
    const filePath = line.slice(1);
    if (!/\/rollout-[^/]+\.jsonl$/.test(filePath)) continue;
    const sid = filePath.match(TRANSCRIPT_UUID_RE)?.[1];
    if (!sid) continue;
    if (!files.has(pid)) files.set(pid, new Map());
    files.get(pid)!.set(filePath, { sessionId: sid, filePath });
  }
  const bindings = new Map<number, CodexBinding>();
  for (const [owner, paths] of files) {
    // Multiple live rollouts in one process are ambiguous; never guess an owner.
    if (paths.size === 1) bindings.set(owner, [...paths.values()][0]);
  }
  return bindings;
}

/** The npm wrapper and its direct Codex binary represent the same session. */
function agentOwner(pid: number, byPid: Map<number, ProcInfo>): number {
  const seen = new Set<number>();
  let proc = byPid.get(pid);
  while (proc && !seen.has(proc.pid)) {
    seen.add(proc.pid);
    const parent = byPid.get(proc.ppid);
    const kind = detectAgent(proc.command);
    if (!kind || !parent || detectAgent(parent.command) !== kind) break;
    proc = parent;
  }
  return proc?.pid ?? pid;
}

/**
 * 데몬이 스폰한 bg 서브에이전트의 부모 세션 추출 — `--fork-session --resume <부모 transcript>`
 * 커맨드라인이 유일한 신호다 (ppid=1이라 프로세스 트리로는 추적 불가).
 * ps 출력엔 따옴표가 없어 공백 경로는 토큰 분리로 못 다룸 → --resume 이후~다음 플래그
 * 사이 구간에서 `<uuid>.jsonl`을 직접 찾는다.
 */
export function parseForkParentSessionId(command: string): string | null {
  if (!/(^|\s)--fork-session(\s|$)/.test(command)) return null;
  const m = command.match(/(^|\s)--resume\s+(.*?)(?=\s--|$)/);
  const uuid = m?.[2].match(TRANSCRIPT_UUID_RE);
  return uuid ? uuid[1] : null;
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

// ---- tmux ----
// tmux 안 프로세스는 부모가 tmux 서버(ppid 1)라 조상 체인이 VS Code 에 닿지 않는다.
// pane_pid(pane 의 루트 프로세스 — 셸, 또는 exec 된 claude 자신) 로 세션을 알아내고,
// 그 세션에 붙은 클라이언트 pid 의 조상 체인에서 VS Code 터미널 셸을 찾는다.

export interface TmuxInfo {
  /** pane_pid → pane 위치. linked window 는 같은 pane 이 여러 세션에 나오므로 세션 목록으로는 불완전 */
  panesByPid: Map<number, TmuxRef>;
  /** session_name → 붙은 클라이언트 pid 들 (detached 세션은 항목 없음) */
  clientPidsBySession: Map<string, number[]>;
  /** 존재하는 세션 이름 전부 (list-panes 출력의 모든 줄에서) — 없으면 panesByPid 에서 유도 */
  sessions?: ReadonlySet<string>;
}

/** tmux 에 존재하는 세션 이름 집합 */
export function tmuxSessions(tmux: TmuxInfo): Set<string> {
  return new Set(tmux.sessions ?? [...tmux.panesByPid.values()].map((p) => p.session));
}

/** list-panes 출력의 모든 줄에서 세션 이름 — pane_pid 중복(linked window)에 덮어쓰이지 않는다 */
export function parseTmuxSessionNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split('\n')) {
    const m = raw.match(/^\d+ @\d+ %\d+ \d+\/\$\d+ (.+)$/);
    if (m) out.add(m[1]);
  }
  return out;
}

export const TMUX_PANES_FORMAT = '#{pane_pid} #{window_id} #{pane_id} #{pid}/#{session_id} #{session_name}';
export const TMUX_CLIENTS_FORMAT = '#{client_pid} #{session_name}';

/** `tmux list-panes -a -F TMUX_PANES_FORMAT` — 세션 이름은 공백을 가질 수 있어 줄 끝에 둔다 */
export function parseTmuxPanes(text: string): Map<number, TmuxRef> {
  const out = new Map<number, TmuxRef>();
  for (const raw of text.split('\n')) {
    const m = raw.match(/^(\d+) (@\d+) (%\d+) (\d+\/\$\d+) (.+)$/);
    if (m) out.set(Number(m[1]), { session: m[5], target: `${m[5]}:${m[2]}.${m[3]}`, id: m[4] });
  }
  return out;
}

/** `tmux list-clients -F TMUX_CLIENTS_FORMAT` */
export function parseTmuxClients(text: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const raw of text.split('\n')) {
    const m = raw.match(/^(\d+) (.+)$/);
    if (!m) continue;
    const arr = out.get(m[2]);
    if (arr) arr.push(Number(m[1]));
    else out.set(m[2], [Number(m[1])]);
  }
  return out;
}

/** 네이티브 바인딩(~/.claude/sessions/<pid>.json)의 `tmux: "session:@window.%pane"` */
export function parseTmuxTarget(s: string | undefined): TmuxRef | undefined {
  const m = s?.match(/^(.+):@\d+\.%\d+$/);
  return m && s ? { session: m[1], target: s } : undefined;
}

/** attach 터미널·자동 attach 억제의 키 — id(서버 pid 포함)가 없으면 이름 */
export function tmuxRefKey(ref: TmuxRef): string {
  return ref.id ?? `name:${ref.session}`;
}

/**
 * 자동 attach 대상 — 이 창에 붙은 VS Code 터미널이 없다고 "확정"된(shellPid === null) tmux 세션.
 * undefined(불확실·이전 터미널 유지)와 number(붙어 있음)는 제외. attempted 에 있는 세션은
 * 사용자가 탭을 닫은 것이므로 다시 열지 않는다. 같은 세션의 여러 프로세스(서브에이전트)는 1개로.
 */
export function autoAttachTargets(
  items: ReadonlyArray<{ tmux?: TmuxRef; shellPid?: number | null }>,
  attempted: ReadonlySet<string>,
): TmuxRef[] {
  const out = new Map<string, TmuxRef>();
  for (const it of items) {
    if (!it.tmux || it.shellPid !== null) continue;
    const key = tmuxRefKey(it.tmux);
    if (attempted.has(key) || out.has(key)) continue;
    out.set(key, it.tmux);
  }
  return [...out.values()];
}

/**
 * 추적을 잃은 attach 탭 인수(adopt) — 창 reload·확장 호스트 재시작 뒤 살아남은 attach 터미널은 새 인스턴스의 맵에 없고
 * creationOptions 도 기본 셸(`/bin/zsh -l`)로 바뀐다(2026-09-09 실측). 터미널의 shell pid 가 곧 tmux 클라이언트 pid 인 것
 * (shellPath 로 tmux 를 직접 띄운 탭)만 대상 — 사용자가 zsh 에서 `tmux attach` 한 탭은 pid 가 셸이라 제외된다.
 * 사용자가 `exec tmux attach` 한 탭은 잡히지만, 세션이 죽으면 그 탭도 어차피 끝나므로 dispose 가 무해하다.
 * 키는 attach 키 규칙(tmuxRefKey)과 같다: 그 세션 pane 의 `#{pid}/#{session_id}`, 없으면 `name:<session>`.
 */
export function adoptableAttachTerminals(
  terminalPids: Iterable<number>, tmux: TmuxInfo, tracked: ReadonlySet<number>,
): Array<{ pid: number; key: string; session: string }> {
  const sessionByClient = new Map<number, string>();
  for (const [session, pids] of tmux.clientPidsBySession) for (const p of pids) sessionByClient.set(p, session);
  const idBySession = new Map<string, string>();
  for (const p of tmux.panesByPid.values()) {
    if (p.id !== undefined && !idBySession.has(p.session)) idBySession.set(p.session, p.id);
  }
  const out: Array<{ pid: number; key: string; session: string }> = [];
  for (const pid of terminalPids) {
    if (tracked.has(pid)) continue;
    const session = sessionByClient.get(pid);
    if (session === undefined) continue;
    out.push({ pid, key: idBySession.get(session) ?? `name:${session}`, session });
  }
  return out;
}

/**
 * exited 세션의 컨테이너(tmux 세션 또는 VS Code 터미널)가 사라졌는가 — 사라졌으면 카드를 즉시 지운다
 * (kill-session·탭 닫힘 뒤 "✕ Exited" 카드가 5분 남아 번호를 쥐는 고스트 방지). 셸·tmux 세션이 살아 있으면 false(resume 대비 유지).
 * 불확실하면 false: tmux 조회 실패(tmux undefined), 터미널 pid 조회가 불완전(shellPids undefined), shellPid 없음.
 */
export function containerGone(
  s: { tmux?: TmuxRef; shellPid?: number | null } | undefined,
  tmux: TmuxInfo | undefined,
  shellPids: ReadonlySet<number> | undefined,
): boolean {
  if (!s) return false;
  if (s.tmux) {
    if (tmux === undefined) return false;
    // id(서버 pid/세션 id)가 있으면 그것으로 — 같은 이름으로 다시 만든 세션(닫고 바로 재오픈)은 다른 id 라 옛 카드가 남지 않고,
    // 이름을 바꾼 세션은 같은 id 라 살아 있는 것으로 본다 (codex 리뷰)
    if (s.tmux.id !== undefined) {
      for (const p of tmux.panesByPid.values()) if (p.id === s.tmux.id) return false;
      return true;
    }
    return !tmuxSessions(tmux).has(s.tmux.session);
  }
  return typeof s.shellPid === 'number' && shellPids !== undefined && !shellPids.has(s.shellPid);
}

// ---- 시작 시 빈 터미널 정리 (설정 aiSessions.startupLayout.closeIdleTerminals) ----
const SHELL_NAMES = new Set(['zsh', 'bash', 'sh', 'fish', 'tcsh', 'ksh', 'dash', 'nu', 'pwsh']);

/**
 * "빈 셸" 인 터미널 셸 pid — 앱 재시작으로 복원됐지만 아무것도 안 하는 터미널을 닫기 위한 판정.
 * 스냅샷에 없거나(막 죽었거나 새로 생김), 셸이 아니거나(exec 로 바뀐 프로그램), 보호 대상(세션 카드·확장이 만든 터미널),
 * 자식 프로세스가 하나라도 있으면(뭔가 돌고 있음) 제외. 입력 중·내장 명령 상태는 판별 불가 — 자식 없는 셸은 빈 것으로 본다.
 */
export function idleShellPids(
  shellPids: Iterable<number>, byPid: Map<number, ProcInfo>, protect: ReadonlySet<number>,
): number[] {
  const hasChild = new Set<number>();
  for (const p of byPid.values()) hasChild.add(p.ppid);
  const out: number[] = [];
  for (const pid of shellPids) {
    if (protect.has(pid)) continue;
    const proc = byPid.get(pid);
    if (!proc) continue;
    const base = (proc.command.split(/\s+/)[0] ?? '').replace(/^-/, '').split('/').pop() ?? '';
    if (!SHELL_NAMES.has(base)) continue;
    if (hasChild.has(pid)) continue;
    out.push(pid);
  }
  return out;
}

// ---- tmux ensure (설정 aiSessions.tmuxEnsure) ----
export interface EnsureEntry { session: string; command: string; offFile?: string }
export interface EnsureState {
  terminalAlive: boolean;  // 이 항목으로 만든 터미널이 아직 살아 있음
  startedAt?: number;      // 그 터미널을 만든 시각 — 유예 판정
  lastAttemptAt?: number;  // 마지막 실행 시도 — 쿨다운 판정
}
export const ENSURE_GRACE_MS = 90_000;    // 명령 실행 뒤 세션이 나타나야 하는 시간(넘으면 터미널 정리·재시도)
export const ENSURE_COOLDOWN_MS = 60_000; // 실패 뒤 재시도 간격 — 즉시 죽는 명령의 생성 루프 방지

export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  return p.startsWith('~/') ? home + p.slice(1) : p;
}

/**
 * 어떤 ensure 항목을 지금 실행할지. run = 세션이 없고(off 스위치 없음·살아있는 터미널 없음·쿨다운 지남),
 * stale = 터미널은 살아 있는데 유예가 지나도 세션이 안 나타난 항목(호출부가 dispose 하고 쿨다운 뒤 재시도).
 * 같은 세션 이름은 첫 항목만.
 */
export function ensureDue(
  entries: ReadonlyArray<EnsureEntry>, live: ReadonlySet<string>,
  state: ReadonlyMap<string, EnsureState>, now: number, exists: (p: string) => boolean,
): { run: EnsureEntry[]; stale: string[] } {
  const run: EnsureEntry[] = [];
  const stale: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.session || !e.command || seen.has(e.session)) continue;
    seen.add(e.session);
    if (live.has(e.session)) continue;
    if (e.offFile && exists(e.offFile)) continue;
    const st = state.get(e.session);
    if (st?.terminalAlive) {
      if (st.startedAt !== undefined && now - st.startedAt > ENSURE_GRACE_MS) stale.push(e.session);
      continue;
    }
    if (st?.lastAttemptAt !== undefined && now - st.lastAttemptAt < ENSURE_COOLDOWN_MS) continue;
    run.push(e);
  }
  return { run, stale };
}

let tmuxBinary: string | undefined | null = null; // null = 미조회
/** tmux 실행 파일 절대 경로 — 확장 호스트 PATH 에 homebrew 가 없을 수 있어 표준 위치도 본다. 1회 조회 후 캐시 */
export function findTmux(): string | undefined {
  if (tmuxBinary !== null) return tmuxBinary;
  const dirs = [...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, 'tmux');
    try {
      accessSync(p, fsConstants.X_OK);
      tmuxBinary = p;
      return p;
    } catch {
      // 다음 후보
    }
  }
  tmuxBinary = undefined;
  return undefined;
}

// singleton pairing에서 "활발히 기록 중"으로 인정하는 마지막 활동 창
export const PAIRING_FRESH_MS = 60_000;

type ReconcileSession = Pick<
  SessionState,
  | 'key' | 'agent' | 'pid' | 'hookPid' | 'cwd' | 'launchCwd'
  | 'lastActivityAt' | 'processAlive' | 'registeredAt' | 'shellPid'
>;

export interface ReconcileInput {
  agents: ProcInfo[];
  byPid: Map<number, ProcInfo>;
  /** VS Code 터미널 shell pid → 터미널 이름 */
  shellPids: Map<number, string | undefined>;
  sessions: ReadonlyArray<ReconcileSession>;
  /** 사전 조회된 agent 프로세스 cwd (없으면 휴리스틱 매칭 불가) */
  cwdByPid: Map<number, string | undefined>;
  /** Claude Code 자체 선언 바인딩 (~/.claude/sessions/<pid>.json) — 최우선 신호. name은 표시용 */
  nativeBindings?: Map<number, {
    sessionId: string; status?: 'busy' | 'idle'; name?: string; nameSource?: 'user' | 'derived'; tmux?: string;
  }>;
  codexBindings?: Map<number, CodexBinding>;
  /** tmux 서버 조회 결과. undefined = 조회 실패(불확실) — tmux 경유 shellPid 는 기존값을 유지한다 */
  tmux?: TmuxInfo;
  /** 플레이스홀더(세션 파일 전 프로세스)의 현재 shellPid (pid → shellPid) — 일시 실패 때 유지 판단용 */
  placeholderShellPids?: Map<number, number>;
  now: number;
}

export interface ReconcileResult {
  claims: Array<{
    key: string; pid: number; mapping: 'exact' | 'heuristic';
    terminalName?: string;
    shellPid?: number | null; // null = VS Code 터미널 연결 해제 확정(tmux 클라이언트 떠남) → 저장값 삭제
    tmux?: TmuxRef;           // tmux 경유 프로세스 — shellPid 없으면 클릭 시 attach
    busy: boolean; // 프로세스 트리에 유의미한 CPU 사용 존재 (Esc 중단 vs 긴 도구 실행 판별)
    nativeStatus?: 'busy' | 'idle'; // Claude Code 자체 선언 상태 (있을 때만)
    name?: string;                  // 네이티브 바인딩의 세션 이름
    nameSource?: 'user' | 'derived';
  }>;
  /** 어느 프로세스도 클레임하지 않은 세션 — 즉시 exited 처리 대상 (등록 grace 지난 것만) */
  exited: string[];
  /** 서브에이전트 연결: parentKey=null은 "부모 없음 확인 → 기존 연결 해제" */
  parentLinks: Array<{ key: string; parentKey: string | null }>;
  /** 세션 파일이 아직 없는 살아있는 agent 프로세스 (예: 첫 쿼리 전 codex) — 플레이스홀더 카드 대상 */
  orphanProcs: Array<{
    agent: AgentKind; pid: number; terminalName?: string; shellPid?: number | null; tmux?: TmuxRef;
    parentKey: string | null;
    topic?: string; // 네이티브 바인딩의 세션 이름 — 있으면 "Waiting for first query…" 대신 표시
  }>;
}

/**
 * 프로세스 ↔ 세션 reconciliation (순수 함수 — 직접 테스트 가능).
 * 클레임 우선순위: (0) native session / open rollout → (1) s.hookPid — 훅의 $PPID,
 * 잘못 고착된 저장 pid도 매 pass 교정한다 → (2) s.pid(이전 pass의 결과) → (3) cwd 휴리스틱
 * (launchCwd 우선 — 세션 내부 cd로 표시용 cwd가 바뀌어도 프로세스 OS cwd는 시작 디렉토리)
 * → (4) singleton pairing. 프로세스·세션 모두 1회만 소비. 클레임 실패 세션은 즉시 exited
 * — "카드 수 = 살아있는 agent 프로세스 수" 불변식.
 */
export function reconcileSessions(input: ReconcileInput): ReconcileResult {
  const {
    byPid, shellPids, sessions, cwdByPid, nativeBindings, codexBindings, tmux, placeholderShellPids, now,
  } = input;
  // 래퍼 collapse: "직계 부모"가 같은 agent인 프로세스만 제외 (node 래퍼 → 바이너리는 항상
  // 직접 부모-자식). 진짜 동종 서브에이전트는 셸(zsh -c)을 거쳐 스폰되므로 걸러지지 않음.
  const agents = input.agents.filter((p) => {
    const parent = byPid.get(p.ppid);
    return !(parent && detectAgent(parent.command) === detectAgent(p.command));
  });
  // 바인딩 보강: 네이티브 바인딩의 pid가 살아있는데 커맨드 모양으로는 미검출인 프로세스
  // (데몬이 versions/<semver> 바이너리로 스폰한 bg 세션)를 claude agent로 인정.
  // PID 재사용 방어: 커맨드라인에 바인딩의 sessionId가 실제로 있어야 함 — 바인딩 파일이
  // stale로 남고 pid가 무관한 프로세스에 재할당된 경우를 걸러낸다.
  const agentOverride = new Map<number, AgentKind>();
  // 커맨드라인에 바인딩 sessionId가 실제로 박힌 프로세스는 소속 세션이 "증명"된 것 —
  // pass 0(등록된 경우) 외 어떤 세션도 이 프로세스를 클레임할 수 없다. 바인딩 세션이
  // 아직 미등록일 때 같은 pid를 기록한 옛 세션이 pass 1/2로 가로채는 것(유령 부활 +
  // 플레이스홀더 누락)을 막는다.
  const boundKeyByPid = new Map<number, string>();
  for (const [pid, binding] of codexBindings ?? []) {
    if (detectAgent(byPid.get(pid)?.command ?? '') !== 'codex') continue;
    boundKeyByPid.set(agentOwner(pid, byPid), `codex:${binding.sessionId}`);
  }
  if (nativeBindings) {
    for (const [pid, nat] of nativeBindings) {
      const proc = byPid.get(pid);
      if (!proc || !proc.command.includes(nat.sessionId)) continue;
      boundKeyByPid.set(pid, `claude:${nat.sessionId}`);
      if (!agents.some((p) => p.pid === pid) && detectAgent(proc.command) === null) {
        agentOverride.set(pid, 'claude');
        agents.push(proc);
      }
    }
  }
  const agentOf = (p: ProcInfo): AgentKind | null =>
    agentOverride.get(p.pid) ?? detectAgent(p.command);
  const claimAllowed = (proc: ProcInfo, key: string): boolean => {
    const bound = boundKeyByPid.get(proc.pid);
    return bound === undefined || bound === key;
  };
  const claimedSessions = new Set<string>();
  const sessionByProc = new Map<number, string>();
  const claims: ReconcileResult['claims'] = [];

  const byAgentRecent = (agent: AgentKind): ReconcileSession[] =>
    sessions
      .filter((s) => s.agent === agent)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  /**
   * 프로세스가 속한 VS Code 터미널(shell pid) 결정.
   * ① 자기 자신·조상 체인에 VS Code 터미널 셸이 있으면 그것 (일반 경로. 자기 pid 포함 —
   *    pane 에서 exec 된 claude 는 pane_pid 가 자신이다).
   * ② 없으면 tmux 경유인지 본다: 체인에 pane_pid 가 있거나(1차), 네이티브 바인딩의 tmux 타겟(2차).
   *    그 세션에 붙은 클라이언트 pid 의 조상 체인(자기 포함 — shellPath 로 tmux 를 직접 띄운 터미널은
   *    processId 가 클라이언트 자신)에서 VS Code 셸을 찾아 기존 경로(배지·포커스·dedupe)에 태운다.
   * shellPid 의 세 값: number = 확인됨 / null = 연결 해제 확정(호출부가 저장값을 지운다) /
   * undefined = 불확실 — tmux 조회 실패, 또는 이전 shellPid 가 ps 상 아직 어떤 클라이언트의 조상
   * (VS Code processId 1초 타임아웃 같은 일시 실패로 보고 유지. 번호 배지가 깜빡이며 재부여되지 않도록).
   */
  const locateTerminal = (proc: ProcInfo, prevShellPid?: number): {
    shellPid?: number | null; terminalName?: string; tmux?: TmuxRef;
  } => {
    const chain = [proc.pid, ...ancestorChain(proc.pid, byPid)];
    const direct = chain.find((p) => shellPids.has(p));
    if (direct !== undefined) return { shellPid: direct, terminalName: shellPids.get(direct) };
    let ref = chain.map((p) => tmux?.panesByPid.get(p)).find((r) => r !== undefined);
    if (!ref) {
      ref = parseTmuxTarget(nativeBindings?.get(proc.pid)?.tmux);
      // 네이티브 타겟엔 session_id 가 없다 — 같은 window·pane(target 일치) 에서 보충.
      // 이름만 맞는 pane 은 재사용된 이름에 옛 바인딩이 붙는 것이라 제외
      const id = ref && tmux ? [...tmux.panesByPid.values()].find((p) => p.target === ref!.target)?.id : undefined;
      if (ref && id !== undefined) ref = { ...ref, id };
    }
    if (!ref) return { shellPid: undefined, terminalName: undefined };
    if (!tmux) return { shellPid: undefined, terminalName: undefined, tmux: ref };
    const clientPids = tmux.clientPidsBySession.get(ref.session) ?? [];
    const clientChains = clientPids.map((c) => [c, ...ancestorChain(c, byPid)]);
    for (const cc of clientChains) {
      const hit = cc.find((p) => shellPids.has(p));
      if (hit !== undefined) return { shellPid: hit, terminalName: shellPids.get(hit), tmux: ref };
    }
    // ps 스냅샷보다 늦게 붙은 클라이언트(byPid 에 없음)가 있으면 조상을 모른다 — 이번 pass 는 불확실.
    // (main.sh 가 세션을 만들며 곧바로 attach 하는 기동 순간에 해제 확정→중복 attach 탭이 생기는 것 방지)
    const unknownClient = clientPids.some((c) => !byPid.has(c));
    const keep = unknownClient ||
      (prevShellPid !== undefined && clientChains.some((cc) => cc.includes(prevShellPid)));
    return { shellPid: keep ? undefined : null, terminalName: undefined, tmux: ref };
  };

  const claim = (proc: ProcInfo, s: ReconcileSession, mapping: 'exact' | 'heuristic'): void => {
    claimedSessions.add(s.key);
    sessionByProc.set(proc.pid, s.key);
    claims.push({
      key: s.key, pid: proc.pid, mapping,
      ...locateTerminal(proc, s.shellPid),
      busy: isBusy(proc.pid, byPid),
      nativeStatus: nativeBindings?.get(proc.pid)?.status,
      name: nativeBindings?.get(proc.pid)?.name,
      nameSource: nativeBindings?.get(proc.pid)?.nameSource,
    });
  };

  // Open rollout ownership wins over hooks, cached PIDs and cwd guesses, including
  // /new and /resume in an existing process. Reserve the PID even before discovery.
  for (const proc of agents) {
    const key = boundKeyByPid.get(proc.pid);
    if (!key || agentOf(proc) !== 'codex') continue;
    const match = sessions.find((s) => s.key === key && !claimedSessions.has(key));
    if (match) claim(proc, match, 'exact');
  }

  // pass 0: Claude Code 자체 선언 (~/.claude/sessions/<pid>.json) — 추측이 아닌 사실.
  // 어떤 휴리스틱·저장값과 충돌해도 이것이 이긴다
  if (nativeBindings) {
    for (const proc of agents) {
      if (sessionByProc.has(proc.pid)) continue;
      const agent = agentOf(proc);
      if (!agent) continue;
      const nat = nativeBindings.get(proc.pid);
      if (!nat) continue;
      const key = `${agent}:${nat.sessionId}`;
      const match = sessions.find((s) => s.key === key && !claimedSessions.has(key));
      if (match) claim(proc, match, 'exact');
    }
  }
  // pass 1/2: exact — hookPid가 먼저, 저장된 pid는 그다음 (native/open rollout 우선).
  // 순서가 반대면 재시작 레이스 등으로 한 번 잘못 저장된 pid가 영원히 고착되어
  // 올바른 hookPid가 도착해도 교정 기회를 얻지 못한다 (우선순위 역전)
  for (const field of ['hookPid', 'pid'] as const) {
    for (const proc of agents) {
      if (sessionByProc.has(proc.pid)) continue;
      const agent = agentOf(proc);
      if (!agent) continue;
      const match = byAgentRecent(agent).find(
        (s) => s[field] !== undefined && agentOwner(s[field]!, byPid) === proc.pid &&
          !claimedSessions.has(s.key) && claimAllowed(proc, s.key),
      );
      if (match) claim(proc, match, 'exact');
    }
  }
  // pass 3: cwd 휴리스틱 — 세션의 "시작 디렉토리"(launchCwd)와 프로세스 OS cwd를 대조.
  // 세션이 내부에서 cd해도 프로세스 cwd는 시작 디렉토리 그대로이므로 launchCwd가 정답.
  // exited로 기록된 세션은 제외 (유령 부활은 exact 신호만 가능)
  for (const proc of agents) {
    if (sessionByProc.has(proc.pid)) continue;
    const agent = agentOf(proc);
    if (!agent) continue;
    const cwd = cwdByPid.get(proc.pid);
    if (cwd === undefined) continue;
    const match = byAgentRecent(agent).find(
      (s) => (s.launchCwd ?? s.cwd) === cwd && s.processAlive !== false &&
        !claimedSessions.has(s.key) && claimAllowed(proc, s.key),
    );
    if (match) claim(proc, match, 'heuristic');
  }
  // pass 4: singleton pairing — cwd가 안 맞아도(codex exec --cd는 chdir하지 않음) 같은 agent의
  // 미클레임 프로세스와 "활발히 기록 중"인 미클레임 세션이 정확히 1:1이면 짝지음
  for (const kind of ['claude', 'codex'] as const) {
    // 소속이 증명된(bound) 프로세스는 임의 세션과 짝지을 수 없음 — singleton 후보에서 제외
    const procs = agents.filter(
      (p) => agentOf(p) === kind && !sessionByProc.has(p.pid) && !boundKeyByPid.has(p.pid),
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
  // (클레임 없는 래퍼·중간 셸은 건너뜀 — node 래퍼가 진짜 부모 claude를 가리는 것 방지).
  // 조상 체인이 끊긴 데몬 스폰 bg 세션(ppid=1)은 --fork-session --resume 커맨드라인으로 추적.
  const sessionKeys = new Set(sessions.map((s) => s.key));
  const parentOf = (proc: ProcInfo, selfKey?: string): string | null => {
    for (const anc of ancestorChain(proc.pid, byPid)) {
      const owner = sessionByProc.get(anc);
      if (owner !== undefined && owner !== selfKey) return owner;
    }
    const forkParent = parseForkParentSessionId(proc.command);
    if (forkParent !== null) {
      const key = `claude:${forkParent}`;
      if (key !== selfKey && sessionKeys.has(key)) return key;
    }
    return null;
  };
  const parentLinks: ReconcileResult['parentLinks'] = [];
  for (const [procPid, key] of sessionByProc) {
    const proc = byPid.get(procPid);
    parentLinks.push({ key, parentKey: proc ? parentOf(proc, key) : null });
  }

  // 세션 파일이 아직 없는 살아있는 agent 프로세스 (첫 쿼리 전 codex 등) — 플레이스홀더 대상
  const orphanProcs: ReconcileResult['orphanProcs'] = [];
  for (const proc of agents) {
    if (sessionByProc.has(proc.pid)) continue;
    const agent = agentOf(proc);
    if (!agent) continue;
    orphanProcs.push({
      agent, pid: proc.pid,
      ...locateTerminal(proc, placeholderShellPids?.get(proc.pid)),
      parentKey: parentOf(proc),
      topic: nativeBindings?.get(proc.pid)?.name,
    });
  }

  return { claims, exited, parentLinks, orphanProcs };
}

export class ProcessMapper {
  async codexBindings(agents: ProcInfo[]): Promise<Map<number, CodexBinding>> {
    const pids = agents.filter((p) => detectAgent(p.command) === 'codex').map((p) => p.pid);
    if (pids.length === 0) return new Map();
    try {
      const { stdout } = await execFileP('lsof', ['-a', '-p', pids.join(','), '-Fn'], {
        timeout: 3_000, maxBuffer: 8 * 1024 * 1024,
      });
      return parseCodexBindings(stdout);
    } catch {
      return new Map();
    }
  }

  /**
   * tmux pane·클라이언트 조회. undefined = 불확실(tmux 없음·타임아웃·실행 오류) — 호출부는 tmux 경유
   * 매핑을 건드리지 않는다. "서버 없음"은 세션 0개라는 확정 답이므로 빈 결과.
   */
  async tmuxInfo(): Promise<TmuxInfo | undefined> {
    const bin = findTmux();
    if (!bin) return undefined;
    const run = async (args: string[]): Promise<string | undefined> => {
      try {
        const { stdout } = await execFileP(bin, args, { timeout: 2_000 });
        return stdout;
      } catch (e) {
        const stderr = (e as { stderr?: unknown }).stderr;
        if (typeof stderr === 'string' && /no server running|No such file or directory/i.test(stderr)) return '';
        return undefined;
      }
    };
    const panes = await run(['list-panes', '-a', '-F', TMUX_PANES_FORMAT]);
    if (panes === undefined) return undefined;
    const clients = await run(['list-clients', '-F', TMUX_CLIENTS_FORMAT]);
    if (clients === undefined) return undefined;
    return {
      panesByPid: parseTmuxPanes(panes), clientPidsBySession: parseTmuxClients(clients),
      sessions: parseTmuxSessionNames(panes),
    };
  }

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
