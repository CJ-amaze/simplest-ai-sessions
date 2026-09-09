import { describe, expect, it } from 'vitest';
import {
  adoptableAttachTerminals, ancestorChain, containerGone, detectAgent, PAIRING_FRESH_MS, parseForkParentSessionId, parsePsOutput,
  autoAttachTargets, ENSURE_COOLDOWN_MS, ENSURE_GRACE_MS, ensureDue, expandHome, idleShellPids, parseTmuxClients,
  parseTmuxPanes, parseTmuxSessionNames, parseTmuxTarget, REGISTER_GRACE_MS, reconcileSessions, tmuxRefKey,
  tmuxSessions,
} from '../src/mapper';
import type { ReconcileInput } from '../src/mapper';

const PS = `
    1     0  0.0 /sbin/launchd
  500     1  1.2 /Applications/Visual Studio Code.app/Contents/MacOS/Electron
  600   500  0.0 /bin/zsh -il
  700   600  8.5 claude
  800   600  0.0 node /Users/dev/.nvm/versions/node/v22.0.0/bin/codex
  900   700  0.0 bash -c "hook.sh claude notification"
`;

describe('parsePsOutput', () => {
  it('pid/ppid/command 파싱', () => {
    const procs = parsePsOutput(PS);
    expect(procs).toHaveLength(6);
    expect(procs[3]).toEqual({ pid: 700, ppid: 600, pcpu: 8.5, command: 'claude' });
  });
});

describe('detectAgent', () => {
  it('직접 실행 바이너리', () => {
    expect(detectAgent('claude')).toBe('claude');
    expect(detectAgent('codex --model gpt-5.6')).toBe('codex');
  });
  it('node 래퍼 (두 번째 토큰 basename)', () => {
    expect(detectAgent('node /Users/dev/.nvm/versions/node/v22.0.0/bin/codex')).toBe('codex');
  });
  it('무관한 프로세스는 null — 파일 경로 안 "claude" 문자열에 안 속함', () => {
    expect(detectAgent('/bin/zsh -il')).toBeNull();
    expect(detectAgent('vi /tmp/claude-notes.md')).toBeNull();
    expect(detectAgent('node /Users/dev/.claude/foo.js')).toBeNull();
  });
  it('claude 데몬 인프라(daemon/bg-pty-host/bg-spare)는 세션 아님 — null (2.1.20x 실측 형태)', () => {
    expect(detectAgent('/Users/cj/.local/bin/claude daemon run --json-path /Users/cj/.claude/daemon.json')).toBeNull();
    expect(detectAgent('/Users/cj/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude --bg-pty-host /tmp/cc-daemon-501/d/pty/x.sock 227 136 -- /Users/cj/.local/share/claude/versions/2.1.207 --session-id x')).toBeNull();
    expect(detectAgent('claude bg-pty-host --bg-pty-host /tmp/spare.pty.sock 200 50 -- claude --bg-spare')).toBeNull();
    expect(detectAgent('claude bg-spare --bg-spare /tmp/spare.claim.sock')).toBeNull();
  });
  it('일반 플래그가 붙은 claude는 여전히 검출 (인프라 제외의 회귀 방지)', () => {
    expect(detectAgent('claude --dangerously-skip-permissions')).toBe('claude');
    expect(detectAgent('claude -p 하위작업 --allowed-tools Bash')).toBe('claude');
  });
});

describe('parseForkParentSessionId', () => {
  const PARENT = 'a5db5c28-c147-44dc-92bf-b08a9d1a2040';
  const BG = `/Users/cj/.local/share/claude/versions/2.1.207 --session-id 8995252a-14c4-4568-bc20-37fed1e8625a --fork-session --resume /Users/cj/.claude/projects/-Users-cj-Desktop-CJI/${PARENT}.jsonl --allowed-tools mcp__x__y --permission-mode bypassPermissions`;

  it('bg 서브에이전트 실측 커맨드라인에서 부모 sessionId 추출', () => {
    expect(parseForkParentSessionId(BG)).toBe(PARENT);
  });
  it('--fork-session 없는 일반 resume은 부모 아님 (사용자가 이어가는 같은 세션)', () => {
    expect(parseForkParentSessionId(`claude --resume /p/${PARENT}.jsonl`)).toBeNull();
  });
  it('--resume 없으면 null', () => {
    expect(parseForkParentSessionId('claude --fork-session')).toBeNull();
  });
  it('공백 포함 경로 — ps 출력엔 따옴표가 없어도 <uuid>.jsonl로 추출', () => {
    expect(parseForkParentSessionId(
      `claude --fork-session --resume /Users/cj/My Projects/-x/${PARENT}.jsonl --verbose`,
    )).toBe(PARENT);
  });
});

describe('ancestorChain', () => {
  it('조상 pid 체인', () => {
    const byPid = new Map(parsePsOutput(PS).map((p) => [p.pid, p]));
    expect(ancestorChain(700, byPid)).toEqual([600, 500, 1]);
  });
  it('사이클/누락 방어', () => {
    const byPid = new Map([[10, { pid: 10, ppid: 10, pcpu: 0, command: 'x' }]]);
    expect(ancestorChain(10, byPid)).toEqual([]);
  });
});

// ── reconcileSessions ──────────────────────────────────────────────

const T = 1_000_000_000_000;

function makeInput(over: Partial<ReconcileInput>): ReconcileInput {
  return {
    agents: [], byPid: new Map(), shellPids: new Map(),
    sessions: [], cwdByPid: new Map(), now: T,
    ...over,
  };
}

function sess(key: string, over: Record<string, unknown> = {}) {
  return {
    key, agent: key.split(':')[0] as 'claude' | 'codex',
    lastActivityAt: T, registeredAt: T - REGISTER_GRACE_MS - 1,
    ...over,
  } as ReconcileInput['sessions'][number];
}

