import * as vscode from 'vscode';
import { renderCards, renderShell } from './render';
import type { StateStore } from './store';

export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'aiSessions.sidebar';
  private view?: vscode.WebviewView;
  private activeShellPid?: number;

  constructor(
    private store: StateStore,
    private onFocus: (key: string) => void,
    private onNewTerminal: () => void,
  ) {}

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
    });
    this.refresh();
  }

  refresh(): void {
    if (!this.view) return;
    const views = this.store.list(Date.now());
    void this.view.webview.postMessage({ html: renderCards(views, this.activeShellPid) });
    // 서브에이전트(children)의 승인대기도 뱃지에 포함
    const flat = views.flatMap((v) => [v, ...(v.children ?? [])]);
    const approvals = flat.filter((v) => v.status === 'approval').length;
    this.view.badge =
      approvals > 0 ? { value: approvals, tooltip: `${approvals} pending approval(s)` } : undefined;
  }
}
