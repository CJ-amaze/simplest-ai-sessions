import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyCodexLine, codexFields, newCodexAccum } from '../src/adapters/codex';

const T = 1_000_000_000_000;

describe('CodexAdapter', () => {
  it('fixture에서 전 필드 추출', () => {
    const acc = newCodexAccum();
    const lines = readFileSync(join(__dirname, 'fixtures/codex.jsonl'), 'utf8').split('\n');
    for (const l of lines) if (l.trim()) applyCodexLine(acc, l);
    const f = codexFields(acc);
    expect(f.model).toBe('gpt-5.6-sol');
    expect(f.mode).toBe('max·never·workspace-write');
    expect(f.cwd).toBe('/Users/dev/Desktop/CJI');
    expect(f.topic!.length).toBeLessThanOrEqual(60);
    expect(f.topic!.endsWith('…')).toBe(true);
    expect(f.topic).toContain('스펙 파일 리뷰');
    expect(f.totalTokens).toBe(12807);
    expect(f.contextTokens).toBe(12807);     // last_token_usage.total_tokens
    expect(f.contextWindow).toBe(353400);
    expect(f.costUsd).toBeUndefined();        // 비-claude 모델은 단가 없음
    // 라인 timestamp가 그대로 신호 시각이 됨 (fixture의 시각 순서: started < approval < complete)
    expect(acc.turnStartedAtMs).toBeLessThan(acc.approvalAtMs!);
    expect(acc.approvalAtMs).toBeLessThan(acc.turnCompletedAtMs!);
  });

  it('깨진 라인 skip', () => {
    const acc = newCodexAccum();
    expect(applyCodexLine(acc, 'not json')).toBe(false);
  });

  it('task_started는 라인 시각의 턴 시작과 컨텍스트 윈도우를 기록', () => {
    const acc = newCodexAccum();
    const line = JSON.stringify({
      timestamp: new Date(T).toISOString(),
      type: 'event_msg', payload: { type: 'task_started', model_context_window: 200_000 },
    });
    expect(applyCodexLine(acc, line)).toBe(true);
    expect(acc.turnStartedAtMs).toBe(T);
    expect(acc.contextWindow).toBe(200_000);
  });

  it('turn_aborted는 턴 완료로 처리', () => {
    const acc = newCodexAccum();
    const line = JSON.stringify({
      timestamp: new Date(T).toISOString(), type: 'event_msg', payload: { type: 'turn_aborted' },
    });
    expect(applyCodexLine(acc, line)).toBe(true);
    expect(acc.turnCompletedAtMs).toBe(T);
  });

  it('timestamp 없는 이벤트 라인은 턴 신호를 만들지 않음 (오염 방지)', () => {
    const acc = newCodexAccum();
    applyCodexLine(acc, '{"type":"event_msg","payload":{"type":"task_started"}}');
    expect(acc.turnStartedAtMs).toBeUndefined();
  });
});