describe('reconcileSessions', () => {
  const claudeProc = { pid: 700, ppid: 600, pcpu: 0, command: 'claude' };

  it('pid exact 클레임 → mapping exact', () => {
    const r = reconcileSessions(makeInput({
      agents: [claudeProc], byPid: new Map([[700, claudeProc]]),
      sessions: [sess('claude:a', { pid: 700 })],
    }));
    expect(r.claims).toEqual([{
      key: 'claude:a', pid: 700, mapping: 'exact',
      terminalName: undefined, shellPid: undefined, busy: false,
    }]);
    expect(r.exited).toEqual([]);
  });

  it('busy: 프로세스 자신 또는 자손의 CPU가 임계값 이상이면 true, 유휴 MCP 서버(0%)는 무시', () => {
    const hot = { pid: 700, ppid: 600, pcpu: 8.5, command: 'claude' }; // 생성 중 (실측 7~12%)
    const r1 = reconcileSessions(makeInput({
      agents: [hot], byPid: new Map([[700, hot]]),
      sessions: [sess('claude:a', { pid: 700 })],
    }));
    expect(r1.claims[0].busy).toBe(true);

    const idle = { pid: 700, ppid: 600, pcpu: 1.5, command: 'claude' }; // 유휴 (실측 0~2%)
    const mcp = { pid: 710, ppid: 700, pcpu: 0, command: 'npm exec some-mcp' };
    const r2 = reconcileSessions(makeInput({
      agents: [idle], byPid: new Map([[700, idle], [710, mcp]]),
      sessions: [sess('claude:a', { pid: 700 })],
    }));
    expect(r2.claims[0].busy).toBe(false);

    const tool = { pid: 720, ppid: 700, pcpu: 95, command: 'zsh -c long-build' }; // 긴 빌드
    const r3 = reconcileSessions(makeInput({
      agents: [idle], byPid: new Map([[700, idle], [720, tool]]),
      sessions: [sess('claude:a', { pid: 700 })],
    }));
    expect(r3.claims[0].busy).toBe(true);
  });

  it('hookPid로 exact 클레임 (훅 $PPID가 살아있는 agent 프로세스일 때)', () => {
    const r = reconcileSessions(makeInput({
      agents: [claudeProc], byPid: new Map([[700, claudeProc]]),
      sessions: [sess('claude:a', { hookPid: 700 })],
    }));
    expect(r.claims[0]).toMatchObject({ key: 'claude:a', mapping: 'exact' });
  });

  it('pass 0: Claude Code 자체 선언 바인딩(~/.claude/sessions)이 모든 신호를 이김', () => {
    const procA = { pid: 700, ppid: 600, pcpu: 0, command: 'claude' };
    const r = reconcileSessions(makeInput({
      agents: [procA], byPid: new Map([[700, procA]]),
      cwdByPid: new Map([[700, '/w']]),
      nativeBindings: new Map([[700, { sessionId: 'real-session', status: 'busy' as const }]]),
      sessions: [
        sess('claude:real-session', { cwd: '/elsewhere' }),           // cwd 불일치여도
        sess('claude:imposter', { pid: 700, hookPid: 700, cwd: '/w' }), // pid·hookPid·cwd 다 가진 사칭 세션보다
      ],
    }));
    expect(r.claims[0]).toMatchObject({ key: 'claude:real-session', pid: 700, mapping: 'exact' });
    expect(r.exited).toEqual(['claude:imposter']);
  });

  it('hookPid가 저장된 pid보다 우선 — 재시작 레이스로 잘못 고착된 바인딩을 매 pass 교정', () => {
    // 카드 스왑 재현: 세션 A에 B의 pid가 잘못 저장된 상태에서 A의 hookPid가 도착
    const procA = { pid: 700, ppid: 600, pcpu: 0, command: 'claude' };
    const procB = { pid: 710, ppid: 600, pcpu: 0, command: 'claude' };
    const r = reconcileSessions(makeInput({
      agents: [procA, procB], byPid: new Map([[700, procA], [710, procB]]),
      sessions: [
        sess('claude:A', { pid: 710, hookPid: 700 }), // 잘못 저장된 pid=710, 진짜는 700
        sess('claude:B', { pid: 700, hookPid: 710 }),
      ],
    }));
    const byKey = Object.fromEntries(r.claims.map((c) => [c.key, c.pid]));
    expect(byKey['claude:A']).toBe(700); // hookPid가 이김
    expect(byKey['claude:B']).toBe(710);
  });

  it('cwd 휴리스틱은 launchCwd 기준 — 세션 내부 cd로 표시 cwd가 바뀌어도 자기 프로세스와 매칭', () => {
    const proc = { pid: 700, ppid: 600, pcpu: 0, command: 'claude' };
    const r = reconcileSessions(makeInput({
      agents: [proc], byPid: new Map([[700, proc]]),
      cwdByPid: new Map([[700, '/w']]), // 프로세스 OS cwd = 시작 디렉토리
      sessions: [sess('claude:a', { launchCwd: '/w', cwd: '/w/tmp/storybook-video' })],
    }));
    expect(r.claims[0]).toMatchObject({ key: 'claude:a', pid: 700 });
  });

  it('hookPid는 cwd 휴리스틱보다 우선 — 최근 활동 세션이 cwd로 가로채지 않음', () => {
    const other = { pid: 710, ppid: 600, pcpu: 0, command: 'claude' };
    const r = reconcileSessions(makeInput({
      agents: [claudeProc, other],
      byPid: new Map([[700, claudeProc], [710, other]]),
      cwdByPid: new Map([[700, '/w'], [710, '/w']]),
      sessions: [
        sess('claude:recent', { cwd: '/w', lastActivityAt: T + 1000 }),
        sess('claude:mine', { cwd: '/w', hookPid: 700 }),
      ],
    }));
    const byKey = Object.fromEntries(r.claims.map((c) => [c.key, c]));
    expect(byKey['claude:mine'].pid).toBe(700);
    expect(byKey['claude:recent'].pid).toBe(710);
  });

  it('미클레임 세션은 exited — 카드 수 = 살아있는 프로세스 수 (유령 카드 근본 수정)', () => {
    const r = reconcileSessions(makeInput({
      agents: [claudeProc], byPid: new Map([[700, claudeProc]]),
      cwdByPid: new Map([[700, '/w']]),
      sessions: [
        sess('claude:live', { cwd: '/w' }),
        sess('claude:ghost', { cwd: '/w', lastActivityAt: T - 60_000 }), // resume 잔재 등
      ],
    }));
    expect(r.claims[0].key).toBe('claude:live');
    expect(r.exited).toEqual(['claude:ghost']);
  });

  it('등록 grace 내 세션은 exited 유예 (시작 레이스)', () => {
    const r = reconcileSessions(makeInput({
      sessions: [sess('claude:young', { registeredAt: T - 1000 })],
    }));
    expect(r.exited).toEqual([]);
  });

  it('이미 exited인 세션은 반복 마킹하지 않음', () => {
    const r = reconcileSessions(makeInput({
      sessions: [sess('claude:dead', { processAlive: false })],
    }));
    expect(r.exited).toEqual([]);
  });

  it('cwd 휴리스틱은 exited 세션을 부활시키지 않음 (exact 신호만 부활 가능)', () => {
    const r = reconcileSessions(makeInput({
      agents: [claudeProc], byPid: new Map([[700, claudeProc]]),
      cwdByPid: new Map([[700, '/w']]),
      sessions: [sess('claude:dead', { cwd: '/w', processAlive: false })],
    }));
    expect(r.claims).toEqual([]);
  });

  it('같은 pid를 가진 중복 세션은 최근 활동 세션만 클레임, 나머지 exited', () => {
    const r = reconcileSessions(makeInput({
      agents: [claudeProc], byPid: new Map([[700, claudeProc]]),
      sessions: [
        sess('claude:old', { pid: 700, lastActivityAt: T - 60_000 }),
        sess('claude:new', { pid: 700, lastActivityAt: T }),
      ],
    }));
    expect(r.claims[0].key).toBe('claude:new');
    expect(r.exited).toEqual(['claude:old']);
  });

  it('parentLinks: claude가 띄운 codex → 부모 세션 연결, 독립 프로세스는 null', () => {
    const codexProc = { pid: 800, ppid: 700, pcpu: 0, command: 'codex exec' };
    const byPid = new Map([[700, claudeProc], [800, codexProc]]);
    const r = reconcileSessions(makeInput({
      agents: [claudeProc, codexProc], byPid,
      sessions: [sess('claude:parent', { pid: 700 }), sess('codex:child', { pid: 800 })],
    }));
    const links = Object.fromEntries(r.parentLinks.map((l) => [l.key, l.parentKey]));
    expect(links['codex:child']).toBe('claude:parent');
    expect(links['claude:parent']).toBeNull();
  });

  it('래퍼 collapse: node 래퍼→codex 바이너리 체인은 하나의 논리 프로세스 — 중간 셸·래퍼를 건너 claude에 연결', () => {
    // 실측 형태: claude(700) → zsh(750) → node .../bin/codex(820) → codex 바이너리(830)
    const procs = {
      claude: { pid: 700, ppid: 600, pcpu: 0, command: 'claude' },
      sh: { pid: 750, ppid: 700, pcpu: 0, command: '/bin/zsh -c codex ...' },
      wrapper: { pid: 820, ppid: 750, pcpu: 0, command: 'node /Users/dev/.nvm/v24/bin/codex exec --cd /repo' },
      binary: { pid: 830, ppid: 820, pcpu: 0, command: '/nvm/codex-darwin-arm64/vendor/bin/codex exec --cd /repo' },
    };
    const byPid = new Map(Object.values(procs).map((p) => [p.pid, p]));
    const r = reconcileSessions(makeInput({
      agents: [procs.claude, procs.wrapper, procs.binary], byPid,
      cwdByPid: new Map([[700, '/w'], [820, '/w'], [830, '/w']]), // --cd는 chdir 안 함 — 전부 셸 cwd
      sessions: [
        sess('claude:parent', { pid: 700 }),
        sess('codex:child', { cwd: '/repo' }), // rollout 기록 cwd는 --cd 값 — 프로세스 cwd와 불일치
      ],
    }));
    // 이중 클레임 없음: codex 논리 프로세스 1개가 singleton pairing으로 클레임
    expect(r.claims.filter((c) => c.key === 'codex:child')).toHaveLength(1);
    expect(r.exited).toEqual([]);
    const links = Object.fromEntries(r.parentLinks.map((l) => [l.key, l.parentKey]));
    expect(links['codex:child']).toBe('claude:parent'); // 래퍼가 부모를 가리지 않음
  });

  it('singleton pairing: cwd 불일치라도 미클레임 프로세스 1개 + 활발한 미클레임 세션 1개면 짝지음', () => {
    const codexProc = { pid: 800, ppid: 1, pcpu: 0, command: 'codex exec --cd /repo' };
    const r = reconcileSessions(makeInput({
      agents: [codexProc], byPid: new Map([[800, codexProc]]),
      cwdByPid: new Map([[800, '/elsewhere']]),
      sessions: [sess('codex:a', { cwd: '/repo', lastActivityAt: T - 5000 })],
    }));
    expect(r.claims[0]).toMatchObject({ key: 'codex:a', pid: 800, mapping: 'heuristic' });
  });

  it('singleton pairing: pid 이력 있는 세션은 후보 제외 — 방금 죽은 세션이 새 프로세스를 선점하지 않음', () => {
    const codexProc = { pid: 900, ppid: 1, pcpu: 0, command: 'codex' };
    const base = {
      agents: [codexProc], byPid: new Map([[900, codexProc]]),
      cwdByPid: new Map([[900, '/elsewhere']]),
    };
    // 죽은 직전 세션(pid 800, 아직 fresh)만 있을 때: 짝짓지 않고 exited
    const ghostOnly = reconcileSessions(makeInput({
      ...base, sessions: [sess('codex:ghost', { pid: 800, cwd: '/old' })],
    }));
    expect(ghostOnly.claims).toEqual([]);
    expect(ghostOnly.exited).toEqual(['codex:ghost']);
    // 새 세션(pid 없음)이 등록되면 유령이 있어도 새 세션과 짝지음
    const withNew = reconcileSessions(makeInput({
      ...base,
      sessions: [
        sess('codex:ghost', { pid: 800, cwd: '/old' }),
        sess('codex:new', { cwd: '/new' }),
      ],
    }));
    expect(withNew.claims[0]).toMatchObject({ key: 'codex:new', pid: 900 });
  });

  it('진짜 동종 서브에이전트(셸 경유 claude→claude)는 collapse되지 않고 부모에 연결됨', () => {
    const parent = { pid: 700, ppid: 600, pcpu: 0, command: 'claude' };
    const sh = { pid: 750, ppid: 700, pcpu: 0, command: '/bin/zsh -c claude -p ...' };
    const child = { pid: 760, ppid: 750, pcpu: 0, command: 'claude -p 하위작업' };
    const byPid = new Map([[700, parent], [750, sh], [760, child]]);
    const r = reconcileSessions(makeInput({
      agents: [parent, child], byPid,
      sessions: [sess('claude:parent', { pid: 700 }), sess('claude:child', { pid: 760 })],
    }));
    expect(r.claims).toHaveLength(2); // 둘 다 클레임됨 (child가 래퍼로 오인되지 않음)
    const links = Object.fromEntries(r.parentLinks.map((l) => [l.key, l.parentKey]));
    expect(links['claude:child']).toBe('claude:parent');
  });

  it('singleton pairing: 후보가 둘이거나 활동이 오래됐으면 짝짓지 않음 (오귀속 방지)', () => {
    const codexProc = { pid: 800, ppid: 1, pcpu: 0, command: 'codex' };
    const base = {
      agents: [codexProc], byPid: new Map([[800, codexProc]]),
      cwdByPid: new Map([[800, '/elsewhere']]),
    };
    const two = reconcileSessions(makeInput({
      ...base,
      sessions: [sess('codex:a', { cwd: '/r1' }), sess('codex:b', { cwd: '/r2' })],
    }));
    expect(two.claims).toEqual([]);
    const stale = reconcileSessions(makeInput({
      ...base,
      sessions: [sess('codex:a', { cwd: '/r1', lastActivityAt: T - PAIRING_FRESH_MS - 1 })],
    }));
    expect(stale.claims).toEqual([]);
  });

  it('orphanProcs: 세션 파일 없는 agent 프로세스는 플레이스홀더 대상으로 보고 (첫 쿼리 전 codex)', () => {
    const parent = { pid: 700, ppid: 600, pcpu: 0, command: 'claude' };
    const sh = { pid: 750, ppid: 700, pcpu: 0, command: '/bin/zsh -c codex' };
    const fresh = { pid: 800, ppid: 750, pcpu: 0, command: 'codex' }; // rollout 파일 아직 없음
    const byPid = new Map([[700, parent], [750, sh], [800, fresh]]);
    const r = reconcileSessions(makeInput({
      agents: [parent, fresh], byPid,
      sessions: [sess('claude:parent', { pid: 700 })],
    }));
    expect(r.orphanProcs).toEqual([
      { agent: 'codex', pid: 800, terminalName: undefined, shellPid: undefined, parentKey: 'claude:parent' },
    ]);
  });

  // ── 데몬 스폰 bg 서브에이전트 (Claude Code 2.1.20x) ─────────────────
  const BG_SID = '8995252a-14c4-4568-bc20-37fed1e8625a';
  const PARENT_SID = 'a5db5c28-c147-44dc-92bf-b08a9d1a2040';
  const bgCmd = `/Users/cj/.local/share/claude/versions/2.1.207 --session-id ${BG_SID} --fork-session --resume /Users/cj/.claude/projects/-x/${PARENT_SID}.jsonl --permission-mode bypassPermissions`;

  it('바인딩 보강: versions/<semver> 바이너리 bg 세션도 네이티브 바인딩으로 클레임 + fork 부모 연결', () => {
    const parentProc = { pid: 16402, ppid: 600, pcpu: 0, command: 'claude' };
    const bgProc = { pid: 24577, ppid: 1, pcpu: 0, command: bgCmd }; // 데몬 스폰 — ppid=1
    const r = reconcileSessions(makeInput({
      agents: [parentProc], // 스냅샷의 detectAgent는 bgProc를 못 봄 — byPid에만 존재
      byPid: new Map([[16402, parentProc], [24577, bgProc]]),
      nativeBindings: new Map([[24577, { sessionId: BG_SID, status: 'idle' as const }]]),
      sessions: [
        sess(`claude:${PARENT_SID}`, { pid: 16402 }),
        sess(`claude:${BG_SID}`),
      ],
    }));
    const byKey = Object.fromEntries(r.claims.map((c) => [c.key, c]));
    expect(byKey[`claude:${BG_SID}`]).toMatchObject({ pid: 24577, mapping: 'exact' });
    const links = Object.fromEntries(r.parentLinks.map((l) => [l.key, l.parentKey]));
    expect(links[`claude:${BG_SID}`]).toBe(`claude:${PARENT_SID}`); // ppid=1이어도 fork 커맨드라인으로 부모 연결
    expect(r.exited).toEqual([]);
  });

  it('바인딩 보강 PID 재사용 방어: 커맨드라인에 바인딩 sessionId가 없으면 보강하지 않음', () => {
    const stranger = { pid: 24577, ppid: 1, pcpu: 0, command: '/usr/bin/some-unrelated-daemon' };
    const r = reconcileSessions(makeInput({
      byPid: new Map([[24577, stranger]]),
      nativeBindings: new Map([[24577, { sessionId: BG_SID }]]),
      sessions: [sess(`claude:${BG_SID}`)],
    }));
    expect(r.claims).toEqual([]);
    expect(r.exited).toEqual([`claude:${BG_SID}`]); // 무관 프로세스가 세션을 살려두지 않음
  });

  it('소속 증명(bound) 프로세스는 바인딩 세션 외 클레임 불가 — 미등록 bg 세션 + 같은 pid를 기록한 옛 세션', () => {
    const bgProc = { pid: 24577, ppid: 1, pcpu: 0, command: bgCmd };
    const r = reconcileSessions(makeInput({
      byPid: new Map([[24577, bgProc]]),
      nativeBindings: new Map([[24577, { sessionId: BG_SID, name: 'bg 작업' }]]),
      // bg 세션은 미등록. PID 재사용으로 24577을 기록해둔 옛 세션만 존재
      sessions: [sess('claude:stale-old', { pid: 24577, lastActivityAt: T - 30_000 })],
    }));
    expect(r.claims).toEqual([]); // 옛 세션이 bg 프로세스를 가로채지 않음
    expect(r.exited).toEqual(['claude:stale-old']);
    expect(r.orphanProcs).toMatchObject([{ agent: 'claude', pid: 24577, topic: 'bg 작업' }]);
  });

  it('bg 세션이 스토어 미등록(transcript 오래됨)이면 플레이스홀더 — 부모 연결 + 바인딩 이름 표시', () => {
    const parentProc = { pid: 16402, ppid: 600, pcpu: 0, command: 'claude' };
    const bgProc = { pid: 24577, ppid: 1, pcpu: 0, command: bgCmd };
    const r = reconcileSessions(makeInput({
      agents: [parentProc],
      byPid: new Map([[16402, parentProc], [24577, bgProc]]),
      nativeBindings: new Map([[24577, { sessionId: BG_SID, name: '관세 환급 관련 논의' }]]),
      sessions: [sess(`claude:${PARENT_SID}`, { pid: 16402 })], // bg 세션은 미등록
    }));
    expect(r.orphanProcs).toEqual([{
      agent: 'claude', pid: 24577, terminalName: undefined, shellPid: undefined,
      parentKey: `claude:${PARENT_SID}`, topic: '관세 환급 관련 논의',
    }]);
  });

  it('shellPid: 조상 체인에서 VS Code 터미널 shell 식별 + 이름 전달', () => {
    const shell = { pid: 600, ppid: 500, pcpu: 0, command: '/bin/zsh -il' };
    const byPid = new Map([[600, shell], [700, { ...claudeProc }]]);
    const r = reconcileSessions(makeInput({
      agents: [claudeProc], byPid,
      shellPids: new Map([[600, 'zsh — xr-merch']]),
      sessions: [sess('claude:a', { pid: 700 })],
    }));
    expect(r.claims[0]).toMatchObject({ shellPid: 600, terminalName: 'zsh — xr-merch' });
  });
});

