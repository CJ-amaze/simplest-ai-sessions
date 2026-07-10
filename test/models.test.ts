import { describe, expect, it } from 'vitest';
import { estimateClaudeCostUsd, lookupModel } from '../src/models';

describe('lookupModel', () => {
  it('정확한 ID 매칭', () => {
    expect(lookupModel('claude-fable-5')?.context).toBe(1_000_000);
  });
  it('날짜 suffix가 붙은 ID는 prefix 매칭', () => {
    expect(lookupModel('claude-haiku-4-5-20251001')?.context).toBe(200_000);
  });
  it('모르는 모델은 undefined', () => {
    expect(lookupModel('gpt-5.6-sol')).toBeUndefined();
    expect(lookupModel(undefined)).toBeUndefined();
  });
});

describe('estimateClaudeCostUsd', () => {
  it('input/output/cache 각각 단가 적용', () => {
    // opus 4.8: in $5, out $25, cacheRead $0.5, cacheWrite 1.25x
    const cost = estimateClaudeCostUsd('claude-opus-4-8', {
      input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheCreate: 1_000_000,
    });
    expect(cost).toBeCloseTo(5 + 25 + 0.5 + 6.25, 5);
  });
  it('모르는 모델은 undefined', () => {
    expect(estimateClaudeCostUsd('gpt-5.6-sol', { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 })).toBeUndefined();
  });
});
