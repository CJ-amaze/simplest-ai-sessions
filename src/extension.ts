import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AdapterWatcher, claudeSpec, codexSpec } from './adapters/watcher';
import { EVENTS_FILE, parseHookEventLine } from './hooks/events';
import { installHooks, removeHooks, writeShim } from './hooks/installer';
import { ProcessMapper, reconcileSessions } from './mapper';
import { SidebarProvider } from './sidebar';
import { StateStore } from './store';
import { TailReader } from './tail';
import type { HookEvent } from './types';

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

  const store = new StateStore();
  const tail = new TailReader();
  const eventsTail = new TailReader();
  const mapper = new ProcessMapper();
  const watchers = [
    new AdapterWatcher(claudeSpec(), tail, (p) => store.applyPatch(p)),
    new AdapterWatcher(codexSpec(), tail, (p) => store.applyPatch(p)),
  ];

  const provider = new SidebarProvider(
    store,
    (key) => void focusTerminal(store, key),
    () => vscode.window.createTerminal().show(), // ＋ 새 터미널 — 세션 시작용
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, provider),
  );
  const offChange = store.onChange(() => provider.refresh());
  context.subscriptions.push({ dispose: offChange });

  // 활성 터미널 추적 — 해당 세션 카드 강조
  const updateActiveTerminal = async (term: vscode.Terminal | undefined): Promise<void> => {
    const pid = term
      ? await Promise.race<number | undefined>([
          term.processId,
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1_000)),
        ])
      : undefined;
    provider.setActiveShellPid(pid ?? undefined);
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal((t) => void updateActiveTerminal(t)),
  );
  void updateActiveTerminal(vscode.window.activeTerminal);

  // single-flight 헬퍼 — interval보다 오래 걸려도 중첩 금지. 단 60초 넘게 안 끝나는 flight는
  // 멈춘 것으로 간주하고 새 flight를 허용 (fs/터미널 API가 영구 pending 되어도 자기치유)
  const passAges: Record<string, number> = {}; // 하트비트용 — 마지막 "완료" 시각
  function singleFlight(name: string, fn: () => Promise<void>, staleMs = 60_000): () => void {
    let startedAt: number | undefined;
    let flightId = 0;
    return () => {
      const now = Date.now();
      if (startedAt !== undefined) {
        if (now - startedAt < staleMs) return;
        log(`${name}: flight ${Math.round((now - startedAt) / 1000)}s째 미완료 — 멈춤 판단, 재시작`);
      }
      startedAt = now;
      const id = ++flightId;
      void fn()
        .catch((e) => log(`${name}: 오류 — ${String(e).slice(0, 200)}`))
        .finally(() => {
          if (id === flightId) {
            startedAt = undefined;
            passAges[name] = Date.now();
          }
        });
    };
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
  const scan = singleFlight('scan', doScan);
  const scanTimer = setInterval(scan, SCAN_MS);
  context.subscriptions.push({ dispose: () => clearInterval(scanTimer) });

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
  };
  const drainEvents = singleFlight('events', doDrain);
  const eventsTimer = setInterval(drainEvents, EVENTS_MS);
  context.subscriptions.push({ dispose: () => clearInterval(eventsTimer) });

  // 프로세스 ↔ 터미널 매핑 (5s)
  const doRemap = (): Promise<void> => refreshMapping(store, mapper);
  const remap = singleFlight('map', doRemap);
  const mapTimer = setInterval(remap, MAP_MS);
  context.subscriptions.push({ dispose: () => clearInterval(mapTimer) });

  // priming — 재시작 직후 첫 매핑이 세션 등록·이벤트 재생(hookPid 복원)보다 먼저 돌면
  // 엉터리 cwd 추측으로 바인딩되고 pid로 고착된다. 순서를 강제: 등록 → 이벤트 → 매핑
  void (async () => {
    await doScan().catch(() => {});
    await doDrain().catch((e) => log(`priming drain: ${String(e).slice(0, 120)}`));
    await doRemap().catch((e) => log(`priming map: ${String(e).slice(0, 120)}`));
    log('priming 완료 (등록→이벤트→매핑)');
  })();

  // 상태 tick (5s) — store 변경이 없어도 시간 경과(running→idle, 외부 exited)로
  // 상태가 바뀌므로 미매핑 카드 포함 주기적 재렌더
  const tickTimer = setInterval(() => provider.refresh(), 5_000);
  context.subscriptions.push({ dispose: () => clearInterval(tickTimer) });

  // hook shim — 설정 파일에는 고정 경로만 기록 (확장 업그레이드로 번들 경로가 바뀌어도 불변)
  const bundled = context.asAbsolutePath(path.join('dist', 'resources', 'agent-monitor-hook.sh'));
  let scriptPath = '';
  try {
    scriptPath = await writeShim(os.homedir(), fs.readFileSync(bundled, 'utf8'));
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
        'AI Sessions: to detect approval-waiting accurately, Claude Code hooks / codex notify need to be configured. Install now? (existing settings preserved, backup created)',
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
    const r = await installHooks(os.homedir(), script);
    await refreshTurnTracking(store, script);
    void vscode.window.showInformationMessage(`AI Sessions hooks — claude: ${r.claude}, codex: ${r.codex}`);
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

/** 카드 클릭 → 터미널 포커스. 터미널 이름은 중복 가능하므로 shellPid로 식별 */
/**
 * Claude Code가 직접 기록하는 세션 상태 파일 (~/.claude/sessions/<pid>.json, v2.1.206+)
 * — pid ↔ sessionId 정확 바인딩. 존재하면 매핑 추측이 전혀 필요 없다.
 */
async function readNativeBindings(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
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
        pid?: number; sessionId?: string;
      };
      if (typeof d.pid === 'number' && typeof d.sessionId === 'string') map.set(d.pid, d.sessionId);
    } catch {
      // 손상/쓰는 중 — 무시
    }
  }
  return map;
}

