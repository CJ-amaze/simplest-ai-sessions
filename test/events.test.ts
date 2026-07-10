import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseHookEventLine, parseStatusLine } from '../src/hooks/events';

describe('parseHookEventLine', () => {
  it('정상 이벤트 파싱', () => {
    const e = parseHookEventLine(
      '{"agent":"claude","kind":"notification","sessionId":"abc","pid":123,"observedAt":1700000000000}',
    );
    expect(e).toEqual({
      agent: 'claude', kind: 'notification', sessionId: 'abc', pid: 123, observedAt: 1700000000000,
    });
  });
  it('빈 sessionId는 undefined로', () => {
    const e = parseHookEventLine('{"agent":"codex","kind":"approval","sessionId":"","pid":0,"observedAt":1}');
    expect(e?.sessionId).toBeUndefined();
    expect(e?.pid).toBeUndefined(); // 0도 무의미 → undefined
  });
  it('idle 이벤트 파싱 허용', () => {
    const e = parseHookEventLine('{"agent":"claude","kind":"idle","observedAt":1}');
    expect(e?.kind).toBe('idle');
  });
  it('unknown agent/kind → null', () => {
    expect(parseHookEventLine('{"agent":"x","kind":"notification","observedAt":1}')).toBeNull();
    expect(parseHookEventLine('{"agent":"claude","kind":"weird","observedAt":1}')).toBeNull();
    expect(parseHookEventLine('broken')).toBeNull();
  });
});

describe('agent-monitor-hook.sh (통합)', () => {
  it('claude stdin 모드로 이벤트 append', () => {
    const home = mkdtempSync(join(tmpdir(), 'hookhome-'));
    execFileSync('bash', [join(__dirname, '../resources/agent-monitor-hook.sh'), 'claude', 'notification'], {
      input: '{"session_id":"sess-1","hook_event_name":"Notification"}',
      env: { ...process.env, HOME: home },
    });
    const line = readFileSync(join(home, '.vscode-agent-monitor/events.jsonl'), 'utf8').trim();
    const e = parseHookEventLine(line);
    expect(e?.agent).toBe('claude');
    expect(e?.kind).toBe('notification');
    expect(e?.sessionId).toBe('sess-1');
  });

  it('claude notification message를 approval/idle로 분류', () => {
    const cases = [
      ['Permission required', 'approval'],
      ['Approval needed', 'approval'],
      ['Approve this action', 'approval'],
      ['Claude is waiting for your input', 'idle'],
    ];
    for (const [message, kind] of cases) {
      const home = mkdtempSync(join(tmpdir(), 'hookhome-'));
      execFileSync('bash', [join(__dirname, '../resources/agent-monitor-hook.sh'), 'claude', 'notification'], {
        input: JSON.stringify({ session_id: 'sess-1', message }),
        env: { ...process.env, HOME: home },
      });
      const line = readFileSync(join(home, '.vscode-agent-monitor/events.jsonl'), 'utf8').trim();
      expect(parseHookEventLine(line)?.kind).toBe(kind);
    }
  });

  it('codex 모드: "type" 필드만으로 분기 — 자유 텍스트에 섞인 "approval" 오탐 안 함', () => {
    const home = mkdtempSync(join(tmpdir(), 'hookhome-'));
    const payload = '{"type":"agent-turn-complete","last-assistant-message":"approval needed for X"}';
    execFileSync('bash', [join(__dirname, '../resources/agent-monitor-hook.sh'), 'codex', payload], {
      env: { ...process.env, HOME: home },
    });
    const line = readFileSync(join(home, '.vscode-agent-monitor/events.jsonl'), 'utf8').trim();
    const e = parseHookEventLine(line);
    expect(e?.agent).toBe('codex');
    expect(e?.kind).toBe('turn-complete'); // "approval"이 아니라 turn-complete여야 함
  });

  it('codex 모드: thread-id를 sessionId로 추출 (BSD sed alternation 미지원 회피)', () => {
    const home = mkdtempSync(join(tmpdir(), 'hookhome-'));
    const payload = '{"type":"agent-turn-complete","thread-id":"th-123","input_messages":[{"type":"text"}]}';
    execFileSync('bash', [join(__dirname, '../resources/agent-monitor-hook.sh'), 'codex', payload], {
      env: { ...process.env, HOME: home },
    });
    const e = parseHookEventLine(readFileSync(join(home, '.vscode-agent-monitor/events.jsonl'), 'utf8').trim());
    expect(e?.sessionId).toBe('th-123');
    expect(e?.kind).toBe('turn-complete'); // 중첩된 "type":"text"가 아니라 최상위 type으로 분기
  });

  it('훅 타임스탬프는 ms 정밀도 (1초 정밀도면 같은 초의 이벤트 순서가 역전됨)', () => {
    const home = mkdtempSync(join(tmpdir(), 'hookhome-'));
    for (let i = 0; i < 2; i++) {
      execFileSync('bash', [join(__dirname, '../resources/agent-monitor-hook.sh'), 'claude', 'stop'], {
        input: '{"session_id":"sess-1"}',
        env: { ...process.env, HOME: home },
      });
    }
    const events = readFileSync(join(home, '.vscode-agent-monitor/events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => parseHookEventLine(l)!);
    for (const e of events) expect(Math.abs(e.observedAt - Date.now())).toBeLessThan(10_000);
    expect(events.some((e) => e.observedAt % 1000 !== 0)).toBe(true); // ms 성분 존재
  });

  it('statusline shim: stdin JSON → status.jsonl 기록 + 표시줄 출력', () => {
    const home = mkdtempSync(join(tmpdir(), 'hookhome-'));
    const input = JSON.stringify({
      session_id: 'sess-9', model: { id: 'claude-fable-5', display_name: 'Fable 5' },
      effort: { level: 'max' },
    });
    const out = execFileSync('bash', [join(__dirname, '../resources/agent-monitor-statusline.sh')], {
      input, env: { ...process.env, HOME: home },
    }).toString();
    expect(out.trim()).toBe('Fable 5 · max');
    const rec = parseStatusLine(readFileSync(join(home, '.vscode-agent-monitor/status.jsonl'), 'utf8').trim());
    expect(rec).toEqual({ sessionId: 'sess-9', effort: 'max' });
  });
});
