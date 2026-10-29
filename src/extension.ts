import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AdapterWatcher, claudeSpec, codexSpec } from './adapters/watcher';
import { EVENTS_FILE, parseHookEventLine, parseStatusLine, STATUS_FILE } from './hooks/events';
import { installHooks, removeHooks, statusShimPath, writeShim } from './hooks/installer';
import {
  adoptableAttachTerminals, autoAttachTargets, containerGone, ENSURE_GRACE_MS, ensureDue, expandHome, findTmux,
  idleShellPids, ProcessMapper, reconcileSessions, tmuxRefKey, tmuxSessions,
} from './mapper';
import type { EnsureEntry, EnsureState, ReconcileResult, TmuxInfo } from './mapper';
import { SidebarProvider } from './sidebar';
import { singleFlight, SnapshotGeneration } from './polling';
import { StateStore } from './store';
import { TailReader } from './tail';
import type { HookEvent, TmuxRef } from './types';

const SCAN_MS = 2_000;
const EVENTS_MS = 1_000;
const MAP_MS = 5_000;
const PENDING_TTL_MS = 60_000;
const PENDING_MAX = 100;

// 진단 로그 — 라이브 장애(스캔 멈춤 등)를 원격 재현 없이 확진하기 위한 최소 관측면
let logChannel: vscode.OutputChannel | undefined;
function log(msg: string): void {
  logChannel?.appendLine(`${new Date().toLocaleTimeString('en-GB')} ${msg}`); // 로컬 시각
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  logChannel = vscode.window.createOutputChannel('AI Sessions');
  context.subscriptions.push(logChannel);
  log(`activate v${(context.extension.packageJSON as { version?: string }).version ?? '?'}`);
  // 시작 정리 후보는 활성화 진입 시점의 터미널만 — priming 동안 사용자가 새로 연 터미널은 건드리지 않는다
  const initialTerminals = new Set(vscode.window.terminals);

  const store = new StateStore();
  const tail = new TailReader();
  const eventsTail = new TailReader();
  const statusTail = new TailReader();
  const mapper = new ProcessMapper();
  const codexWatcher = new AdapterWatcher(codexSpec(), tail, (p) => store.applyPatch(p));
  const watchers = [
    new AdapterWatcher(claudeSpec(), tail, (p) => store.applyPatch(p)),
    codexWatcher,
  ];

  const provider = new SidebarProvider(
    store,
    (key) => void focusTerminal(store, key),
    () => vscode.window.createTerminal().show(), // ＋ 새 터미널 — 세션 시작용
    (shellPid) => void focusTerminalByShellPid(shellPid),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, provider),
  );
  sidebar = provider;
  const offChange = store.onChange(() => provider.refresh());
  context.subscriptions.push({ dispose: offChange });

  // 활성 터미널 추적 — 해당 세션 카드 강조
  const updateActiveTerminal = async (term: vscode.Terminal | undefined): Promise<void> => {
    provider.setActiveShellPid(term ? await terminalPid(term) : undefined);
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal((t) => void updateActiveTerminal(t)),
  );
  void updateActiveTerminal(vscode.window.activeTerminal);
  // 터미널 생성/종료 시 목록을 5초 기다리지 않고 즉시 반영
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => remap()),
    vscode.window.onDidCloseTerminal((t) => {
      forgetAttachTerminal(t);
      forgetEnsureTerminal(t);
      remap();
    }),
  );

  // Stateful scan/event readers share their startup and interval flight. Only
  // mapping may restart a stale flight, with a generation guard before commit.
  const passAges: Record<string, number> = {}; // 하트비트용 — 마지막 "완료" 시각
  function poll(name: string, fn: () => Promise<void>, staleMs?: number): () => Promise<void> {
    return singleFlight(async () => {
      try {
        await fn();
        passAges[name] = Date.now();
      } catch (e) {
        log(`${name}: 오류 — ${String(e).slice(0, 200)}`);
      }
    }, {
      staleMs,
      onStale: (age) => log(`${name}: flight ${Math.round(age / 1000)}s째 미완료 — 멈춤 판단, 재시작`),
    });
  }

  // 하트비트 (60s) — pass별 마지막 완료 나이. 멈춤/에러가 한 줄로 보이게
  const heartbeat = setInterval(() => {
    const now = Date.now();
    const ages = Object.entries(passAges)
      .map(([k, t]) => `${k}=${Math.round((now - t) / 1000)}s전`)
      .join(' ');
    log(`heartbeat: 세션 ${store.all().length}개, 마지막 완료 ${ages || '(없음)'}`);
  }, 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(heartbeat) });

  // 파일 스캔 (2s)
  const doScan = async (): Promise<void> => {
    const now = Date.now();
    for (const w of watchers) await w.scan(now).catch((e) => log(`scan: ${String(e).slice(0, 120)}`));
  };
  const scan = poll('scan', doScan);

  // hook 이벤트 tail (1s) — 세션 등록 전에 도착한 이벤트(sessionId 명시, 스토어 미등록)는
  // pending에 보관 후 매 drain 시작 시 재시도. 60초 만료, 최대 100개 (F1)
  const pending: Array<{ e: HookEvent; expiresAt: number }> = [];
  const doDrain = async (): Promise<void> => {
    const now = Date.now();
    if (pending.length > 0) {
      const retry = pending.splice(0);
      for (const item of retry) {
        if (now >= item.expiresAt) continue; // 만료 — 폐기
        if (!store.applyHookEvent(item.e)) pending.push(item);
      }
    }
    const { lines } = await eventsTail.readNewLines(EVENTS_FILE, { bootstrapBytes: 65536 });
    for (const l of lines) {
      const e = parseHookEventLine(l);
      if (!e) continue;
      if (!store.applyHookEvent(e) && pending.length < PENDING_MAX) {
        pending.push({ e, expiresAt: now + PENDING_TTL_MS });
      }
    }
    // statusline 연동(설치 시) — 세션별 effort. 마지막 값만 유효하므로 재시도 큐 불필요
    const st = await statusTail.readNewLines(STATUS_FILE, { bootstrapBytes: 16384 });
    for (const l of st.lines) {
      const rec = parseStatusLine(l);
      if (!rec?.effort) continue;
      const key = `claude:${rec.sessionId}`;
      const cur = store.find(key);
      if (!cur) continue; // 세션 미등록 — 다음 statusline 갱신에서 자연 반영
      store.applyPatch({
        agent: 'claude', sessionId: rec.sessionId, filePath: cur.filePath,
        fields: { effort: rec.effort },
      });
    }
  };
  const drainEvents = poll('events', doDrain);

  // 프로세스 ↔ 터미널 매핑 (5s)
  const doRemap = (): Promise<void> => refreshMapping(store, mapper, codexWatcher);
  const map = poll('map', doRemap, 60_000);
  let primed = false;
  const remap = (): void => { if (primed) void map(); };
  requestRemap = remap;
  let disposed = false;
  context.subscriptions.push({ dispose: () => { disposed = true; } });

  // priming — 재시작 직후 첫 매핑이 세션 등록·이벤트 재생(hookPid 복원)보다 먼저 돌면
  // 엉터리 cwd 추측으로 바인딩되고 pid로 고착된다. 순서를 강제: 등록 → 이벤트 → 매핑
  void (async () => {
    await scan();
    if (disposed) return;
    await drainEvents();
    if (disposed) return;
    await map();
    if (disposed) return;
    primed = true;
    for (const [run, ms] of [[scan, SCAN_MS], [drainEvents, EVENTS_MS], [remap, MAP_MS]] as const) {
      const timer = setInterval(run, ms);
      context.subscriptions.push({ dispose: () => clearInterval(timer) });
    }
    log('priming 완료 (등록→이벤트→매핑)');
    // 시작 레이아웃은 첫 매핑(ensure·자동 attach 가 터미널을 만든 뒤)에 이어서
    await applyStartupLayout(store, mapper, initialTerminals)
      .catch((e) => log(`startup layout: ${String(e).slice(0, 120)}`));
  })();

  // 상태 tick (5s) — store 변경이 없어도 시간 경과(running→idle, 외부 exited)로
  // 상태가 바뀌므로 미매핑 카드 포함 주기적 재렌더
  const tickTimer = setInterval(() => provider.refresh(), 5_000);
  context.subscriptions.push({ dispose: () => clearInterval(tickTimer) });

  // hook/statusline shim — 설정 파일에는 고정 경로만 기록 (확장 업그레이드로 번들 경로가 바뀌어도 불변)
  const bundled = context.asAbsolutePath(path.join('dist', 'resources', 'agent-monitor-hook.sh'));
  const bundledStatus = context.asAbsolutePath(path.join('dist', 'resources', 'agent-monitor-statusline.sh'));
  let scriptPath = '';
  let statusScript = '';
  try {
    scriptPath = await writeShim(os.homedir(), fs.readFileSync(bundled, 'utf8'));
    statusScript = statusShimPath(os.homedir());
    await fs.promises.writeFile(statusScript, fs.readFileSync(bundledStatus, 'utf8'), { mode: 0o755 });
  } catch (e) {
    void vscode.window.showWarningMessage(`AI Sessions: failed to write hook shim — ${String(e)}`);
  }
  await refreshTurnTracking(store, scriptPath);

  // 커맨드
  context.subscriptions.push(
    vscode.commands.registerCommand('aiSessions.show', () =>
      vscode.commands.executeCommand('aiSessions.sidebar.focus'),
    ),
    vscode.commands.registerCommand('aiSessions.installHooks', () => void doInstall(scriptPath)),
    vscode.commands.registerCommand('aiSessions.removeHooks', async () => {
      if (!scriptPath) {
        void vscode.window.showErrorMessage('AI Sessions: hook shim path is not ready.');
        return;
      }
      await removeHooks(os.homedir(), scriptPath);
      await refreshTurnTracking(store, scriptPath); // Stop 훅 제거 → 턴 추적 신뢰 해제
      void vscode.window.showInformationMessage('AI Sessions: hooks removed.');
    }),
  );

  // 첫 실행 시 hooks 설치 동의 (1회만 질문)
  if (!context.globalState.get('hooksPrompted')) {
    void context.globalState.update('hooksPrompted', true);
    void vscode.window
      .showInformationMessage(
        'AI Sessions: to detect approval-waiting accurately, Claude Code hooks / codex hooks+notify need to be configured. Install now? (existing settings preserved, backup created)',
        'Install', 'Later',
      )
      .then((pick) => {
        if (pick === 'Install') void doInstall(scriptPath);
      });
  }

  async function doInstall(script: string): Promise<void> {
    if (!script) {
      void vscode.window.showErrorMessage('AI Sessions: hook shim path is not ready.');
      return;
    }
    const r = await installHooks(os.homedir(), script, statusScript);
    await refreshTurnTracking(store, script);
    void vscode.window.showInformationMessage(
      `AI Sessions hooks — claude: ${r.claude}, codex: ${r.codex}, statusline: ${r.statusline}. ` +
      'codex approval detection: run /hooks inside codex once to trust the new PermissionRequest hook.',
    );
  }
}

