import { describe, expect, it } from 'vitest';
import { fmtTokens, renderCards, renderShell } from '../src/render';
import type { SessionView } from '../src/types';

function view(over: Partial<SessionView>): SessionView {
  return {
    key: 'claude:a', agent: 'claude', sessionId: 'a', filePath: '/x',
    totalTokens: 0, contextTokens: 0, lastActivityAt: 0, lastEventAt: 0,
    mapping: 'none', status: 'idle', ...over,
  };
}

describe('fmtTokens', () => {
  it('천/백만 단위 축약', () => {
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(614_493)).toBe('614k');
    expect(fmtTokens(1_500_000)).toBe('1.5M');
  });
});

describe('renderCards', () => {
  it('카드에 핵심 필드 표시', () => {
    const html = renderCards([view({
      agent: 'claude', model: 'claude-fable-5', mode: 'bypassPermissions',
      topic: '모니터 설계', cwd: '/Users/dev/Desktop/CJI', gitBranch: 'main',
      totalTokens: 142_000, contextTokens: 480_000, contextWindow: 1_000_000,
      costUsd: 3.2, status: 'running', terminalName: 'zsh',
    })]);
    expect(html).toContain('claude');
    expect(html).toContain('claude-fable-5');
    expect(html).toContain('bypassPermissions');
    expect(html).toContain('모니터 설계');
    expect(html).toContain('142k');
    expect(html).toContain('48%');
    expect(html).toContain('$3.20');
    expect(html).toContain('data-key="claude:a"');
  });

  it('approval 카드는 강조 클래스', () => {
    expect(renderCards([view({ status: 'approval' })])).toContain('card approval');
  });

  it('HTML escape — topic의 태그가 그대로 출력되지 않음', () => {
    const html = renderCards([view({ topic: '<script>alert(1)</script>' })]);
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
  });

  it('서브에이전트를 부모 카드 안에 상태 라벨과 escape된 key로 표시', () => {
    const child = view({
      key: 'codex:b"&', agent: 'codex', sessionId: 'b', status: 'approval',
      model: '<gpt>', topic: '<작업>',
      children: [view({ key: 'claude:grandchild' })],
    });
    const html = renderCards([view({ children: [child] })]);
    expect(html).toContain('class="subagent approval"');
    expect(html).toContain('data-key="codex:b&quot;&amp;"');
    expect(html).toContain('⚠ Needs approval · codex · &lt;gpt&gt; · &lt;작업&gt;');
    expect(html).not.toContain('claude:grandchild'); // 1단계만 렌더
  });

  it('children 없는 카드는 서브에이전트 마크업을 만들지 않음', () => {
    expect(renderCards([view({})])).not.toContain('class="subagent');
  });

  it('빈 목록은 안내 문구', () => {
    expect(renderCards([])).toContain('No AI sessions detected');
  });

  it('주제 한 줄만: topic 우선, 없으면 터미널 이름 (중복 표시 없음)', () => {
    const both = renderCards([view({ topic: '명함 사진 자르기', terminalName: '✳ 명함 사진 자르기' })]);
    expect(both.match(/명함 사진 자르기/g)).toHaveLength(1); // 한 번만
    const fallback = renderCards([view({ terminalName: 'zsh — 작업A' })]);
    expect(fallback).toContain('zsh — 작업A'); // topic 없으면 터미널 이름
  });

  it('shell에 새 터미널 버튼 + newTerminal 메시지 핸들러', () => {
    const html = renderShell('nonce123', 'vscode-resource:');
    expect(html).toContain('id="newTerm"');
    expect(html).toContain('＋ New Terminal');
    expect(html).toContain("command: 'newTerminal'");
  });

  it('활성 터미널의 세션 카드에 active 클래스', () => {
    const html = renderCards(
      [view({ key: 'claude:a', shellPid: 600 }), view({ key: 'claude:b', sessionId: 'b', shellPid: 700 })],
      600,
    );
    expect(html).toContain('idle active'); // shellPid 600 카드만
    expect(html.match(/ active"/g) ?? []).toHaveLength(1);
    expect(renderCards([view({ shellPid: 600 })])).not.toContain(' active"'); // 활성 정보 없으면 없음
  });
});
