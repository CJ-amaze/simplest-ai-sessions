import { estimateClaudeCostUsd, lookupModel } from '../models';
import type { SessionFields } from '../types';

const TOPIC_MAX = 60;

export interface ClaudeAccum {
  model?: string;
  mode?: string;
  sessionMode?: string;     // 세션 모드 라인(type:"mode") — normal/ultracode 등
  aiTitle?: string;
  lastPrompt?: string;
  cwd?: string;
  launchCwd?: string;
  gitBranch?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  contextTokens: number;
  // 마지막 사용자 프롬프트의 "라인 자체 timestamp" (ms) — 스캔/부트스트랩 시점과 무관한
  // 실제 시각이므로 확장 리로드 후에도 진행 중인 턴이 복원됨
  lastPromptAt?: number;
  // 미완결 tool_use 추적 — 긴 턴에서는 프롬프트 라인이 부트스트랩 창(256KB) 밖으로 밀려나므로,
  // tail에 항상 남는 "결과가 아직 없는 tool_use"가 턴 열림의 두 번째 증거가 된다
  pendingTools: Set<string>;
  lastToolUseAt?: number;
  // 실작업 라인(assistant/tool_result/프롬프트)의 마지막 timestamp — running 판정 전용.
  // system/ai-title 등 메타 기록은 여기 반영하지 않는다 (턴 종료 후 늦게 와도 "작업 중" 오판 방지)
  lastWorkAt?: number;
  // Esc 중단 마커("[Request interrupted ...]") — Stop 훅이 발화하지 않는 턴 종료 신호
  lastInterruptAt?: number;
}

export function newClaudeAccum(): ClaudeAccum {
  return {
    input: 0, output: 0, cacheRead: 0, cacheCreate: 0, contextTokens: 0, pendingTools: new Set(),
  };
}

export function applyClaudeLine(acc: ClaudeAccum, line: string): boolean {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(line);
  } catch {
    return false;
  }
  if (!d || typeof d !== 'object') return false;
  let changed = false;

  if (d.type === 'ai-title' && typeof d.aiTitle === 'string') {
    acc.aiTitle = d.aiTitle;
    changed = true;
  } else if (d.type === 'last-prompt' && typeof d.lastPrompt === 'string') {
    acc.lastPrompt = d.lastPrompt;
    changed = true;
  } else if (d.type === 'permission-mode' && typeof d.permissionMode === 'string') {
    acc.mode = d.permissionMode;
    changed = true;
  } else if (d.type === 'mode' && typeof d.mode === 'string') {
    acc.sessionMode = d.mode; // normal / ultracode / fast 등
    changed = true;
  }

  if (typeof d.cwd === 'string') {
    acc.cwd = d.cwd;
    // 처음 본 cwd = 시작 디렉토리 근사 — 프로세스 OS cwd 매칭용 (세션 내부 cd에 불변)
    if (acc.launchCwd === undefined) acc.launchCwd = d.cwd;
    changed = true;
  }
  if (typeof d.gitBranch === 'string') { acc.gitBranch = d.gitBranch; changed = true; }

  const msg = d.message as Record<string, unknown> | undefined;
  if (msg && typeof msg === 'object') {
    const content = msg.content;
    const items = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
    const ts = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN;
    const hasToolResult = items.some((item) =>
      item !== null && typeof item === 'object' && item.type === 'tool_result');
    // Esc 중단 마커 — Stop 훅이 발화하지 않는 턴 종료. 프롬프트/작업으로 오인 금지
    const isInterrupt = d.type === 'user' && firstText(content).startsWith('[Request interrupted');
    if (isInterrupt && !Number.isNaN(ts)) {
      acc.lastInterruptAt = ts;
      changed = true;
    }
    const isPrompt =
      d.type === 'user' &&
      d.isMeta !== true &&
      !isInterrupt &&
      (typeof content === 'string' || (Array.isArray(content) && !hasToolResult)) &&
      !isLocalCommandEcho(content);
    // 실작업 증거 = assistant 라인 / tool_result 회신 / 진짜 프롬프트
    // (isMeta·커맨드 에코·중단 마커 user 라인은 작업이 아님 — running 오판 방지)
    if (
      !Number.isNaN(ts) &&
      (d.type === 'assistant' || (d.type === 'user' && !isInterrupt && (hasToolResult || isPrompt)))
    ) {
      acc.lastWorkAt = ts;
      changed = true;
    }
    if (isPrompt && !Number.isNaN(ts)) {
      acc.lastPromptAt = ts;
      changed = true;
    }
    if (d.type === 'assistant' && !Number.isNaN(ts)) {
      for (const item of items) {
        if (item && item.type === 'tool_use' && typeof item.id === 'string') {
          acc.pendingTools.add(item.id);
          acc.lastToolUseAt = ts;
          changed = true;
          // 결과가 영영 안 오는 id(중단 등)가 무한히 쌓이지 않도록 상한
          if (acc.pendingTools.size > 64) {
            acc.pendingTools.delete(acc.pendingTools.values().next().value!);
          }
        }
      }
    }
    if (d.type === 'user') {
      for (const item of items) {
        if (item && item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
          if (acc.pendingTools.delete(item.tool_use_id)) changed = true;
        }
      }
    }
    if (typeof msg.model === 'string') { acc.model = msg.model; changed = true; }
    const u = msg.usage as Record<string, number> | undefined;
    if (u && typeof u === 'object') {
      const inp = u.input_tokens ?? 0;
      const out = u.output_tokens ?? 0;
      const cr = u.cache_read_input_tokens ?? 0;
      const cc = u.cache_creation_input_tokens ?? 0;
      acc.input += inp;
      acc.output += out;
      acc.cacheRead += cr;
      acc.cacheCreate += cc;
      acc.contextTokens = inp + cr + cc + out;
      changed = true;
    }
  }
  return changed;
}

/** content가 문자열이면 그대로, 배열이면 첫 text 항목 — 앞 공백 제거 */
function firstText(content: unknown): string {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? String((content.find((i) =>
          i !== null && typeof i === 'object' && (i as Record<string, unknown>).type === 'text',
        ) as Record<string, unknown> | undefined)?.text ?? '')
      : '';
  return text.trimStart();
}

// 로컬 슬래시커맨드 에코(/mcp 등)는 type:user 문자열로 기록되지만 모델 턴을 시작하지 않음
// — 턴 시작으로 오인하면 Stop 없이 가짜 running이 됨 (실제 transcript에서 검증된 형식)
const LOCAL_CMD_PREFIXES = ['<command-name>', '<command-message>', '<local-command-stdout>'];

function isLocalCommandEcho(content: unknown): boolean {
  const t = firstText(content);
  return LOCAL_CMD_PREFIXES.some((p) => t.startsWith(p));
}

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function claudeFields(acc: ClaudeAccum): SessionFields {
  return {
    model: acc.model,
    mode: [acc.sessionMode, acc.mode].filter(Boolean).join('·') || undefined,
    topic: acc.aiTitle ?? truncate(acc.lastPrompt, TOPIC_MAX),
    cwd: acc.cwd,
    launchCwd: acc.launchCwd,
    gitBranch: acc.gitBranch,
    totalTokens: acc.input + acc.output + acc.cacheRead + acc.cacheCreate,
    contextTokens: acc.contextTokens,
    contextWindow: lookupModel(acc.model)?.context,
    costUsd: estimateClaudeCostUsd(acc.model, acc),
  };
}