/**
 * claude 턴 추적 신뢰도 갱신 — Stop 훅에 우리 shim이 실제로 걸려 있어야만
 * "턴 열림 = running" 판정을 켠다 (훅 없는 degraded 모드에서 영구 running 방지).
 * codex는 rollout 파일 자체에 턴 이벤트가 있어 store 기본값(true) 유지.
 */
async function refreshTurnTracking(store: StateStore, scriptPath: string): Promise<void> {
  let reliable = false;
  try {
    if (scriptPath) {
      const raw = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
      const obj = JSON.parse(raw) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
      };
      reliable = (obj.hooks?.Stop ?? []).some((e) =>
        (e.hooks ?? []).some((h) => h.command?.includes(scriptPath)),
      );
    }
  } catch {
    reliable = false;
  }
  store.setTurnTracking('claude', reliable);
}

interface NativeBinding {
  sessionId: string;
  status?: 'busy' | 'idle';
  name?: string;
  nameSource?: 'user' | 'derived'; // user = `claude -n <이름>`; derived = cwd 등에서 파생
  tmux?: string; // "session:@window.%pane" — tmux 안에서 뜬 세션 (2.1.26x+)
}

/**
 * Claude Code가 직접 기록하는 세션 상태 파일 (~/.claude/sessions/<pid>.json, v2.1.206+)
 * — pid ↔ sessionId 정확 바인딩. 존재하면 매핑 추측이 전혀 필요 없다.
 */