// ── tmux (2026-09-08) ─────────────────────────────────────────────

describe('tmux 파서', () => {
  it('parseTmuxPanes: pane_pid → 세션·타겟, 세션 이름의 공백 보존', () => {
    const m = parseTmuxPanes('40227 @13 %13 21781/$13 cji-main\n53208 @15 %15 21781/$15 my session\n');
    expect(m.get(40227)).toEqual({ session: 'cji-main', target: 'cji-main:@13.%13', id: '21781/$13' });
    expect(m.get(53208)).toEqual({ session: 'my session', target: 'my session:@15.%15', id: '21781/$15' });
  });
  it('parseTmuxClients: 세션별 클라이언트 pid 목록', () => {
    const m = parseTmuxClients('40223 cji-main\n50000 cji-main\n60000 other\n');
    expect(m.get('cji-main')).toEqual([40223, 50000]);
    expect(m.get('other')).toEqual([60000]);
    expect(m.has('cji-x')).toBe(false);
  });
  it('parseTmuxSessionNames / tmuxSessions: linked window 로 같은 pane_pid 가 두 세션에 나와도 세션은 둘 다', () => {
    const text = '1010 @1 %1 4000/$1 cji-main\n1010 @1 %1 4000/$2 view\n';
    expect(parseTmuxSessionNames(text)).toEqual(new Set(['cji-main', 'view']));
    expect(parseTmuxPanes(text).size).toBe(1); // 덮어써서 하나만 — 세션 목록으로 쓰면 안 되는 이유
    expect(tmuxSessions({ panesByPid: parseTmuxPanes(text), clientPidsBySession: new Map(), sessions: parseTmuxSessionNames(text) }))
      .toEqual(new Set(['cji-main', 'view']));
    expect(tmuxSessions({ panesByPid: parseTmuxPanes(text), clientPidsBySession: new Map() })) // sessions 없으면 panes 에서 유도
      .toEqual(new Set(['view']));
  });
  it('parseTmuxTarget: 네이티브 바인딩 "session:@w.%p"', () => {
    expect(parseTmuxTarget('cji-main:@13.%13')).toEqual({ session: 'cji-main', target: 'cji-main:@13.%13' });
    expect(parseTmuxTarget(undefined)).toBeUndefined();
    expect(parseTmuxTarget('garbage')).toBeUndefined();
  });
});