async function focusTerminal(store: StateStore, key: string): Promise<void> {
  // find(): 플레이스홀더(첫 쿼리 전 codex 등) 카드도 포커스 가능해야 함 — all()은 이를 제외한다
  const s = store.find(key);
  if (!s?.shellPid) return;
  for (const term of vscode.window.terminals) {
    if ((await term.processId) === s.shellPid) {
      term.show();
      return;
    }
  }
}

async function refreshMapping(store: StateStore, mapper: ProcessMapper): Promise<void> {
  // grace 판정 기준 시각은 pass 시작 시각 — 스냅샷 후 lsof가 오래 걸려도 그 사이 등록된
  // 세션이 "grace 만료"로 오판되지 않도록 (스냅샷에 없는 프로세스의 세션 보호)
  const passStartedAt = Date.now();
  const snap = await mapper.snapshot();
  if (!snap.ok) return; // ps 실패 — 생사 판정 근거 없음, 이번 pass 전체 skip

  const shellPids = new Map<number, string | undefined>();
  for (const term of vscode.window.terminals) {
    // 죽은/이상 상태 터미널의 processId는 영구 pending일 수 있음 — 1초 상한
    const pid = await Promise.race<number | undefined>([
      term.processId,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1_000)),
    ]);
    if (pid) shellPids.set(pid, term.name);
  }
  // 휴리스틱 매칭에 쓸 프로세스 cwd 사전 조회 (agent 프로세스는 통상 수 개)
  const cwdByPid = new Map<number, string | undefined>();
  for (const proc of snap.agents) cwdByPid.set(proc.pid, await mapper.cwdOf(proc.pid));

  const r = reconcileSessions({
    agents: snap.agents, byPid: snap.byPid, shellPids,
    sessions: store.all(), cwdByPid,
    nativeBindings: await readNativeBindings(),
    now: passStartedAt,
  });
  // claim과 parentKey를 한 번의 setProcess로 — 분리 적용하면 자식이 parentKey 설정 전
  // 렌더 한 프레임 동안 최상위 카드로 노출됨
  const parentByKey = new Map(r.parentLinks.map((l) => [l.key, l.parentKey]));
  for (const c of r.claims) {
    store.setProcess(c.key, {
      pid: c.pid, alive: true, mapping: c.mapping,
      terminalName: c.terminalName, shellPid: c.shellPid,
      parentKey: parentByKey.get(c.key) ?? null,
      busy: c.busy,
    });
  }
  // 어느 프로세스도 클레임하지 않은 세션 = 프로세스 소멸 — 즉시 exited
  // (카드 수 = 살아있는 agent 프로세스 수 불변식. 유령 카드의 근본 수정)
  for (const key of r.exited) store.setProcess(key, { alive: false });
  // 세션 파일이 아직 없는 프로세스(첫 쿼리 전 codex 등)는 플레이스홀더 카드로 표시
  store.syncPlaceholders(r.orphanProcs, passStartedAt);
}

export function deactivate(): void {}