async function readNativeBindings(): Promise<Map<number, NativeBinding>> {
  const map = new Map<number, NativeBinding>();
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  let entries: string[] = [];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return map; // 구버전 Claude Code — 디렉토리 없음
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const d = JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8')) as {
        pid?: number; sessionId?: string; status?: string; name?: string; nameSource?: string; tmux?: string;
      };
      if (typeof d.pid === 'number' && typeof d.sessionId === 'string') {
        map.set(d.pid, {
          sessionId: d.sessionId,
          status: d.status === 'busy' || d.status === 'idle' ? d.status : undefined,
          name: typeof d.name === 'string' && d.name.length > 0 ? d.name : undefined,
          nameSource: d.nameSource === 'user' || d.nameSource === 'derived' ? d.nameSource : undefined,
          tmux: typeof d.tmux === 'string' && d.tmux.length > 0 ? d.tmux : undefined,
        });
      }
    } catch {
      // 손상/쓰는 중 — 무시
    }
  }
  return map;
}

/** 죽은/이상 상태 터미널의 processId는 영구 pending일 수 있음 — 1초 상한 */
function terminalPid(term: vscode.Terminal): Promise<number | undefined> {
  return Promise.race<number | undefined>([
    term.processId,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1_000)),
  ]);
}

async function findTerminal(shellPid: number): Promise<vscode.Terminal | undefined> {
  for (const term of vscode.window.terminals) {
    if ((await terminalPid(term)) === shellPid) return term;
  }
  return undefined;
}