describe('reconcileSessions — tmux 경유 터미널 매핑', () => {
  // 실측 트리: VS Code(500) → zsh(600) → tmux client(610) / tmux server(1000, ppid 1) → pane 셸(1010) → claude(1020)
  const server = { pid: 1000, ppid: 1, pcpu: 0, command: 'tmux new-session -d -s cji-x' };
  const paneShell = { pid: 1010, ppid: 1000, pcpu: 0, command: '/bin/bash _session.sh' };
  const claudeInTmux = { pid: 1020, ppid: 1010, pcpu: 0, command: 'claude -n x' };
  const vsShell = { pid: 600, ppid: 500, pcpu: 0, command: '/bin/zsh -il' };
  const client = { pid: 610, ppid: 600, pcpu: 0, command: 'tmux attach-session -t =cji-x' };
  const byPid = new Map([server, paneShell, claudeInTmux, vsShell, client].map((p) => [p.pid, p]));
  const panes = parseTmuxPanes('1010 @1 %1 4000/$7 cji-x');
  const ref = { session: 'cji-x', target: 'cji-x:@1.%1', id: '4000/$7' };
  const attached = { panesByPid: panes, clientPidsBySession: new Map([['cji-x', [610]]]) };
  const detached = { panesByPid: panes, clientPidsBySession: new Map<string, number[]>() };

  it('붙은 tmux: 클라이언트 조상 체인의 VS Code 셸을 shellPid 로, terminalName·tmux 전달', () => {
    const r = reconcileSessions(makeInput({
      agents: [claudeInTmux], byPid, shellPids: new Map([[600, 'tmux']]),
      sessions: [sess('claude:a', { pid: 1020 })], tmux: attached,
    }));
    expect(r.claims[0]).toMatchObject({ shellPid: 600, terminalName: 'tmux', tmux: ref });
  });
  it('shellPath 로 tmux 를 직접 띄운 터미널: processId 가 클라이언트 자신 — 자기 pid 로 히트', () => {
    const r = reconcileSessions(makeInput({
      agents: [claudeInTmux], byPid, shellPids: new Map([[610, 'cji-x']]),
      sessions: [sess('claude:a', { pid: 1020 })], tmux: attached,
    }));
    expect(r.claims[0]).toMatchObject({ shellPid: 610, terminalName: 'cji-x', tmux: ref });
  });
  it('pane 에서 exec 된 claude(pane_pid == claude 자신)도 세션을 찾는다', () => {
    const execd = { pid: 1010, ppid: 1000, pcpu: 0, command: 'claude -n main' };
    const r = reconcileSessions(makeInput({
      agents: [execd], byPid: new Map([[1000, server], [1010, execd], [600, vsShell], [610, client]]),
      shellPids: new Map([[600, 'tmux']]),
      sessions: [sess('claude:a', { pid: 1010 })], tmux: attached,
    }));
    expect(r.claims[0]).toMatchObject({ shellPid: 600, tmux: ref });
  });
  it('detached(클라이언트 0개): shellPid null(해제 확정) + tmux 유지 — 카드는 tmux 칩, 클릭은 attach', () => {
    const r = reconcileSessions(makeInput({
      agents: [claudeInTmux], byPid, shellPids: new Map([[600, 'zsh']]),
      sessions: [sess('claude:a', { pid: 1020, shellPid: 600 })], tmux: detached,
    }));
    expect(r.claims[0]).toMatchObject({ shellPid: null, terminalName: undefined, tmux: ref });
  });
  it('클라이언트가 VS Code 밖(iTerm)에만 남음: 이전 shellPid 가 어느 클라이언트의 조상도 아니면 해제 확정', () => {
    const iterm = { pid: 900, ppid: 1, pcpu: 0, command: 'tmux attach -t cji-x' };
    const r = reconcileSessions(makeInput({
      agents: [claudeInTmux], byPid: new Map([...byPid, [900, iterm]]),
      shellPids: new Map([[600, 'zsh']]),
      sessions: [sess('claude:a', { pid: 1020, shellPid: 600 })],
      tmux: { panesByPid: panes, clientPidsBySession: new Map([['cji-x', [900]]]) },
    }));
    expect(r.claims[0].shellPid).toBeNull();
  });
  it('일시 실패(processId 미응답으로 shellPids 에 빠짐): 이전 shellPid 가 ps 상 클라이언트 조상이면 유지(undefined)', () => {
    const r = reconcileSessions(makeInput({
      agents: [claudeInTmux], byPid, shellPids: new Map(),
      sessions: [sess('claude:a', { pid: 1020, shellPid: 600 })], tmux: attached,
    }));
    expect(r.claims[0]).toMatchObject({ shellPid: undefined, tmux: ref });
  });
  it('tmux 조회 실패(input.tmux 없음): 네이티브 tmux 타겟으로 칩만 붙이고 shellPid 는 불확실(undefined)', () => {
    const r = reconcileSessions(makeInput({
      agents: [claudeInTmux], byPid, shellPids: new Map([[600, 'zsh']]),
      sessions: [sess('claude:a', { pid: 1020, shellPid: 600 })],
      nativeBindings: new Map([[1020, { sessionId: 'a', tmux: 'cji-x:@1.%1' }]]),
    }));
    expect(r.claims[0]).toMatchObject({ shellPid: undefined, tmux: { session: 'cji-x', target: 'cji-x:@1.%1' } });
  });
  it('네이티브 tmux 타겟 폴백: 체인이 pane 에 안 닿아도(재부모화) 클라이언트로 VS Code 셸을 찾는다', () => {
    const reparented = { pid: 1020, ppid: 1, pcpu: 0, command: 'claude' };
    const r = reconcileSessions(makeInput({
      agents: [reparented], byPid: new Map([[1020, reparented], [600, vsShell], [610, client]]),
      shellPids: new Map([[600, 'tmux']]),
      sessions: [sess('claude:a', { pid: 1020 })],
      nativeBindings: new Map([[1020, { sessionId: 'a', tmux: 'cji-x:@1.%1' }]]),
      tmux: { panesByPid: new Map(), clientPidsBySession: new Map([['cji-x', [610]]]) },
    }));
    expect(r.claims[0]).toMatchObject({ shellPid: 600, tmux: { session: 'cji-x', target: 'cji-x:@1.%1' } });
    expect(r.claims[0].tmux?.id).toBeUndefined();
  });
  it('네이티브 tmux 타겟 폴백: 이름만 같고 window/pane 이 다른 pane 은 id 를 빌려주지 않는다 (재사용된 이름)', () => {
    const reparented = { pid: 1020, ppid: 1, pcpu: 0, command: 'claude' };
    const r = reconcileSessions(makeInput({
      agents: [reparented], byPid: new Map([[1020, reparented]]),
      sessions: [sess('claude:a', { pid: 1020 })],
      nativeBindings: new Map([[1020, { sessionId: 'a', tmux: 'cji-x:@9.%9' }]]),
      tmux: detached,
    }));
    expect(r.claims[0].tmux).toEqual({ session: 'cji-x', target: 'cji-x:@9.%9' });
  });
  it('네이티브 tmux 타겟 폴백: 같은 window/pane 이 있으면 id 를 보충한다', () => {
    const reparented = { pid: 1020, ppid: 1, pcpu: 0, command: 'claude' };
    const r = reconcileSessions(makeInput({
      agents: [reparented], byPid: new Map([[1020, reparented]]),
      sessions: [sess('claude:a', { pid: 1020 })],
      nativeBindings: new Map([[1020, { sessionId: 'a', tmux: 'cji-x:@1.%1' }]]),
      tmux: detached,
    }));
    expect(r.claims[0].tmux).toEqual(ref);
  });
  it('ps 스냅샷보다 늦게 붙은 클라이언트(byPid 에 없음)가 있으면 해제 확정하지 않는다(undefined) — 기동 순간 중복 attach 방지', () => {
    const r = reconcileSessions(makeInput({
      agents: [claudeInTmux], byPid, shellPids: new Map([[600, 'zsh']]),
      sessions: [sess('claude:a', { pid: 1020 })],
      tmux: { panesByPid: panes, clientPidsBySession: new Map([['cji-x', [9999]]]) }, // 9999 는 ps 에 없음
    }));
    expect(r.claims[0]).toMatchObject({ shellPid: undefined, tmux: ref });
  });
  it('orphanProcs: 플레이스홀더의 이전 shellPid 가 ps 상 클라이언트 조상이면 일시 실패에도 유지(undefined)', () => {
    const r = reconcileSessions(makeInput({
      agents: [claudeInTmux], byPid, shellPids: new Map(), tmux: attached,
      placeholderShellPids: new Map([[1020, 600]]),
    }));
    expect(r.orphanProcs[0]).toMatchObject({ pid: 1020, shellPid: undefined, tmux: ref });
  });
  it('orphanProcs(세션 파일 전)도 tmux 위치를 전달한다', () => {
    const r = reconcileSessions(makeInput({
      agents: [claudeInTmux], byPid, shellPids: new Map(), tmux: detached,
    }));
    expect(r.orphanProcs[0]).toMatchObject({ pid: 1020, shellPid: null, tmux: ref });
  });
  it('비-tmux 프로세스는 tmux 정보가 있어도 영향 없음 (회귀)', () => {
    const proc = { pid: 700, ppid: 600, pcpu: 0, command: 'claude' };
    const r = reconcileSessions(makeInput({
      agents: [proc], byPid: new Map([[600, vsShell], [700, proc]]),
      shellPids: new Map([[600, 'zsh']]),
      sessions: [sess('claude:a', { pid: 700 })], tmux: detached,
    }));
    expect(r.claims[0]).toMatchObject({ shellPid: 600, terminalName: 'zsh' });
    expect(r.claims[0].tmux).toBeUndefined();
  });
});

