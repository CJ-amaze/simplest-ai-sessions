import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdapterWatcher, codexSpec } from '../src/adapters/watcher';
import { parseCodexBindings, reconcileSessions } from '../src/mapper';
import type { ReconcileInput } from '../src/mapper';
import { StateStore } from '../src/store';
import { TailReader } from '../src/tail';

const SID = 'aaaabbbb-1111-4222-8333-cccccccc0001';
const OTHER = 'aaaabbbb-1111-4222-8333-cccccccc0002';
const T = Date.now();
const line = (type: string, payload: object, at = T) =>
  JSON.stringify({ type, payload, timestamp: new Date(at).toISOString() }) + '\n';
const fileFor = (sid: string) => `/sessions/2026/08/01/rollout-2026-08-01T12-00-00-${sid}.jsonl`;

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
      line('session_meta', { cwd: '/project' }) +
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
    expect(store.list(T + 60_000)[0]).toMatchObject({ model: 'gpt-6-astra', effort: 'xhigh', status: 'running' });
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