/**
 * 카드 클릭 → 터미널 포커스. 터미널 이름은 중복 가능하므로 shellPid로 식별.
 * tmux 세션이면 먼저 서버 측에서 그 window/pane 을 선택해 두고(클라이언트 유무 무관), 붙은 VS Code
 * 터미널이 있으면 포커스, 없으면(detached·다른 앱에서만 attach·stale) 새 터미널로 attach.
 */
async function focusTerminal(store: StateStore, key: string): Promise<void> {
  // find(): 플레이스홀더(첫 쿼리 전 codex 등) 카드도 포커스 가능해야 함 — all()은 이를 제외한다
  const s = store.find(key);
  if (!s) return;
  if (s.tmux) await selectTmuxTarget(s.tmux);
  if (s.shellPid !== undefined) {
    const term = await findTerminal(s.shellPid);
    if (term) {
      term.show();
      return;
    }
  }
  if (s.tmux) ensureAttachTerminal(s.tmux, true);
}

/** "session:@w.%p" 의 window/pane 을 현재로 — best-effort, 실패는 무시 */
async function selectTmuxTarget(ref: TmuxRef): Promise<void> {
  const bin = findTmux();
  const m = ref.target.match(/^(.+):(@\d+)\.(%\d+)$/);
  if (!bin || !m) return;
  const run = (args: string[]): Promise<void> =>
    new Promise((resolve) => execFile(bin, args, { timeout: 2_000 }, () => resolve()));
  await run(['select-window', '-t', `=${m[1]}:${m[2]}`]);
  await run(['select-pane', '-t', m[3]]);
}

// ---- tmux attach 터미널 관리 ----
// 확장이 만든 attach 터미널 (자동·클릭 공통). key = tmuxRefKey — 생성 직후 클릭·연타·다음 pass 의
// 자동 attach 가 같은 세션에 탭을 하나 더 만들지 않도록 한 경로로 모은다.
const attachTerminals = new Map<string, vscode.Terminal>();
// 자동 attach 를 시도한 세션 — 사용자가 그 탭을 닫으면(detach) 같은 세션엔 다시 열지 않는다.
// 세션이 사라지면 정리되므로 같은 이름으로 다시 만들어진 세션(id 다름)은 다시 열린다.
const autoAttachAttempted = new Set<string>();
let tmuxMissingWarned = false;

/**
 * tmux 세션에 붙은 VS Code 터미널을 보장. 이미 만들어 둔 것이 있으면 그것(focus 면 show).
 * shellPath 로 tmux 를 직접 띄우므로 셸 인용 문제(zsh 의 `=word` 확장)가 없고, detach·세션 종료 시
 * 클라이언트가 코드 0 으로 끝나 VS Code 가 탭을 정리한다. 터미널의 processId 가 클라이언트 pid
 * 자신이라 다음 매핑 pass 에서 그대로 셸 pid 로 잡힌다. 타겟은 이름 대신 id(있으면) — 감지와
 * attach 사이에 이름이 재사용돼도 엉뚱한 세션에 붙지 않는다.
 */