describe('autoAttachTargets', () => {
  const a = { session: 'cji-a', target: 'cji-a:@1.%1', id: '4000/$1' };
  const b = { session: 'cji-b', target: 'cji-b:@2.%2', id: '4000/$2' };
  it('이 창에 터미널 없음이 확정된(shellPid null) 세션만 — number(붙음)·undefined(불확실)는 제외', () => {
    expect(autoAttachTargets([
      { tmux: a, shellPid: null }, { tmux: b, shellPid: 600 },
      { tmux: { ...b, id: '4000/$3', session: 'cji-c' }, shellPid: undefined },
      { shellPid: null },
    ], new Set())).toEqual([a]);
  });
  it('같은 세션의 여러 프로세스(서브에이전트)는 1개, attempted(사용자가 닫은 탭)는 제외', () => {
    expect(autoAttachTargets(
      [{ tmux: a, shellPid: null }, { tmux: a, shellPid: null }, { tmux: b, shellPid: null }],
      new Set([tmuxRefKey(b)]),
    )).toEqual([a]);
  });
  it('tmuxRefKey: id 우선, 없으면 이름', () => {
    expect(tmuxRefKey(a)).toBe('4000/$1');
    expect(tmuxRefKey({ session: 'x', target: 'x:@1.%1' })).toBe('name:x');
  });
});

