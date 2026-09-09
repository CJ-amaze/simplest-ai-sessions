import { describe, expect, it } from 'vitest';
import { assignTermNumbers, pickPinnedShellPid } from '../src/termno';
import type { TermNoState } from '../src/termno';

const fresh = (): TermNoState => ({ no: new Map() });

describe('assignTermNumbers', () => {
  it('핀 없음: 등장 순 번호, 사라진 번호는 다음 새 pid 가 재사용(가장 작은 빈 번호), 기존 번호는 이동 없음', () => {
    const st = fresh();
    assignTermNumbers(st, [10, 20, 30], undefined, false);
    expect([...st.no]).toEqual([[10, 1], [20, 2], [30, 3]]);
    assignTermNumbers(st, [10, 30], undefined, false); // 20 사라짐 — 30 은 3 그대로(당기지 않음)
    expect([...st.no]).toEqual([[10, 1], [30, 3]]);
    assignTermNumbers(st, [10, 30, 40], undefined, false); // 새 pid 는 빈 2 를 채운다
    expect(st.no.get(40)).toBe(2);
    assignTermNumbers(st, [10, 30, 40, 50], undefined, false); // 빈자리 없으면 다음 번호
    expect(st.no.get(50)).toBe(4);
  });
  it('여러 새 pid 는 등장 순으로 빈 번호를 차례로 채운다', () => {
    const st = fresh();
    assignTermNumbers(st, [10, 20, 30, 40], undefined, false);
    assignTermNumbers(st, [40], undefined, false); // 1·2·3 빈자리
    assignTermNumbers(st, [40, 50, 60], undefined, false);
    expect(st.no.get(50)).toBe(1);
    expect(st.no.get(60)).toBe(2);
    expect(st.no.get(40)).toBe(4);
  });
  it('핀 설정 켜짐: #1 예약 — 핀이 아직 없으면 남들은 2 부터, 핀이 나중에 나타나면 1', () => {
    const st = fresh();
    assignTermNumbers(st, [10, 20], undefined, true);
    expect([...st.no]).toEqual([[10, 2], [20, 3]]);
    assignTermNumbers(st, [10, 20, 99], 99, true);
    expect(st.no.get(99)).toBe(1);
    expect(st.no.get(10)).toBe(2);
  });
  it('핀 설정 켜짐: 빈 번호 재사용도 2 부터 (1 은 핀 전용)', () => {
    const st = fresh();
    assignTermNumbers(st, [10, 20, 30], undefined, true); // 2,3,4
    assignTermNumbers(st, [10, 30], undefined, true);     // 3 빔
    assignTermNumbers(st, [10, 30, 40], undefined, true);
    expect(st.no.get(40)).toBe(3);
    assignTermNumbers(st, [30, 40, 50], undefined, true); // 10(#2) 사라짐 → 50 은 2
    expect(st.no.get(50)).toBe(2);
    expect(st.no.has(1)).toBe(false);
    expect([...st.no.values()].includes(1)).toBe(false);
  });
  it('런타임에 설정을 켜서 다른 pid 가 #1 이면 그쪽을 가장 작은 빈 번호로 옮기고 핀에 1', () => {
    const st = fresh();
    assignTermNumbers(st, [10, 20], undefined, false); // 10=1, 20=2
    assignTermNumbers(st, [10, 20, 99], 99, true);
    expect(st.no.get(99)).toBe(1);
    expect(st.no.get(10)).toBe(3);
    expect(st.no.get(20)).toBe(2);
  });
  it('핀 대상이 바뀌면(A→B) B 가 1, A 는 B 가 놓은 번호(가장 작은 빈 번호) — 빈자리 없음', () => {
    const st = fresh();
    assignTermNumbers(st, [10, 20], 10, true); // 10=1, 20=2
    assignTermNumbers(st, [10, 20], 20, true);
    expect(st.no.get(20)).toBe(1);
    expect(st.no.get(10)).toBe(2);
  });
  it('핀이 alive 에 없으면 무시, 설정을 꺼도 기존 번호 유지', () => {
    const st = fresh();
    assignTermNumbers(st, [10], 99, true);
    expect([...st.no]).toEqual([[10, 2]]);
    assignTermNumbers(st, [10], undefined, false);
    expect(st.no.get(10)).toBe(2);
  });
  it('핀은 있는데 reserveFirst 가 꺼진 조합에서도 #1 이 중복되지 않는다 (codex 리뷰)', () => {
    const st = fresh();
    assignTermNumbers(st, [10, 20], 10, false);
    expect([...st.no]).toEqual([[10, 1], [20, 2]]);
    assignTermNumbers(st, [10, 20, 30], 10, false); // 핀이 1 을 쥐고 있으면 새 pid 는 1 을 못 받는다
    expect(st.no.get(30)).toBe(3);
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
