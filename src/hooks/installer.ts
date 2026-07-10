import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const MARKER = '# agent-monitor notify (managed by AI Sessions - do not edit)';

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}

function hasOurEntry(entries: HookEntry[] | undefined, scriptPath: string): boolean {
  return (entries ?? []).some((e) => (e.hooks ?? []).some((h) => h.command?.includes(scriptPath)));
}

export function mergeClaudeSettings(json: string, scriptPath: string): { changed: boolean; result: string } {
  if (!scriptPath) return { changed: false, result: json };
  const obj = JSON.parse(json || '{}') as Record<string, unknown>;
  const hooks = (obj.hooks ?? {}) as Record<string, HookEntry[]>;
  let changed = false;
  for (const [event, kind] of [['Notification', 'notification'], ['Stop', 'stop']] as const) {
    if (!hasOurEntry(hooks[event], scriptPath)) {
      hooks[event] = [
        ...(hooks[event] ?? []),
        { hooks: [{ type: 'command', command: `"${scriptPath}" claude ${kind}` }] },
      ];
      changed = true;
    }
  }
  if (!changed) return { changed: false, result: json };
  obj.hooks = hooks;
  return { changed: true, result: JSON.stringify(obj, null, 2) };
}

/** settings.json에 statusLine 연동 추가 — 기존 statusLine이 있으면 건드리지 않음(conflict) */
export function mergeStatusLine(
  json: string, scriptPath: string,
): { changed: boolean; result: string; conflict?: string } {
  if (!scriptPath) return { changed: false, result: json };
  const obj = JSON.parse(json || '{}') as Record<string, unknown>;
  const cur = obj.statusLine as { command?: string } | undefined;
  if (cur) {
    if (cur.command?.includes(scriptPath)) return { changed: false, result: json };
    return { changed: false, result: json, conflict: `기존 statusLine 존재: ${String(cur.command ?? '')}` };
  }
  obj.statusLine = { type: 'command', command: `"${scriptPath}"` };
  return { changed: true, result: JSON.stringify(obj, null, 2) };
}

export function removeStatusLine(json: string, scriptPath: string): { changed: boolean; result: string } {
  if (!scriptPath) return { changed: false, result: json };
  const obj = JSON.parse(json || '{}') as Record<string, unknown>;
  const cur = obj.statusLine as { command?: string } | undefined;
  if (!cur?.command?.includes(scriptPath)) return { changed: false, result: json };
  delete obj.statusLine;
  return { changed: true, result: JSON.stringify(obj, null, 2) };
}

export function removeClaudeHooks(json: string, scriptPath: string): { changed: boolean; result: string } {
  if (!scriptPath) return { changed: false, result: json };
  const obj = JSON.parse(json || '{}') as Record<string, unknown>;
  const hooks = (obj.hooks ?? {}) as Record<string, HookEntry[]>;
  let changed = false;
  for (const event of Object.keys(hooks)) {
    // 내부 hooks 레벨에서 자기 command만 제거 — entry를 통째로 지우면
    // [ours, other-tool]처럼 혼합된 entry에서 타 도구 hook까지 삭제됨
    hooks[event] = hooks[event]
      .map((e) => {
        if (!e.hooks) return e;
        const kept = e.hooks.filter((h) => !h.command?.includes(scriptPath));
        if (kept.length !== e.hooks.length) changed = true;
        return { ...e, hooks: kept };
      })
      .filter((e) => e.hooks === undefined || e.hooks.length > 0);
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (!changed) return { changed: false, result: json };
  obj.hooks = hooks;
  return { changed: true, result: JSON.stringify(obj, null, 2) };
}

// 완전한 스탠드얼론 테이블 헤더 라인만 인정 ([section] / [[array_of_tables]], 뒤에 주석 허용).
// 멀티라인 배열 연속 라인(`[1,2],`)은 콤마로 끝나 불일치.
const HEADER_LINE_RE = /^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$/;

/**
 * TOML root 키 영역(첫 "진짜" 테이블 헤더 이전)의 끝 문자 오프셋을 반환.
 * 헤더가 없으면 toml.length(전체가 root).
 *
 * 대괄호 깊이를 함께 추적해, root 영역의 멀티라인 배열 리터럴(예: `matrix = [\n[1,2],\n[3,4]\n]`)
 * 안에 있는 `[3,4]` 같은 연속 라인이 헤더 정규식과 우연히 일치해도 헤더로 오인하지 않는다
 * (배열이 열려 있는 동안(depth > 0)에는 헤더 판정을 건너뜀).
 */
function findRootEnd(toml: string): number {
  const lines = toml.split('\n');
  let depth = 0;
  let offset = 0;
  for (const line of lines) {
    if (depth === 0 && HEADER_LINE_RE.test(line)) return offset;
    // 주석(#...)과 따옴표 문자열 내부의 대괄호는 depth 계산에서 제외
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === '\\' && quote === '"') { i++; continue; } // \" 이스케이프(기본 문자열만)
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '#') break; // 나머지는 주석
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') depth = Math.max(0, depth - 1);
    }
    offset += line.length + 1; // +1: split 시 소비된 '\n'
  }
  return toml.length;
}