describe('ensureDue / expandHome (aiSessions.tmuxEnsure)', () => {
  const main = { session: 'cji-main', command: '~/Desktop/CJI/tools/cji/main.sh', offFile: '/Users/cj/.cji/main.off' };
  const no = () => false;
  it('세션이 없고 상태도 없으면 실행', () => {
    expect(ensureDue([main], new Set(), new Map(), T, no)).toEqual({ run: [main], stale: [] });
  });
  it('세션이 살아 있으면 아무것도 안 함', () => {
    expect(ensureDue([main], new Set(['cji-main']), new Map(), T, no)).toEqual({ run: [], stale: [] });
  });
  it('off 스위치 파일이 있으면 건너뜀', () => {
    expect(ensureDue([main], new Set(), new Map(), T, (p) => p === main.offFile)).toEqual({ run: [], stale: [] });
  });
  it('터미널이 살아 있고 유예 안이면 대기, 유예를 넘기면 stale', () => {
    const st = new Map([['cji-main', { terminalAlive: true, startedAt: T, lastAttemptAt: T }]]);
    expect(ensureDue([main], new Set(), st, T + ENSURE_GRACE_MS - 1, no)).toEqual({ run: [], stale: [] });
    expect(ensureDue([main], new Set(), st, T + ENSURE_GRACE_MS + 1, no)).toEqual({ run: [], stale: ['cji-main'] });
  });
  it('터미널이 닫힌 뒤 쿨다운 안이면 대기, 지나면 다시 실행', () => {
    const st = new Map([['cji-main', { terminalAlive: false, lastAttemptAt: T }]]);
    expect(ensureDue([main], new Set(), st, T + ENSURE_COOLDOWN_MS - 1, no).run).toEqual([]);
    expect(ensureDue([main], new Set(), st, T + ENSURE_COOLDOWN_MS + 1, no).run).toEqual([main]);
  });
  it('같은 세션 이름은 첫 항목만, session/command 빈 항목은 무시', () => {
    const dup = { session: 'cji-main', command: 'other' };
    expect(ensureDue([main, dup, { session: '', command: 'x' }], new Set(), new Map(), T, no).run).toEqual([main]);
  });
  it('expandHome: ~ 와 ~/ 만 확장', () => {
    expect(expandHome('~/Desktop/CJI', '/Users/cj')).toBe('/Users/cj/Desktop/CJI');
    expect(expandHome('~', '/Users/cj')).toBe('/Users/cj');
    expect(expandHome('/abs/~/x', '/Users/cj')).toBe('/abs/~/x');
    expect(expandHome('~user/x', '/Users/cj')).toBe('~user/x');
  });
});

