import { describe, expect, it } from 'vitest';
import { assignTermNumbers, pickPinnedShellPid } from '../src/termno';
import type { TermNoState } from '../src/termno';

const fresh = (): TermNoState => ({ no: new Map(), next: 1 });

describe('assignTermNumbers', () => {
  it('핀 없음: 등장 순 번호, 사라지면 삭제, 번호 재사용 없음 (기존 동작)', () => {
    const st = fresh();
    assignTermNumbers(st, [10, 20], undefined, false);
    expect([...st.no]).toEqual([[10, 1], [20, 2]]);
    assignTermNumbers(st, [20, 30], undefined, false);
    expect([...st.no]).toEqual([[20, 2], [30, 3]]);
    assignTermNumbers(st, [20, 30, 10], undefined, false); // 10 이 돌아와도 옛 1 이 아니라 새 번호
    expect(st.no.get(10)).toBe(4);
  });
  it('핀 설정 켜짐: #1 예약 — 핀이 아직 없으면 남들은 2 부터, 핀이 나중에 나타나면 1', () => {
    const st = fresh();
    assignTermNumbers(st, [10, 20], undefined, true);
    expect([...st.no]).toEqual([[10, 2], [20, 3]]);
    assignTermNumbers(st, [10, 20, 99], 99, true);
    expect(st.no.get(99)).toBe(1);
    expect(st.no.get(10)).toBe(2);
  });
  it('런타임에 설정을 켜서 다른 pid 가 #1 이면 그쪽을 새 번호로 옮기고 핀에 1', () => {
    const st = fresh();
    assignTermNumbers(st, [10, 20], undefined, false); // 10=1, 20=2
    assignTermNumbers(st, [10, 20, 99], 99, true);
    expect(st.no.get(99)).toBe(1);
    expect(st.no.get(10)).toBe(3);
    expect(st.no.get(20)).toBe(2);
  });
  it('핀 대상이 바뀌면(A→B) A 는 새 번호, B 가 1', () => {
    const st = fresh();
    assignTermNumbers(st, [10, 20], 10, true); // 10=1, 20=2
    assignTermNumbers(st, [10, 20], 20, true);
    expect(st.no.get(20)).toBe(1);
    expect(st.no.get(10)).toBe(3);
  });
  it('핀이 alive 에 없으면 무시, 설정을 꺼도 기존 번호 유지', () => {
    const st = fresh();
    assignTermNumbers(st, [10], 99, true);
    expect([...st.no]).toEqual([[10, 2]]);
    assignTermNumbers(st, [10], undefined, false);
    expect(st.no.get(10)).toBe(2);
  });
  it('일회성 iterator 입력도 동작', () => {
    const st = fresh();
    assignTermNumbers(st, new Set([10, 20]).values(), 20, true);
    expect(st.no.get(20)).toBe(1);
    expect(st.no.get(10)).toBe(2);
  });
});

describe('pickPinnedShellPid', () => {
  it('이름이 같은 세션 카드(shellPid 있음) 우선, 없으면 빈 터미널 행, 이름 비면 undefined', () => {
    const cards = [{ terminalName: 'cji-main' }, { terminalName: 'cji-main', shellPid: 7 }, { terminalName: 'x', shellPid: 8 }];
    const terms = [{ name: 'cji-main', shellPid: 9 }];
    expect(pickPinnedShellPid('cji-main', cards, terms)).toBe(7);
    expect(pickPinnedShellPid('cji-main', [{ terminalName: 'cji-main' }], terms)).toBe(9);
    expect(pickPinnedShellPid('cji-main', [], [])).toBeUndefined();
    expect(pickPinnedShellPid('', cards, terms)).toBeUndefined();
  });
});
