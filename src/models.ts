// 단가: 2026-07-10 기준 공식 API 정가 (참고치 — 실사용은 구독).
// cache read ≈ input의 0.1x, cache write ≈ input의 1.25x (5m TTL).
export interface ModelInfo {
  context: number;
  inputPerM?: number;
  outputPerM?: number;
  cacheReadPerM?: number;
}

export const MODEL_TABLE: Record<string, ModelInfo> = {
  'claude-fable-5': { context: 1_000_000, inputPerM: 10, outputPerM: 50, cacheReadPerM: 1.0 },
  'claude-mythos-5': { context: 1_000_000, inputPerM: 10, outputPerM: 50, cacheReadPerM: 1.0 },
  'claude-opus-5': { context: 1_000_000, inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  'claude-opus-4-8': { context: 1_000_000, inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  'claude-opus-4-7': { context: 1_000_000, inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  'claude-opus-4-6': { context: 1_000_000, inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  'claude-sonnet-5': { context: 1_000_000, inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  'claude-sonnet-4-6': { context: 1_000_000, inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  'claude-haiku-4-5': { context: 200_000, inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1 },
};

// 축약 별칭 — 세션 jsonl에 전체 ID 대신 티어 이름만 기록되는 경우가 있다("model":"sonnet").
// 스펙을 복제하지 않고 canonical 키를 가리켜, 단가 변경 시 한 곳만 고치면 되게 한다.
// 별칭이 가리키는 모델은 시간에 따라 바뀌므로, 과거 세션의 비용은 "현행 기본 모델 기준 추정"이다.
// exact match 전용 — prefix fallback에 넣으면 'sonnetish' 같은 값까지 잡힌다.
const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
};

export function lookupModel(modelId: string | undefined): ModelInfo | undefined {
  if (!modelId) return undefined;
  if (MODEL_TABLE[modelId]) return MODEL_TABLE[modelId];
  const alias = MODEL_ALIASES[modelId];
  if (alias) return MODEL_TABLE[alias];
  const key = Object.keys(MODEL_TABLE).find((k) => modelId.startsWith(k));
  return key ? MODEL_TABLE[key] : undefined;
}

export interface ClaudeUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export function estimateClaudeCostUsd(model: string | undefined, u: ClaudeUsageTotals): number | undefined {
  const info = lookupModel(model);
  if (!info?.inputPerM || !info.outputPerM) return undefined;
  return (
    (u.input * info.inputPerM +
      u.cacheCreate * info.inputPerM * 1.25 +
      u.cacheRead * (info.cacheReadPerM ?? info.inputPerM * 0.1) +
      u.output * info.outputPerM) /
    1_000_000
  );
}