function ensureAttachTerminal(ref: TmuxRef, focus: boolean): vscode.Terminal | undefined {
  const key = tmuxRefKey(ref);
  const existing = attachTerminals.get(key);
  if (existing) {
    if (focus) existing.show();
    return existing;
  }
  const bin = findTmux();
  if (!bin) {
    if (!tmuxMissingWarned) {
      tmuxMissingWarned = true;
      void vscode.window.showWarningMessage('AI Sessions: tmux binary not found — cannot attach.');
    }
    return undefined;
  }
  const target = ref.id?.split('/')[1] ?? `=${ref.session}`;
  const term = vscode.window.createTerminal({
    name: ref.session, shellPath: bin, shellArgs: ['attach-session', '-t', target],
  });
  attachTerminals.set(key, term);
  autoAttachAttempted.add(key); // 클릭으로 연 탭도 사용자가 닫으면 자동 attach 가 되살리지 않는다
  if (focus) term.show();
  log(`tmux attach: ${ref.session} (${target})${focus ? '' : ' [auto]'}`);
  // 클라이언트가 서버에 등록되기까지 잠깐 걸린다 — onDidOpenTerminal 의 즉시 remap 이 놓치면 한 번 더
  setTimeout(() => requestRemap?.(), 1_500);
  return term;
}

/** attach 터미널이 닫힘 — 맵에서 제거. 비정상 종료(attach 실패)면 자동 재시도를 허용 */
function forgetAttachTerminal(t: vscode.Terminal): void {
  for (const [key, term] of attachTerminals) {
    if (term !== t) continue;
    attachTerminals.delete(key);
    const code = t.exitStatus?.code;
    if (code !== undefined && code !== 0) autoAttachAttempted.delete(key);
    log(`tmux attach closed: ${key} exit=${code ?? '?'}`);
  }
}

/**
 * 매핑 pass 뒤 attach 터미널 정리·자동 생성. tmux 조회가 성공한 pass 에서만 (실패면 보류).
 * ① 세션이 사라진 attach 터미널은 dispose — 클라이언트가 스스로 끝나지 않는 설정
 *    (detach-on-destroy off 로 다른 세션으로 옮겨감)에서도 탭을 닫는다. 억제 기록도 정리.
 * ② 설정이 켜져 있으면, 이 창에 붙은 터미널이 없다고 확정된 세션에 포커스 없이 탭을 연다
 *    (스케줄러가 새벽에 열어도 작업 중인 포커스를 훔치지 않는다).
 */
function reconcileAttachTerminals(
  r: ReconcileResult, tmux: TmuxInfo, termByPid: ReadonlyMap<number, vscode.Terminal>,
): void {
  // ⓪ 인수 — 창 reload·확장 호스트 재시작 뒤 살아남은 attach 탭은 이 인스턴스의 맵에 없다(creationOptions 도 기본 셸로 바뀜, 실측).
  //    터미널 프로세스가 곧 tmux 클라이언트인 탭을 다시 추적해 ① 이 걸리게 한다. 같은 세션에 이미 추적 탭이 있으면 두 번째는 두지 않는다
  //    (사용자가 연 것으로 보고 건드리지 않음). ensure 터미널(main.sh)은 제외.
  const ours = new Set<vscode.Terminal>([...attachTerminals.values(), ...ensureTerminals.values()]);
  const trackedPids = new Set<number>();
  for (const [pid, t] of termByPid) if (ours.has(t)) trackedPids.add(pid);
  for (const a of adoptableAttachTerminals(termByPid.keys(), tmux, trackedPids)) {
    const t = termByPid.get(a.pid);
    if (!t || attachTerminals.has(a.key)) continue;
    attachTerminals.set(a.key, t);
    autoAttachAttempted.add(a.key);
    log(`tmux attach adopted: ${a.session} (${a.key}, pid ${a.pid})`);
  }
  const live = new Set<string>();
  for (const p of tmux.panesByPid.values()) live.add(tmuxRefKey(p));
  for (const s of tmuxSessions(tmux)) live.add(`name:${s}`);
  for (const [key, term] of attachTerminals) {
    const exited = term.exitStatus !== undefined; // 프로세스는 끝났는데 탭이 남은 경우(VS Code 가 안 닫아 줬을 때)
    if (live.has(key) && !exited) continue;
    attachTerminals.delete(key);
    const code = term.exitStatus?.code;
    if (code !== undefined && code !== 0) autoAttachAttempted.delete(key); // attach 실패는 재시도 허용 (forgetAttachTerminal 과 동일)
    term.dispose();
    log(`tmux attach disposed (${exited ? `exited ${code ?? '?'}` : 'session gone'}): ${key}`);
  }
  for (const key of autoAttachAttempted) if (!live.has(key)) autoAttachAttempted.delete(key);
  if (!vscode.workspace.getConfiguration('aiSessions').get<boolean>('tmuxAutoAttach', false)) return;
  for (const ref of autoAttachTargets([...r.claims, ...r.orphanProcs], autoAttachAttempted)) {
    const key = tmuxRefKey(ref);
    if (!live.has(key)) continue; // 사라진 세션을 가리키는 stale 바인딩 — attach 실패→억제 해제→재시도 루프 방지
    if (ensureTerminals.has(ref.session)) continue; // ensure 가 띄운 터미널(main.sh)이 곧 붙는다 — 중복 탭 방지
    autoAttachAttempted.add(key);
    ensureAttachTerminal(ref, false);
  }
}

