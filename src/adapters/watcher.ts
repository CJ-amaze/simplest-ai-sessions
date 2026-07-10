import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { applyClaudeLine, claudeFields, newClaudeAccum } from './claude';
import { applyCodexLine, codexFields, newCodexAccum } from './codex';
import type { TailReader } from '../tail';
import type { AgentKind, SessionFields, SessionPatch } from '../types';
import type { ClaudeAccum } from './claude';
import type { CodexAccum } from './codex';

export const RECENT_WINDOW_MS = 24 * 3600_000;
export const BOOTSTRAP_BYTES = 256 * 1024;

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

export interface AdapterSpec {
  agent: AgentKind;
  listFiles(): Promise<string[]>;
  sessionIdFromPath(p: string): string | null;
  createAccum(): unknown;
  applyLine(acc: unknown, line: string): boolean;
  /** 턴/승인 신호는 라인 자체 timestamp로 필드화 — 부트스트랩 replay에서도 실제 시각이
   *  보존되므로(과거 승인은 TTL로 소멸, 진행 중 턴은 복원) 별도 소거가 필요 없음 */
  toFields(acc: unknown, eventTime: number): SessionFields;
}

async function recentFiles(dir: string, filter: (name: string) => boolean): Promise<string[]> {
  const entries = await fs.readdir(dir).catch(() => []);
  const out: string[] = [];
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  for (const name of entries) {
    if (!filter(name)) continue;
    const p = join(dir, name);
    const st = await fs.stat(p).catch(() => null);
    if (st?.isFile() && st.mtimeMs > cutoff) out.push(p);
  }
  return out;
}

export function claudeSpec(root = join(homedir(), '.claude', 'projects')): AdapterSpec {
  return {
    agent: 'claude',
    async listFiles() {
      const dirs = await fs.readdir(root).catch(() => []);
      const out: string[] = [];
      for (const d of dirs) {
        out.push(...(await recentFiles(join(root, d), (n) => n.endsWith('.jsonl'))));
      }
      return out;
    },
    sessionIdFromPath(p) {
      const m = basename(p).match(UUID_RE);
      return m ? m[1] : null;
    },
    createAccum: newClaudeAccum,
    applyLine: (acc, line) => applyClaudeLine(acc as ClaudeAccum, line),
    toFields(acc) {
      const a = acc as ClaudeAccum;
      const fields = claudeFields(a);
      // 턴 열림 증거 중 최신 시각: 사용자 프롬프트 or 미완결 tool_use (긴 턴에서 프롬프트가
      // 부트스트랩 창 밖으로 밀려나도 tail의 미완결 tool_use가 턴을 복원함)
      const pendingAt = a.pendingTools.size > 0 ? a.lastToolUseAt : undefined;
      const t = Math.max(a.lastPromptAt ?? 0, pendingAt ?? 0);
      fields.turnStartedAt = t > 0 ? t : undefined;
      fields.lastWorkAt = a.lastWorkAt;
      fields.stoppedAt = a.lastInterruptAt; // Esc 중단 = 턴 종료 (Stop 훅 미발화 보완)
      return fields;
    },
  };
}

export function codexSpec(root = join(homedir(), '.codex', 'sessions')): AdapterSpec {
  return {
    agent: 'codex',
    async listFiles() {
      // 오늘 + 어제 날짜 디렉토리만 스캔 (YYYY/MM/DD)
      const out: string[] = [];
      for (const daysAgo of [0, 1]) {
        const d = new Date(Date.now() - daysAgo * 86_400_000);
        const dir = join(root, String(d.getFullYear()),
          String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
        out.push(...(await recentFiles(dir, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))));
      }
      return out;
    },
    sessionIdFromPath(p) {
      const m = basename(p).match(UUID_RE);
      return m ? m[1] : null;
    },
    createAccum: newCodexAccum,
    applyLine: (acc, line) => applyCodexLine(acc as CodexAccum, line),
    toFields(acc) {
      const a = acc as CodexAccum;
      const fields: SessionFields = codexFields(a);
      // 라인 timestamp 그대로 — 배치 내 complete→started 순서도 실제 시각으로 판별되고
      // (stoppedAt < turnStartedAt → 턴 열림), 과거 approval은 status의 TTL·활동 가드가 걸러냄
      fields.turnStartedAt = a.turnStartedAtMs;
      fields.stoppedAt = a.turnCompletedAtMs;
      fields.approvalAt = a.approvalAtMs;
      fields.lastWorkAt = a.lastWorkAt;
      return fields;
    },
  };
}

export class AdapterWatcher {
  private accums = new Map<string, unknown>();

  constructor(
    private spec: AdapterSpec,
    private tail: TailReader,
    private onPatch: (p: SessionPatch) => void,
  ) {}

  async scan(now: number): Promise<void> {
    const files = await this.spec.listFiles();
    // listFiles()가 스캔 범위(codex: 오늘+어제 디렉토리)를 벗어나도, 이미 추적 중이던 파일은
    // 디스크에 남아있는 한 계속 스캔 대상에 포함 — 장기 세션이 tail에서 이탈하지 않도록 (F4)
    const seen = new Set(files);
    for (const tracked of [...this.accums.keys()]) {
      if (seen.has(tracked)) continue;
      const st = await fs.stat(tracked).catch(() => null);
      if (st) {
        files.push(tracked);
      } else {
        // 파일이 사라짐 — 추적 상태 정리
        this.accums.delete(tracked);
        this.tail.forget(tracked);
      }
    }
    for (const f of files) {
      const sid = this.spec.sessionIdFromPath(f);
      if (!sid) continue;
      const isNew = !this.accums.has(f);
      if (isNew) this.accums.set(f, this.spec.createAccum());
      const { lines, reset } = await this.tail.readNewLines(f, { bootstrapBytes: BOOTSTRAP_BYTES });
      const st = await fs.stat(f).catch(() => null);
      const eventTime = st?.mtimeMs ?? now;
      if (reset) {
        // 파일 truncate/교체 — 누적값(토큰 합산 등)이 중복되지 않도록 accumulator 재생성
        this.accums.set(f, this.spec.createAccum());
      }
      const acc = this.accums.get(f)!;
      let changed = false;
      for (const ln of lines) changed = this.spec.applyLine(acc, ln) || changed;
      if (!changed && !isNew && !reset) {
        // 파서가 모르는 라인이라도 append 자체는 활동 신호 — 최소 patch로 lastActivityAt만 갱신
        // (완전 무음이면 running 세션이 idle로 오판됨)
        if (lines.length > 0) {
          this.onPatch({
            agent: this.spec.agent, sessionId: sid, filePath: f, fields: { lastActivityAt: eventTime },
          });
        }
        continue;
      }
      this.onPatch({
        agent: this.spec.agent,
        sessionId: sid,
        filePath: f,
        fields: { ...this.spec.toFields(acc, eventTime), lastActivityAt: eventTime },
      });
    }
  }
}
