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
  'claude-opus-4-8': { context: 1_000_000, inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  'claude-opus-4-7': { context: 1_000_000, inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  'claude-opus-4-6': { context: 1_000_000, inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  'claude-sonnet-5': { context: 1_000_000, inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  'claude-sonnet-4-6': { context: 1_000_000, inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  'claude-haiku-4-5': { context: 200_000, inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1 },
};

export function lookupModel(modelId: string | undefined): ModelInfo | undefined {
  if (!modelId) return undefined;
  if (MODEL_TABLE[modelId]) return MODEL_TABLE[modelId];
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
