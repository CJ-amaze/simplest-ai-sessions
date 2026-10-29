import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdapterWatcher, codexSpec } from '../src/adapters/watcher';
import { bindCodexClients, detectAgent, isCodexServer, parseCodexBindings, parseCodexOpenFiles, parsePsOutput, reconcileSessions } from '../src/mapper';
import type { ReconcileInput } from '../src/mapper';
import { StateStore } from '../src/store';
import { TailReader } from '../src/tail';

const SID = 'aaaabbbb-1111-4222-8333-cccccccc0001';
const OTHER = 'aaaabbbb-1111-4222-8333-cccccccc0002';
const T = Date.now();
const line = (type: string, payload: object, at = T) =>
  JSON.stringify({ type, payload, timestamp: new Date(at).toISOString() }) + '\n';
const fileFor = (sid: string) => `/sessions/2026/08/01/rollout-2026-08-01T12-00-00-${sid}.jsonl`;

describe('Codex shared daemon clients', () => {
  const client = (pid: number, startedAt = T) => ({ pid, ppid: 1, pcpu: 0, command: 'codex --yolo', startedAt });
  const session = (sessionId: string, createdAt = T + 500) => ({
    sessionId, filePath: fileFor(sessionId), createdAt, originator: 'codex-tui',
  });

  it('reads all daemon rollouts without treating an empty client as a session owner', () => {
    const files = parseCodexOpenFiles(`p6342\nn${fileFor(SID)}\nn${fileFor(OTHER)}\np11235\nn/dev/ttys004\n`);
    expect(files.get(6342)).toHaveLength(2);
    expect(files.get(11235)).toEqual([]);
    expect(isCodexServer('codex app-server --listen unix:// --managed-daemon')).toBe(true);
    expect(isCodexServer('codex app-server daemon pid-update-loop')).toBe(false);
  });

  it('reads process launch time without including it in the executable name', () => {
    const ps = parsePsOutput('11235 11234 1.2 Thu Oct 29 17:56:29 2026 /bin/codex --yolo');
    expect(ps[0]).toMatchObject({ command: '/bin/codex --yolo', startedAt: new Date('2026-10-29T17:56:29').getTime() });
  });

  it('keeps two clients in the same cwd separate when one daemon owns both rollouts', () => {
    const result = bindCodexClients([client(20), client(30, T + 60_000)], [session(OTHER, T + 72_000), session(SID)]);
    expect(result.get(20)?.sessionId).toBe(SID);
    expect(result.get(30)?.sessionId).toBe(OTHER);
    // Closing one client must not transfer its live daemon rollout to the other.
    const closed = bindCodexClients([client(30, T + 60_000)], [session(SID), session(OTHER, T + 72_000)]);
    expect([...closed.keys()]).toEqual([30]);
    expect(closed.get(30)?.sessionId).toBe(OTHER);
  });

  it('does not guess between overlapping launches or multiple candidate threads', () => {
    expect(bindCodexClients([client(20), client(30)], [session(SID)]).size).toBe(0);
    expect(bindCodexClients([client(20)], [session(SID), session(OTHER)]).size).toBe(0);
    expect(bindCodexClients([client(20)], [{ ...session(SID), originator: 'codex_exec' }]).size).toBe(0);
  });

  it('supports an explicit resume ID but never mistakes an exec prompt for resume', () => {
    const old = session(SID, T - 100_000);
    expect(bindCodexClients([{ ...client(20), command: `codex resume ${SID}` }], [old]).get(20)?.sessionId).toBe(SID);
    expect(bindCodexClients([{ ...client(20), command: `codex exec explain resume ${SID}` }], [old]).size).toBe(0);
    expect(bindCodexClients([{ ...client(20), command: `codex fork ${SID}` }], [old]).size).toBe(0);
  });

  it('prevents an inspected empty client from stealing old history by cwd or cached PID', () => {
    const i = input();
    i.codexBindings = new Map([[20, null]]);
    const r = reconcileSessions(i);
    expect(r.claims).toEqual([]);
    expect(r.orphanProcs).toMatchObject([{ pid: 20 }]);
  });
});

function input(): ReconcileInput {
  const procs = [
    { pid: 10, ppid: 1, pcpu: 0, command: 'zsh' },
    { pid: 20, ppid: 10, pcpu: 0, command: 'node /bin/codex --yolo' },
    { pid: 21, ppid: 20, pcpu: 0, command: '/vendor/bin/codex --yolo' },
  ];
  return {
    agents: procs.slice(1), byPid: new Map(procs.map((p) => [p.pid, p])),
    shellPids: new Map([[10, 'Codex']]), cwdByPid: new Map([[20, '/project']]), now: T,
    sessions: [
      { key: `codex:${OTHER}`, agent: 'codex', pid: 20, cwd: '/project', lastActivityAt: T - 1_000 },
      { key: `codex:${SID}`, agent: 'codex', hookPid: 21, cwd: '/project', lastActivityAt: T },
    ],
    codexBindings: new Map([[21, { sessionId: SID, filePath: fileFor(SID) }]]),
  };
}