// ---- tmux ensure (설정 aiSessions.tmuxEnsure) ----
// "이 tmux 세션이 없으면 이 명령을 새 터미널에서 실행" — CJ 의 관제 세션 cji-main 을 main.sh 로 상시 보장하는 데 쓴다.
// Desktop 아래 스크립트는 launchd 가 못 읽으므로(TCC) VS Code 터미널에서 실행한다. 명령은 멱등이어야 한다.
const ensureTerminals = new Map<string, vscode.Terminal>();
const ensureState = new Map<string, EnsureState>();

function ensureEntries(): EnsureEntry[] {
  const raw = vscode.workspace.getConfiguration('aiSessions').get<unknown>('tmuxEnsure', []);
  if (!Array.isArray(raw)) return [];
  const home = os.homedir();
  const out: EnsureEntry[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const { session, command, offFile } = it as Record<string, unknown>;
    if (typeof session !== 'string' || typeof command !== 'string') continue;
    out.push({
      session, command: expandHome(command, home),
      offFile: typeof offFile === 'string' && offFile ? expandHome(offFile, home) : undefined,
    });
  }
  return out;
}

/** 매핑 pass 뒤(tmux 조회 성공 시에만) — 없는 세션은 명령 실행, 유예 넘긴 터미널은 정리 */
function reconcileEnsuredSessions(tmux: TmuxInfo): void {
  const entries = ensureEntries();
  if (entries.length === 0) return;
  const live = tmuxSessions(tmux);
  const now = Date.now();
  const { run, stale } = ensureDue(entries, live, ensureState, now, (p) => fs.existsSync(p));
  for (const session of stale) {
    const term = ensureTerminals.get(session);
    ensureTerminals.delete(session); // onDidCloseTerminal 이 상태를 덮어쓰지 않도록 먼저 맵에서 뺀다
    term?.dispose();
    ensureState.set(session, { terminalAlive: false, lastAttemptAt: now });
    log(`tmux ensure: ${session} 이 ${ENSURE_GRACE_MS / 1000}s 안에 나타나지 않음 — 터미널 정리, 쿨다운 뒤 재시도`);
  }
  for (const e of run) {
    const shell = process.env.SHELL || '/bin/zsh';
    // 로그인 셸 경유로 PATH 확보. 포커스는 훔치지 않는다. isTransient — reload 때 복원하지 않음(재실행 여지 차단)
    const term = vscode.window.createTerminal({
      name: e.session, shellPath: shell, shellArgs: ['-lc', e.command], isTransient: true,
    });
    ensureTerminals.set(e.session, term);
    ensureState.set(e.session, { terminalAlive: true, startedAt: now, lastAttemptAt: now });
    log(`tmux ensure: ${e.session} 없음 → ${shell} -lc ${e.command}`);
  }
}

function forgetEnsureTerminal(t: vscode.Terminal): void {
  for (const [session, term] of ensureTerminals) {
    if (term !== t) continue;
    ensureTerminals.delete(session);
    // 세션이 죽어 tmux 클라이언트가 끝난 정상 종료든 기동 실패든, 재시도 여부는 쿨다운(lastAttemptAt)이 결정
    ensureState.set(session, { terminalAlive: false, lastAttemptAt: ensureState.get(session)?.lastAttemptAt });
    log(`tmux ensure terminal closed: ${session} exit=${t.exitStatus?.code ?? '?'}`);
  }
}

// ---- 시작 레이아웃 (설정 aiSessions.startupLayout.*) — 창 로드·reload 마다 activate 에서 한 번 ----
async function applyStartupLayout(
  store: StateStore, mapper: ProcessMapper, initialTerminals: ReadonlySet<vscode.Terminal>,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('aiSessions');
  if (!cfg.get<boolean>('startupLayout.enabled', false)) return;
  for (const c of cfg.get<unknown[]>('startupLayout.commands', [])) {
    if (typeof c !== 'string' || !c) continue;
    try {
      await vscode.commands.executeCommand(c);
      log(`startup layout: ${c}`);
    } catch (e) {
      log(`startup layout: ${c} 실패 — ${String(e).slice(0, 120)}`);
    }
  }
  const name = cfg.get<string>('startupLayout.focusTerminal', '');
  if (name) await focusTerminalByName(name);
  if (cfg.get<boolean>('startupLayout.closeIdleTerminals', false)) {
    await closeIdleTerminals(store, mapper, initialTerminals);
  }
}