describe('네이티브 세션 이름·빈 터미널 판정 (0.5.1)', () => {
  it('claims 에 네이티브 바인딩의 name/nameSource 전달', () => {
    const proc = { pid: 700, ppid: 600, pcpu: 0, command: 'claude -n xr-merch-0908' };
    const r = reconcileSessions(makeInput({
      agents: [proc], byPid: new Map([[700, proc]]),
      sessions: [sess('claude:a', { pid: 700 })],
      nativeBindings: new Map([[700, { sessionId: 'a', name: 'xr-merch-0908', nameSource: 'user' as const }]]),
    }));
    expect(r.claims[0]).toMatchObject({ name: 'xr-merch-0908', nameSource: 'user' });
  });
  it('idleShellPids: 자식 없는 셸만 — 스냅샷 부재·비셸·보호·자식 있음은 제외, 로그인 셸(-zsh)도 셸', () => {
    const byPid = new Map([
      [600, { pid: 600, ppid: 500, pcpu: 0, command: '/bin/zsh -il' }],   // 빈 셸
      [601, { pid: 601, ppid: 500, pcpu: 0, command: '-zsh' }],           // 빈 로그인 셸
      [602, { pid: 602, ppid: 500, pcpu: 0, command: '/bin/zsh -il' }],   // 자식 있음
      [700, { pid: 700, ppid: 602, pcpu: 0, command: 'npm run dev' }],
      [603, { pid: 603, ppid: 500, pcpu: 0, command: '/opt/homebrew/bin/tmux attach-session -t $13' }], // 셸 아님
      [604, { pid: 604, ppid: 500, pcpu: 0, command: '/bin/bash' }],      // 보호 대상
    ]);
    expect(idleShellPids([600, 601, 602, 603, 604, 999], byPid, new Set([604]))).toEqual([600, 601]);
  });
});