describe('Codex process ownership', () => {
  it('ignores the shared daemon and its pid-update loop even when they hold a rollout', () => {
    const i = input();
    i.agents = [
      { pid: 6342, ppid: 1, pcpu: 0, command: '/bin/codex app-server --managed-daemon' },
      { pid: 6357, ppid: 1, pcpu: 0, command: '/bin/codex app-server daemon pid-update-loop' },
    ];
    i.byPid = new Map(i.agents.map((p) => [p.pid, p]));
    i.codexBindings = new Map([[6342, { sessionId: SID, filePath: fileFor(SID) }]]);
    i.cwdByPid = new Map([[6342, '/project'], [6357, '/project']]);
    const result = reconcileSessions(i);
    expect(result.claims).toEqual([]);
    expect(result.orphanProcs).toEqual([]);
  });

  it('removes a first-query placeholder after its CLI closes while the daemon stays alive', () => {
    const store = new StateStore();
    const i = input();
    i.sessions = [];
    i.codexBindings = undefined;
    const daemon = { pid: 6342, ppid: 1, pcpu: 0, command: 'codex app-server --managed-daemon' };
    i.byPid.set(daemon.pid, daemon);
    i.agents.push(daemon);
    store.syncPlaceholders(reconcileSessions(i).orphanProcs, T);
    expect(store.list(T)).toMatchObject([{ sessionId: 'pending-20', shellPid: 10 }]);
    i.byPid.delete(20);
    i.byPid.delete(21);
    i.agents = [...i.byPid.values()].filter((p) => detectAgent(p.command) !== null);
    store.syncPlaceholders(reconcileSessions(i).orphanProcs, T + 5_000);
    expect(store.list(T + 5_000)).toEqual([]);
  });

  it('does not guess an app/IDE transcript belongs to a fresh terminal in the same cwd', () => {
    const i = input();
    i.codexBindings = undefined;
    i.sessions = [{ key: `codex:${SID}`, agent: 'codex', sessionSource: 'vscode',
      cwd: '/project', lastActivityAt: T }];
    expect(reconcileSessions(i).claims).toEqual([]);
    expect(reconcileSessions(i).orphanProcs).toMatchObject([{ pid: 20 }]);
    // A verified rollout still wins regardless of source metadata.
    i.codexBindings = new Map([[21, { sessionId: SID, filePath: fileFor(SID) }]]);
    expect(reconcileSessions(i).claims).toMatchObject([{ key: `codex:${SID}`, mapping: 'exact' }]);
  });
  it('replaces a stale Sol session on the npm wrapper with its binary’s actual rollout', () => {
    const result = reconcileSessions(input());
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({ key: `codex:${SID}`, pid: 20, shellPid: 10, mapping: 'exact' });
    expect(result.exited).toContain(`codex:${OTHER}`);
  });

  it('reserves a process for an undiscovered /new or resumed rollout', () => {
    const i = input();
    i.sessions = i.sessions.slice(0, 1);
    expect(reconcileSessions(i).claims).toEqual([]);
    expect(reconcileSessions(i).orphanProcs).toMatchObject([{ pid: 20, shellPid: 10 }]);
  });

  it('normalizes binary hook PIDs when lsof is unavailable', () => {
    const i = input();
    i.codexBindings = undefined;
    expect(reconcileSessions(i).claims[0].key).toBe(`codex:${SID}`);
  });

  it('keeps two Codex terminals in the same cwd attached to their own rollouts', () => {
    const i = input();
    const proc = { pid: 30, ppid: 11, pcpu: 0, command: 'codex' };
    i.agents.push(proc);
    i.byPid.set(30, proc);
    i.shellPids.set(11, 'Second Codex');
    i.cwdByPid.set(30, '/project');
    i.codexBindings!.set(30, { sessionId: OTHER, filePath: fileFor(OTHER) });
    expect(reconcileSessions(i).claims).toMatchObject([
      { key: `codex:${SID}`, pid: 20, shellPid: 10 },
      { key: `codex:${OTHER}`, pid: 30, shellPid: 11 },
    ]);
  });

  it('parses lsof process boundaries and rejects ambiguous owners', () => {
    const parsed = parseCodexBindings(`p21\nn${fileFor(SID)}\nn${fileFor(SID)}\np30\nn${fileFor(OTHER)}\nn/tmp/settings.json\n`);
    expect([...parsed.keys()]).toEqual([21, 30]);
    expect(parsed.get(21)?.sessionId).toBe(SID);
    expect(parseCodexBindings(`p21\nn${fileFor(SID)}\nn${fileFor(OTHER)}\n`).size).toBe(0);
  });
});