/** ensure(main.sh)·자동 attach 가 만든 터미널은 몇 초 뒤에 생길 수 있다 — 최대 30초 기다린다 */
async function focusTerminalByName(name: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const t = vscode.window.terminals.find((x) => x.name === name);
    if (t) {
      t.show();
      log(`startup layout: terminal "${name}" focus`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  log(`startup layout: terminal "${name}" 30s 안에 없음`);
}

/**
 * 앱 재시작으로 복원됐지만 빈 셸만 남은 터미널을 닫는다. 판정은 정리 직전의 새 ps 스냅샷으로
 * (세션 카드에 매핑된 터미널·확장이 만든 attach/ensure 터미널·셸이 아닌 것·자식이 있는 것은 제외).
 */
async function closeIdleTerminals(
  store: StateStore, mapper: ProcessMapper, candidates: ReadonlySet<vscode.Terminal>,
): Promise<void> {
  const ours = new Set<vscode.Terminal>([...attachTerminals.values(), ...ensureTerminals.values()]);
  const byPid = new Map<number, vscode.Terminal>();
  for (const t of vscode.window.terminals) {
    if (!candidates.has(t) || ours.has(t)) continue;
    const pid = await terminalPid(t);
    if (pid !== undefined) byPid.set(pid, t);
  }
  // pid 조회(각 1초까지 걸릴 수 있음)를 끝낸 뒤 스냅샷 — 그 사이 시작된 작업이 "자식 없음" 으로 오판되지 않도록
  const snap = await mapper.snapshot();
  if (!snap.ok) {
    log('startup layout: 빈 터미널 정리 건너뜀 — ps 실패');
    return;
  }
  const protect = store.usedShellPids();
  for (const pid of idleShellPids(byPid.keys(), snap.byPid, protect)) {
    const t = byPid.get(pid);
    if (!t) continue;
    log(`startup layout: 빈 터미널 닫음 "${t.name}" (shell pid ${pid})`);
    t.dispose();
  }
}

async function refreshMapping(store: StateStore, mapper: ProcessMapper, codexWatcher: AdapterWatcher): Promise<void> {
  // grace 판정 기준 시각은 pass 시작 시각 — 스냅샷 후 lsof가 오래 걸려도 그 사이 등록된
  // 세션이 "grace 만료"로 오판되지 않도록 (스냅샷에 없는 프로세스의 세션 보호)
  const passStartedAt = Date.now();
  const isCurrent = mappingGeneration.begin();
  const snap = await mapper.snapshot();
  if (!snap.ok) return; // ps 실패 — 생사 판정 근거 없음, 이번 pass 전체 skip

  const codexBindings = await mapper.codexBindings(snap.agents, snap.byPid);

  const shellPids = new Map<number, string | undefined>();
  const termByPid = new Map<number, vscode.Terminal>();
  let pidUncertain = false; // processId 조회 실패(1초 타임아웃)가 하나라도 있으면 "터미널 없음" 을 근거로 한 삭제를 보류
  for (const term of vscode.window.terminals) {
    if (term.exitStatus !== undefined) continue; // 프로세스가 끝난 탭 — 터미널로 치지 않는다(빈 터미널 행·번호에서 제외, attach 정리가 닫는다)
    const pid = await terminalPid(term);
    if (pid) {
      shellPids.set(pid, term.name);
      termByPid.set(pid, term);
    } else {
      pidUncertain = true;
    }
  }
  // tmux 안 프로세스의 터미널 매핑용 — 실패(undefined)면 tmux 경유 매핑은 이번 pass 에 건드리지 않음
  const tmux = await mapper.tmuxInfo();
  // 휴리스틱 매칭에 쓸 프로세스 cwd 사전 조회 (agent 프로세스는 통상 수 개)
  const cwdByPid = new Map<number, string | undefined>();
  for (const proc of snap.agents) cwdByPid.set(proc.pid, await mapper.cwdOf(proc.pid));

  const nativeBindings = await readNativeBindings();
  // No state mutation from an obsolete snapshot: claims and placeholders are
  // just as destructive as terminal disposal when a closed session reappears.
  if (!isCurrent()) return;
  // Resumed sessions may live outside today's/yesterday's directories.
  codexWatcher.trackFiles([...codexBindings.values()].flatMap((b) => b ? [b.filePath] : []));
  const r = reconcileSessions({
    agents: snap.agents, byPid: snap.byPid, shellPids,
    sessions: store.all(), cwdByPid, nativeBindings, codexBindings, tmux,
    placeholderShellPids: store.placeholderShellPids(),
    now: passStartedAt,
  });
  // claim과 parentKey를 한 번의 setProcess로 — 분리 적용하면 자식이 parentKey 설정 전
  // 렌더 한 프레임 동안 최상위 카드로 노출됨
  const parentByKey = new Map(r.parentLinks.map((l) => [l.key, l.parentKey]));
  for (const c of r.claims) {
    store.setProcess(c.key, {
      pid: c.pid, alive: true, mapping: c.mapping,
      terminalName: c.terminalName, shellPid: c.shellPid,
      // tmux 조회가 실패한 pass 에서는 tmux 표시도 보존 (undefined = 유지, null = 해제)
      tmux: c.tmux ?? (tmux ? null : undefined),
      parentKey: parentByKey.get(c.key) ?? null,
      busy: c.busy,
      nativeStatus: c.nativeStatus ?? null, // 파일 없으면 해제 (stale 상태 잔류 방지)
      name: c.name ?? null, nameSource: c.nameSource ?? null,
    });
  }
  // 어느 프로세스도 클레임하지 않은 세션 = 프로세스 소멸 — 즉시 exited
  // (카드 수 = 살아있는 agent 프로세스 수 불변식. 유령 카드의 근본 수정)
  for (const key of r.exited) store.setProcess(key, { alive: false });
  // 컨테이너(tmux 세션·터미널)까지 사라진 exited 세션은 즉시 제거 — "✕ Exited" 카드가 5분 남아 번호를 쥐는 고스트 방지.
  // 이전 pass 에 exited 된 것도 매번 재확인한다(셸·tmux 가 나중에 닫히는 경우). pid 조회가 불확실한 pass 는 tmux 기준만 본다.
  // 60초 넘게 멈췄다 재개된 옛 pass 는 스냅샷이 옛것이라 지우지 않는다(터미널 부작용과 같은 가드)
  const livePids = pidUncertain ? undefined : new Set(shellPids.keys());
  for (const s of store.all()) {
    if (s.processAlive !== false || !containerGone(s, tmux, livePids)) continue;
    store.remove(s.key);
    log(`session removed (container gone): ${s.key}`);
  }
  // 세션 파일이 아직 없는 프로세스(첫 쿼리 전 codex 등)는 플레이스홀더 카드로 표시
  store.syncPlaceholders(
    r.orphanProcs.map((o) => ({ ...o, tmux: o.tmux ?? (tmux ? null : undefined) })), passStartedAt,
  );
  // 60초 넘게 멈춘 pass 가 새 pass 뒤에 재개되면 이 스냅샷은 옛것 — 터미널을 만들거나 지우는 부작용은 건너뛴다
  // (옛 빈 스냅샷으로 방금 뜬 세션의 ensure 터미널을 stale 로 오판·dispose 하는 것 방지)
  if (tmux) {
    reconcileEnsuredSessions(tmux);   // 먼저 — 방금 띄운 main.sh 터미널이 있으면 자동 attach 가 그 세션을 건너뛴다
    reconcileAttachTerminals(r, tmux, termByPid);
  }
  // 세션이 붙지 않은 일반 터미널도 목록에 — "+ New Terminal" 직후 바로 보이도록
  const used = store.usedShellPids();
  const plain: Array<{ name?: string; shellPid: number }> = [];
  for (const [pid, name] of shellPids) {
    if (!used.has(pid)) plain.push({ name, shellPid: pid });
  }
  sidebar?.setTerminals(plain);
}

/** refreshMapping이 provider에 접근할 수 있도록 activate에서 주입 */
let sidebar: SidebarProvider | undefined;
/** attach 직후 매핑을 앞당기기 위한 remap 트리거 — activate에서 주입 */
let requestRemap: (() => void) | undefined;
/** 가장 최근에 시작한 매핑 pass 의 시각 — 지연 재개된 옛 pass 의 부작용 차단용 */
const mappingGeneration = new SnapshotGeneration();

async function focusTerminalByShellPid(shellPid: number): Promise<void> {
  (await findTerminal(shellPid))?.show();
}

export function deactivate(): void {}