describe('adoptableAttachTerminals / containerGone (0.5.3 — 고스트 제거)', () => {
  const tmux = {
    panesByPid: parseTmuxPanes('300 @1 %1 21781/$5 cji-a\n400 @2 %2 21781/$6 cji-b\n'),
    clientPidsBySession: parseTmuxClients('1000 cji-a\n1001 cji-a\n2000 cji-b\n'),
    sessions: new Set(['cji-a', 'cji-b', 'cji-c']),
  };
  it('터미널 shell pid 가 곧 tmux client pid 인 것만 인수 — 키는 pane 의 id, pane 이 없으면 name:', () => {
    const out = adoptableAttachTerminals([1000, 2000, 5555], tmux, new Set());
    expect(out).toEqual([
      { pid: 1000, key: '21781/$5', session: 'cji-a' },
      { pid: 2000, key: '21781/$6', session: 'cji-b' },
    ]);
    const noPane = { ...tmux, clientPidsBySession: parseTmuxClients('3000 cji-c\n') };
    expect(adoptableAttachTerminals([3000], noPane, new Set())).toEqual([{ pid: 3000, key: 'name:cji-c', session: 'cji-c' }]);
  });
  it('이미 추적 중인 pid 는 건너뛰고, 사용자의 zsh 안 tmux attach(터미널 pid ≠ client pid)는 대상이 아니다', () => {
    expect(adoptableAttachTerminals([1000, 2000], tmux, new Set([1000]))).toEqual([{ pid: 2000, key: '21781/$6', session: 'cji-b' }]);
    expect(adoptableAttachTerminals([600], tmux, new Set())).toEqual([]); // 600 = zsh, 그 자식이 클라이언트
  });
  it('containerGone: tmux 세션이 사라졌으면 true, 남아 있으면 false, tmux 조회 실패면 false(불확실)', () => {
    const s = { tmux: { session: 'cji-a', target: 'cji-a:@1.%1' } };
    expect(containerGone(s, { ...tmux, sessions: new Set(['cji-b']) }, new Set([1000]))).toBe(true);
    expect(containerGone(s, tmux, new Set())).toBe(false);
    expect(containerGone(s, undefined, new Set())).toBe(false);
  });
  it('containerGone: id 가 있으면 id 로 — 같은 이름으로 다시 만든 세션은 gone, 이름만 바뀐 세션은 살아 있음 (codex 리뷰)', () => {
    const withId = { tmux: { session: 'cji-a', target: 'cji-a:@1.%1', id: '21781/$5' } };
    const replaced = { ...tmux, panesByPid: parseTmuxPanes('900 @9 %9 21781/$9 cji-a\n'), sessions: new Set(['cji-a']) };
    expect(containerGone(withId, replaced, new Set())).toBe(true);
    const renamed = { ...tmux, panesByPid: parseTmuxPanes('300 @1 %1 21781/$5 cji-renamed\n'), sessions: new Set(['cji-renamed']) };
    expect(containerGone(withId, renamed, new Set())).toBe(false);
    expect(containerGone(withId, tmux, new Set())).toBe(false);
  });
  it('containerGone: tmux 아닌 세션은 shellPid 터미널이 없어졌을 때만 true. pid 조회 불확실(undefined)·세션 없음·shellPid 없음은 false', () => {
    expect(containerGone({ shellPid: 600 }, tmux, new Set([700]))).toBe(true);
    expect(containerGone({ shellPid: 600 }, tmux, new Set([600]))).toBe(false);
    expect(containerGone({ shellPid: 600 }, tmux, undefined)).toBe(false);
    expect(containerGone({ tmux: { session: 'cji-a', target: 'cji-a:@1.%1' } }, { ...tmux, sessions: new Set() }, undefined)).toBe(true);
    expect(containerGone({}, tmux, new Set())).toBe(false);
    expect(containerGone({ shellPid: null }, tmux, new Set())).toBe(false);
    expect(containerGone(undefined, tmux, new Set())).toBe(false);
  });
});