export function mergeCodexConfig(
  toml: string, scriptPath: string,
): { changed: boolean; result: string; conflict?: string } {
  if (!scriptPath) return { changed: false, result: toml };
  const rootEnd = findRootEnd(toml);
  const root = toml.slice(0, rootEnd);
  const existing = root.match(/^\s*notify\s*=.*$/m);
  if (existing) {
    if (existing[0].includes(scriptPath)) return { changed: false, result: toml };
    return { changed: false, result: toml, conflict: `기존 notify 설정 존재: ${existing[0].trim()}` };
  }
  const insert = `${MARKER}\nnotify = ["${scriptPath}", "codex"]\n`;
  let result: string;
  if (rootEnd < toml.length) {
    result = `${toml.slice(0, rootEnd)}${insert}\n${toml.slice(rootEnd)}`;
  } else {
    result = toml.length > 0 && !toml.endsWith('\n') ? `${toml}\n${insert}` : `${toml}${insert}`;
  }
  return { changed: true, result };
}

export function removeCodexNotify(toml: string, scriptPath: string): { changed: boolean; result: string } {
  if (!scriptPath) return { changed: false, result: toml };
  const rootEnd = findRootEnd(toml);
  const lines = toml.split('\n');
  const out: string[] = [];
  let changed = false;
  let offset = 0;
  for (const line of lines) {
    const inRoot = offset < rootEnd;
    offset += line.length + 1;
    if (inRoot && line.includes(MARKER)) { changed = true; continue; }
    if (inRoot && /^\s*notify\s*=/.test(line) && line.includes(scriptPath)) { changed = true; continue; }
    out.push(line);
  }
  return { changed, result: changed ? out.join('\n').replace(/\n{3,}/g, '\n\n') : toml };
}

/** ENOENT만 null(새 파일) — 그 외 오류는 설정 파괴 방지를 위해 그대로 던진다 */
async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const bak = `${filePath}.agent-monitor.bak`;
  const orig = await readIfExists(filePath);
  if (orig !== null && !(await fs.stat(bak).catch(() => null))) {
    await fs.writeFile(bak, orig);
  }
  const tmp = `${filePath}.agent-monitor.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, filePath);
}

export function shimPath(homeDir: string): string {
  return join(homeDir, '.vscode-agent-monitor', 'hook.sh');
}

export function statusShimPath(homeDir: string): string {
  return join(homeDir, '.vscode-agent-monitor', 'statusline.sh');
}

/** 번들 스크립트 내용을 고정 경로 shim에 (재)기록 — 설정 파일은 항상 이 경로를 참조 */
export async function writeShim(homeDir: string, content: string): Promise<string> {
  const p = shimPath(homeDir);
  await fs.mkdir(join(homeDir, '.vscode-agent-monitor'), { recursive: true });
  await fs.writeFile(p, content, { mode: 0o755 });
  return p;
}

export async function installHooks(
  homeDir: string, scriptPath: string, statusScriptPath?: string,
): Promise<{ claude: string; codex: string; statusline: string }> {
  if (!scriptPath) {
    return { claude: 'error:empty scriptPath', codex: 'error:empty scriptPath', statusline: 'skipped' };
  }
  const out = { claude: 'error:unknown', codex: 'error:unknown', statusline: 'skipped' };
  // claude
  try {
    const p = join(homeDir, '.claude', 'settings.json');
    const cur = (await readIfExists(p)) ?? '{}';
    const r = mergeClaudeSettings(cur, scriptPath);
    if (r.changed) {
      await fs.mkdir(join(homeDir, '.claude'), { recursive: true });
      await atomicWrite(p, r.result);
      out.claude = 'installed';
    } else out.claude = 'already';
    // statusLine — 세션별 model/effort 표시용 (기존 statusLine이 있으면 건드리지 않음)
    if (statusScriptPath) {
      const cur2 = (await readIfExists(p)) ?? '{}';
      const sr = mergeStatusLine(cur2, statusScriptPath);
      if (sr.conflict) out.statusline = 'conflict';
      else if (sr.changed) {
        await atomicWrite(p, sr.result);
        out.statusline = 'installed';
      } else out.statusline = 'already';
    }
  } catch (e) {
    out.claude = `error:${String(e)}`;
  }
  // codex
  try {
    const p = join(homeDir, '.codex', 'config.toml');
    const cur = (await readIfExists(p)) ?? '';
    const r = mergeCodexConfig(cur, scriptPath);
    if (r.conflict) out.codex = 'conflict';
    else if (r.changed) {
      await fs.mkdir(join(homeDir, '.codex'), { recursive: true });
      await atomicWrite(p, r.result);
      out.codex = 'installed';
    } else out.codex = 'already';
  } catch (e) {
    out.codex = `error:${String(e)}`;
  }
  return out;
}

export async function removeHooks(homeDir: string, scriptPath: string): Promise<void> {
  if (!scriptPath) return;
  const cp = join(homeDir, '.claude', 'settings.json');
  const cur = await readIfExists(cp);
  if (cur !== null) {
    const r = removeClaudeHooks(cur, scriptPath);
    if (r.changed) await atomicWrite(cp, r.result);
    const cur2 = await readIfExists(cp);
    if (cur2 !== null) {
      const sr = removeStatusLine(cur2, statusShimPath(homeDir));
      if (sr.changed) await atomicWrite(cp, sr.result);
    }
  }
  const xp = join(homeDir, '.codex', 'config.toml');
  const cur2 = await readIfExists(xp);
  if (cur2 !== null) {
    const r = removeCodexNotify(cur2, scriptPath);
    if (r.changed) await atomicWrite(xp, r.result);
  }
}
