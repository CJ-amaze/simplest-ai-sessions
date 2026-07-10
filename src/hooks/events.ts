import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HookEvent } from '../types';

export const EVENTS_DIR = join(homedir(), '.vscode-agent-monitor');
export const EVENTS_FILE = join(EVENTS_DIR, 'events.jsonl');

const AGENTS = new Set(['claude', 'codex']);
const KINDS = new Set(['notification', 'stop', 'approval', 'turn-complete', 'idle']);

export function parseHookEventLine(line: string): HookEvent | null {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  if (typeof d.agent !== 'string' || !AGENTS.has(d.agent)) return null;
  if (typeof d.kind !== 'string' || !KINDS.has(d.kind)) return null;
  if (typeof d.observedAt !== 'number') return null;
  return {
    agent: d.agent as HookEvent['agent'],
    kind: d.kind as HookEvent['kind'],
    sessionId: typeof d.sessionId === 'string' && d.sessionId.length > 0 ? d.sessionId : undefined,
    pid: typeof d.pid === 'number' && d.pid > 0 ? d.pid : undefined,
    observedAt: d.observedAt,
  };
}
