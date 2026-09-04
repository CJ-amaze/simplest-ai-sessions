import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { EVENTS_DIR, TERMNO_FILE } from './hooks/events';
import { renderCards, renderShell } from './render';
import type { PlainTerminal } from './render';
import type { StateStore } from './store';

export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'aiSessions.sidebar';
  private view?: vscode.WebviewView;
  private activeShellPid?: number;
  private terminals: PlainTerminal[] = [];
  // 터미널 번호: shellPid 최초 등장 순서로 부여, 창이 사는 동안 고정.
  // 사라진 pid 는 다음 렌더에서 폐기한다 — OS 의 pid 재사용이 옛 번호를
  // 물려주지 않게 (codex 리뷰). 리로드 시 1부터 다시 시작(허용).
  private termNo = new Map<number, number>();
  private termNoNext = 1;
  private lastTermNoJson?: string;

  constructor(
    private store: StateStore,
    private onFocus: (key: string) => void,
    private onNewTerminal: () => void,
    private onFocusShell: (shellPid: number) => void,
  ) {}

  /** 세션이 붙지 않은 일반 터미널 목록 — 하단에 행으로 표시 */
  setTerminals(terms: PlainTerminal[]): void {
    const same = terms.length === this.terminals.length &&
      terms.every((t, i) => t.shellPid === this.terminals[i].shellPid && t.name === this.terminals[i].name);
    if (same) return;
    this.terminals = terms;
    this.refresh();
  }

  /** 현재 활성 터미널의 shell pid — 해당 세션 카드 강조용 */
  setActiveShellPid(pid: number | undefined): void {
    if (this.activeShellPid === pid) return;
    this.activeShellPid = pid;
    this.refresh();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    const nonce = Math.random().toString(36).slice(2);
    view.webview.html = renderShell(nonce, view.webview.cspSource);
    view.webview.onDidReceiveMessage((msg) => {
      if (msg?.command === 'focus' && typeof msg.key === 'string') this.onFocus(msg.key);
      if (msg?.command === 'newTerminal') this.onNewTerminal();
      if (msg?.command === 'focusTerm' && typeof msg.shellPid === 'number') this.onFocusShell(msg.shellPid);
    });
    this.refresh();
  }

  refresh(): void {
    const views = this.store.list(Date.now());
    // 번호 배정/폐기 — 현재 보이는 shellPid(세션 카드 + 일반 터미널 행)만 살린다
    const alive = new Set<number>();
    for (const v of views) if (v.shellPid !== undefined) alive.add(v.shellPid);
    for (const t of this.terminals) alive.add(t.shellPid);
    for (const pid of alive) {
      if (!this.termNo.has(pid)) this.termNo.set(pid, this.termNoNext++);
    }
    for (const pid of [...this.termNo.keys()]) {
      if (!alive.has(pid)) this.termNo.delete(pid);
    }

    // 소비자: ~/.claude/widget-ding.sh (책상 위젯 뱃지).
    // 여러 VS Code 창에서는 마지막 writer가 이긴다(문서화된 제한).
    try {
      const map: Record<string, number> = {};
      for (const v of views) {
        if (v.shellPid === undefined || !this.termNo.has(v.shellPid)) continue;
        const n = this.termNo.get(v.shellPid)!;
        map[v.sessionId] = n;
        for (const c of v.children ?? []) map[c.sessionId] = n;
      }
      const json = JSON.stringify(map);
      if (json !== this.lastTermNoJson) {
        mkdirSync(EVENTS_DIR, { recursive: true });
        const tmp = TERMNO_FILE + '.tmp-' + process.pid;
        writeFileSync(tmp, json);
        renameSync(tmp, TERMNO_FILE);
        this.lastTermNoJson = json;
      }
    } catch {
      // 내보내기 실패는 refresh에 영향을 주지 않는다.
    }

    if (!this.view) return;
    void this.view.webview.postMessage({
      html: renderCards(views, this.activeShellPid, this.terminals, this.termNo),
    });
    // 서브에이전트(children)의 승인대기도 뱃지에 포함
    const flat = views.flatMap((v) => [v, ...(v.children ?? [])]);
    const approvals = flat.filter((v) => v.status === 'approval').length;
    this.view.badge =
      approvals > 0 ? { value: approvals, tooltip: `${approvals} pending approval(s)` } : undefined;
  }
}
