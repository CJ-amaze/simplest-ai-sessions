import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyClaudeLine, claudeFields, newClaudeAccum } from '../src/adapters/claude';

function loadFixture() {
  const acc = newClaudeAccum();
  const lines = readFileSync(join(__dirname, 'fixtures/claude.jsonl'), 'utf8').split('\n');
  for (const l of lines) if (l.trim()) applyClaudeLine(acc, l);
  return claudeFields(acc);
}

describe('ClaudeAdapter', () => {
  it('fixture에서 전 필드 추출', () => {
    const f = loadFixture();
    expect(f.model).toBe('claude-fable-5');
    expect(f.mode).toBe('bypassPermissions');
    expect(f.topic).toBe('모니터 툴 설계');           // aiTitle 우선
    expect(f.cwd).toBe('/Users/dev/Desktop/CJI');
    expect(f.gitBranch).toBe('main');
    // 누적 = (10+100+5000+200) + (20+300+6000+100)
    expect(f.totalTokens).toBe(11730);
    // 컨텍스트 = 마지막 turn (20+6000+100+300)
    expect(f.contextTokens).toBe(6420);
    expect(f.contextWindow).toBe(1_000_000);          // fable-5 테이블
    expect(f.costUsd).toBeGreaterThan(0);
  });

  it('aiTitle 없으면 lastPrompt를 topic으로', () => {
    const acc = newClaudeAccum();
    applyClaudeLine(acc, JSON.stringify({ type: 'last-prompt', lastPrompt: '긴 프롬프트'.repeat(50) }));
    const f = claudeFields(acc);
    expect(f.topic!.length).toBeLessThanOrEqual(60);
  });

  it('깨진 라인은 false 반환, throw 없음', () => {
    const acc = newClaudeAccum();
    expect(applyClaudeLine(acc, '깨진 라인')).toBe(false);
    expect(applyClaudeLine(acc, '{"type":')).toBe(false);
  });

  it('문자열과 text 배열 content를 사용자 프롬프트로 감지 — 라인 timestamp를 lastPromptAt으로', () => {
    const T = 1_000_000_000_000;
    const timestamp = new Date(T).toISOString();
    for (const content of ['질문', [{ type: 'text', text: '질문' }]]) {
      const acc = newClaudeAccum();
      expect(applyClaudeLine(acc, JSON.stringify({ type: 'user', timestamp, message: { content } }))).toBe(true);
      expect(acc.lastPromptAt).toBe(T);
    }
  });

  it('tool_result 회신은 사용자 프롬프트에서 제외 (실작업으로는 기록됨)', () => {
    const acc = newClaudeAccum();
    const line = JSON.stringify({
      type: 'user', timestamp: new Date().toISOString(),
      message: { content: [{ type: 'tool_result', content: '결과' }] },
    });
    expect(applyClaudeLine(acc, line)).toBe(true); // lastWorkAt 갱신
    expect(acc.lastPromptAt).toBeUndefined();      // 하지만 턴 시작은 아님
  });

  it('isMeta 사용자 라인은 사용자 프롬프트에서 제외', () => {
    const acc = newClaudeAccum();
    const line = JSON.stringify({
      type: 'user', isMeta: true, timestamp: new Date().toISOString(), message: { content: '메타 정보' },
    });
    expect(applyClaudeLine(acc, line)).toBe(false);
    expect(acc.lastPromptAt).toBeUndefined();
  });

  it('lastWorkAt: assistant/tool_result/프롬프트만 실작업 — 메타·에코 라인은 제외', () => {
    const T = 1_000_000_000_000;
    const timestamp = new Date(T).toISOString();
    const work = [
      { type: 'assistant', timestamp, message: { content: [{ type: 'text', text: '응답' }] } },
      { type: 'user', timestamp, message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } },
      { type: 'user', timestamp, message: { content: '질문' } },
    ];
    for (const line of work) {
      const acc = newClaudeAccum();
      applyClaudeLine(acc, JSON.stringify(line));
      expect(acc.lastWorkAt).toBe(T);
    }
    const notWork = [
      { type: 'ai-title', aiTitle: '제목', timestamp },
      { type: 'user', isMeta: true, timestamp, message: { content: '메타' } },
      { type: 'user', timestamp, message: { content: '<command-name>/mcp</command-name>' } },
    ];
    for (const line of notWork) {
      const acc = newClaudeAccum();
      applyClaudeLine(acc, JSON.stringify(line));
      expect(acc.lastWorkAt).toBeUndefined();
    }
  });

  it('Esc 중단 마커는 턴 종료 — 프롬프트도 실작업도 아님 (Stop 훅 미발화 보완)', () => {
    const T = 1_000_000_000_000;
    const timestamp = new Date(T).toISOString();
    for (const content of [
      '[Request interrupted by user]',
      '[Request interrupted by user for tool use]',
      [{ type: 'text', text: '[Request interrupted by user]' }],
    ]) {
      const acc = newClaudeAccum();
      applyClaudeLine(acc, JSON.stringify({ type: 'user', timestamp, message: { content } }));
      expect(acc.lastInterruptAt).toBe(T);
      expect(acc.lastPromptAt).toBeUndefined();
      expect(acc.lastWorkAt).toBeUndefined();
    }
  });

  it('로컬 슬래시커맨드 에코는 사용자 프롬프트에서 제외 (모델 턴이 시작되지 않음)', () => {
    const timestamp = new Date().toISOString();
    for (const text of [
      '<command-name>/mcp</command-name>\n<command-message>mcp</command-message>',
      '<local-command-stdout>Authentication successful.</local-command-stdout>',
    ]) {
      for (const content of [text, [{ type: 'text', text }]]) {
        const acc = newClaudeAccum();
        applyClaudeLine(acc, JSON.stringify({ type: 'user', timestamp, message: { content } }));
        expect(acc.lastPromptAt).toBeUndefined();
      }
    }
  });
});
