/**
 * 터미널 번호(#n) 배정 — vscode 의존 없음(테스트 가능). 사이드바가 상태를 소유한다(창 수명 동안 유지, reload 시 리셋).
 * 규칙: 번호는 shellPid 최초 등장 순으로 부여하고 재사용하지 않는다(OS pid 재사용이 옛 번호를 물려받지 않게).
 * 사라진 pid 는 삭제. 핀(관제 터미널)이 있으면 #1 을 예약 — 다른 터미널은 2 부터, 핀은 언제 나타나도 #1.
 */
export interface TermNoState {
  no: Map<number, number>; // shellPid → 번호
  next: number;            // 다음 새 번호
}

/**
 * @param alive   지금 보이는 shellPid 들(세션 카드 + 빈 터미널 행). 일회성 iterator 여도 된다
 * @param pinned  핀 터미널의 shellPid. alive 에 없으면 무시
 * @param reserveFirst 핀 설정이 켜져 있음 — #1 을 예약해 새 번호는 2 부터
 */
export function assignTermNumbers(
  state: TermNoState, alive: Iterable<number>, pinned: number | undefined, reserveFirst: boolean,
): void {
  const live = new Set(alive);
  for (const pid of [...state.no.keys()]) {
    if (!live.has(pid)) state.no.delete(pid);
  }
  if (reserveFirst && state.next < 2) state.next = 2;
  if (pinned !== undefined && live.has(pinned) && state.no.get(pinned) !== 1) {
    // 다른 pid 가 #1 을 쥐고 있으면(런타임에 설정을 켰거나 대상이 바뀜) 그쪽을 새 번호로 옮긴다 — "번호 유지" 의 유일한 예외
    for (const [pid, n] of state.no) {
      if (n === 1 && pid !== pinned) state.no.set(pid, state.next++);
    }
    state.no.set(pinned, 1);
  }
  for (const pid of live) {
    if (!state.no.has(pid)) state.no.set(pid, state.next++);
  }
}

/**
 * 핀 터미널의 shellPid 선택 — 이름이 같은 세션 카드(shellPid 있는 것) 우선, 없으면 빈 터미널 행. 둘 다 여럿이면 앞의 것.
 */
export function pickPinnedShellPid(
  name: string,
  cards: ReadonlyArray<{ terminalName?: string; shellPid?: number }>,
  terminals: ReadonlyArray<{ name?: string; shellPid: number }>,
): number | undefined {
  if (!name) return undefined;
  const card = cards.find((c) => c.terminalName === name && c.shellPid !== undefined);
  if (card) return card.shellPid;
  return terminals.find((t) => t.name === name)?.shellPid;
}
