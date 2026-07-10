import { homedir } from 'node:os';
import type { SessionView } from './types';

const ESC: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function shortPath(p: string | undefined): string {
  if (!p) return '';
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

const STATUS_LABEL: Record<string, string> = {
  approval: '⚠ Needs approval', running: '● Working', idle: '○ Idle', exited: '✕ Exited',
};

export function renderCards(sessions: SessionView[], activeShellPid?: number): string {
  if (sessions.length === 0) {
    return '<div class="empty">No AI sessions detected<br/>Run claude or codex in a terminal</div>';
  }
  return sessions
    .map((s) => {
      const pct =
        s.contextWindow && s.contextTokens
          ? Math.min(100, Math.round((s.contextTokens / s.contextWindow) * 100))
          : undefined;
      const cost = s.costUsd !== undefined ? `$${s.costUsd.toFixed(2)}` : '–';
      const meta2 = [shortPath(s.cwd), s.gitBranch ? `(${s.gitBranch})` : '']
        .filter(Boolean).join(' ');
      const children = (s.children ?? []).map((child) =>
        `  <div class="subagent ${esc(child.status)}" data-key="${esc(child.key)}">└ ${STATUS_LABEL[child.status]} · ${esc(child.model ?? child.agent)} · ${esc(child.topic ?? '')}</div>`,
      ).join('\n');
      // 현재 활성(선택된) 터미널의 세션 카드 강조
      const isActive = activeShellPid !== undefined && s.shellPid === activeShellPid;
      // 주제는 한 줄만: ai-title(topic) 우선, 없으면 터미널 이름 (같은 내용 중복 표시 방지)
      const title = s.topic ?? s.terminalName ?? (s.mapping === 'none' ? 'external terminal' : '');
      return `<div class="card ${s.status}${s.status === 'exited' ? ' dim' : ''}${isActive ? ' active' : ''}" data-key="${esc(s.key)}">
  <div class="row1"><span class="status">${STATUS_LABEL[s.status]}</span>
    <span class="model">${esc(s.model ?? s.agent)}</span></div>
  <div class="row2">${esc(s.mode ?? '')}${s.pid !== undefined ? ` · pid ${s.pid}` : ''}</div>
  <div class="topic">${esc(title)}</div>
  <div class="row3">${esc(meta2)}</div>
  <div class="row4">${fmtTokens(s.totalTokens)} tok${pct !== undefined ? ` · <span class="bar"><span style="width:${pct}%"></span></span> ${pct}%` : ''} · ${cost}</div>${children ? `\n${children}` : ''}
</div>`;
    })
    .join('\n');
}

export function renderShell(nonce: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 4px;
  margin: 0; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
#root { flex: 1; overflow-y: auto; }
#newTerm { flex: none; width: 100%; margin-top: 6px; padding: 6px 0; border: 1px dashed var(--vscode-panel-border);
  border-radius: 6px; background: transparent; color: var(--vscode-foreground); opacity: 0.8;
  cursor: pointer; font-family: inherit; font-size: 0.9em; }
#newTerm:hover { opacity: 1; background: var(--vscode-list-hoverBackground);
  border-color: var(--vscode-focusBorder); border-style: solid; }
.empty { opacity: 0.6; text-align: center; padding: 24px 8px; line-height: 1.7; }
.card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px 10px;
  margin-bottom: 8px; cursor: pointer; background: var(--vscode-sideBar-background); }
.card:hover { background: var(--vscode-list-hoverBackground); }
.card.approval { border-color: var(--vscode-inputValidation-warningBorder);
  background: var(--vscode-inputValidation-warningBackground); }
.card.active { border-color: var(--vscode-focusBorder);
  background: var(--vscode-list-activeSelectionBackground);
  box-shadow: inset 3px 0 0 var(--vscode-focusBorder); }
.card.dim { opacity: 0.45; }
.row1 { font-weight: 600; margin-bottom: 2px; }
.row1 .status { margin-right: 6px; }
.card.approval .status { color: var(--vscode-editorWarning-foreground); }
.card.running .status { color: var(--vscode-charts-green); }
.row2, .row3 { font-size: 0.85em; opacity: 0.85; }
.topic { margin: 3px 0; font-size: 0.95em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row4 { font-size: 0.85em; margin-top: 3px; opacity: 0.9; }
.subagent { font-size: 0.85em; border-left: 2px solid var(--vscode-panel-border);
  padding-left: 8px; margin-top: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.subagent:hover { background: var(--vscode-list-hoverBackground); }
.subagent.approval { color: var(--vscode-editorWarning-foreground);
  border-left-color: var(--vscode-inputValidation-warningBorder); }
.subagent.running { color: var(--vscode-charts-green); }
.bar { display: inline-block; width: 40px; height: 6px; border-radius: 3px;
  background: var(--vscode-input-background, #444); position: relative; vertical-align: middle; overflow: hidden; }
.bar > span { display: block; height: 100%; border-radius: 3px;
  background: var(--vscode-charts-blue, #4a90d9); }
</style>
</head><body>
<div id="root"></div>
<button id="newTerm" title="Open a new terminal to start a session">＋ New Terminal</button>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
window.addEventListener('message', (e) => {
  if (e.data && typeof e.data.html === 'string') {
    document.getElementById('root').innerHTML = e.data.html;
  }
});
document.addEventListener('click', (e) => {
  const card = e.target.closest('[data-key]');
  if (card) vscode.postMessage({ command: 'focus', key: card.dataset.key });
});
document.getElementById('newTerm').addEventListener('click', () => {
  vscode.postMessage({ command: 'newTerminal' });
});
</script>
</body></html>`;
}