describe('Codex live status after extension reload', () => {
  it('shows a daemon-backed turn as Working on the client, then removes it when the client exits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-daemon-'));
    const file = join(root, `rollout-2026-08-01T12-00-00-${SID}.jsonl`);
    writeFileSync(file,
      line('session_meta', { cwd: '/project', source: 'vscode', originator: 'codex-tui' }) +
      line('event_msg', { type: 'task_started' }) +
      line('turn_context', { model: 'gpt-6-astra' }) +
      line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Fix session monitor' }] } }) +
      line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'Text', text: 'Investigating' }] } }));
    const store = new StateStore();
    const watcher = new AdapterWatcher(codexSpec(root), new TailReader(), p => store.applyPatch(p));
    watcher.trackFiles([file]);
    await watcher.scan(T);
    const i = input();
    i.sessions = store.all();
    i.codexBindings = bindCodexClients([{ ...i.agents[0], startedAt: T - 500 }],
      [{ sessionId: SID, filePath: file, createdAt: T, originator: 'codex-tui' }]);
    for (const c of reconcileSessions(i).claims) store.setProcess(c.key, { pid: c.pid, alive: true, shellPid: c.shellPid, mapping: c.mapping });
    expect(store.list(T + 60_000)).toMatchObject([{ pid: 20, shellPid: 10, status: 'running', topic: 'Fix session monitor', lastReply: '' }]);
    store.setProcess(`codex:${SID}`, { alive: false });
    expect(store.list(T + 60_001)).toEqual([]); // shell/daemon still alive
    // Resume the same, unchanged rollout after removing its old card.
    watcher.trackFiles([file]);
    await watcher.scan(T + 65_000);
    expect(store.find(`codex:${SID}`)?.model).toBe('gpt-6-astra');
    store.setProcess(`codex:${SID}`, { pid: 30, alive: true, shellPid: 11 });
    appendFileSync(file,
      line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: 'Fixed' }] } }, T + 70_000) +
      line('event_msg', { type: 'task_complete' }, T + 70_000));
    await watcher.scan(T + 70_000);
    expect(store.list(T + 70_000)).toMatchObject([{ pid: 30, shellPid: 11, status: 'idle', lastReply: 'Fixed' }]);
  });
  it('clears the old accumulator before streaming a truncated rollout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-reset-'));
    const file = join(root, `rollout-2026-08-01T12-00-00-${SID}.jsonl`);
    writeFileSync(file,
      line('turn_context', { model: 'gpt-6-astra', effort: 'xhigh' }) +
      line('event_msg', { type: 'task_started' }) +
      line('response_item', { content: 'x'.repeat(1000) }));
    const fields: object[] = [];
    const watcher = new AdapterWatcher(codexSpec(root), new TailReader(), (p) => fields.push(p.fields));
    watcher.trackFiles([file]);
    await watcher.scan(T);
    writeFileSync(file, line('turn_context', { model: 'gpt-5.6-sol' }));
    await watcher.scan(T + 1);
    expect(fields[1]).toMatchObject({ model: 'gpt-5.6-sol', effort: undefined, turnStartedAt: undefined });
  });

  it('restores model/open turn beyond 256 KiB, then follows approval, work and completion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-monitor-'));
    // Explicit discovery must include a resumed file outside the date scan window.
    const file = join(root, `rollout-2026-08-01T12-00-00-${SID}.jsonl`);
    writeFileSync(file,
      line('session_meta', { cwd: '/project', source: 'cli' }) +
      line('event_msg', { type: 'task_started' }) +
      line('turn_context', { model: 'gpt-6-astra', effort: 'xhigh', cwd: '/project' }) +
      line('response_item', { type: 'message', content: 'x'.repeat(300_000) }) +
      line('event_msg', { type: 'token_count' }));
    const store = new StateStore();
    const watcher = new AdapterWatcher(codexSpec(root), new TailReader(), (p) => store.applyPatch(p));
    watcher.trackFiles([file]);
    await watcher.scan(T);
    const key = `codex:${SID}`;
    store.setProcess(key, { pid: 20, alive: true, mapping: 'exact' });
    expect(store.list(T + 60_000)[0]).toMatchObject({ model: 'gpt-6-astra', effort: 'xhigh', status: 'running', sessionSource: 'cli' });
    store.applyHookEvent({ agent: 'codex', sessionId: SID, kind: 'approval', observedAt: T + 60_001 });
    expect(store.list(T + 60_002)[0].status).toBe('approval');
    appendFileSync(file, line('event_msg', { type: 'agent_message' }, T + 70_000));
    await watcher.scan(T + 70_000);
    expect(store.list(T + 70_000)[0].status).toBe('running');
    appendFileSync(file, line('event_msg', { type: 'task_complete' }, T + 80_000));
    await watcher.scan(T + 80_000);
    expect(store.list(T + 80_000)[0].status).toBe('idle');
    appendFileSync(file,
      line('event_msg', { type: 'task_started' }, T + 90_000) +
      line('turn_context', { model: 'gpt-5.6-sol' }, T + 90_000));
    await watcher.scan(T + 90_000);
    expect(store.list(T + 90_000)[0]).toMatchObject({ model: 'gpt-5.6-sol', status: 'running' });
  });
});
