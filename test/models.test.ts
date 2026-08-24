import { describe, expect, it } from 'vitest';
import { estimateClaudeCostUsd, lookupModel } from '../src/models';

describe('lookupModel', () => {
  it('정확한 ID 매칭', () => {
    expect(lookupModel('claude-fable-5')?.context).toBe(1_000_000);
  });
  it('날짜 suffix가 붙은 ID는 prefix 매칭', () => {
    expect(lookupModel('claude-haiku-4-5-20251001')?.context).toBe(200_000);
  });
  it('opus-5는 [1m] 같은 variant suffix가 붙어도 매칭', () => {
    expect(lookupModel('claude-opus-5')?.context).toBe(1_000_000);
    expect(lookupModel('claude-opus-5[1m]')?.context).toBe(1_000_000);
  });
  it('모르는 모델은 undefined', () => {
    expect(lookupModel('gpt-5.6-sol')).toBeUndefined();
    expect(lookupModel(undefined)).toBeUndefined();
  });

  it('축약 별칭은 각 티어의 현행 기본 모델로 해석', () => {
    expect(lookupModel('opus')).toEqual(lookupModel('claude-opus-5'));
    expect(lookupModel('sonnet')).toEqual(lookupModel('claude-sonnet-5'));
    expect(lookupModel('haiku')).toEqual(lookupModel('claude-haiku-4-5'));
  });

  it('별칭은 exact match 전용 — 접두만 같은 값은 잡지 않는다', () => {
    expect(lookupModel('sonnetish')).toBeUndefined();
    expect(lookupModel('opus-unknown')).toBeUndefined();
    expect(lookupModel('haiku2')).toBeUndefined();
  });

  it('별칭 추가가 canonical ID prefix 매칭을 가리지 않는다', () => {
    expect(lookupModel('claude-opus-5[1m]')?.context).toBe(1_000_000);
    expect(lookupModel('claude-haiku-4-5-20251001')?.context).toBe(200_000);
    expect(lookupModel('claude-sonnet-4-6-preview')?.outputPerM).toBe(15);
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
  it('opus-5 단가 (in $5 / out $25 / cacheRead $0.5)', () => {
    const cost = estimateClaudeCostUsd('claude-opus-5', {
      input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheCreate: 1_000_000,
    });
    expect(cost).toBeCloseTo(5 + 25 + 0.5 + 6.25, 5);
  });
  it('축약 별칭도 비용이 산출된다 (증상: 비용 칸이 비던 세션)', () => {
    const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheCreate: 1_000_000 };
    expect(estimateClaudeCostUsd('sonnet', usage)).toBeCloseTo(3 + 15 + 0.3 + 3.75, 5);
    expect(estimateClaudeCostUsd('opus', usage)).toBe(estimateClaudeCostUsd('claude-opus-5', usage));
    expect(estimateClaudeCostUsd('haiku', usage)).toBe(estimateClaudeCostUsd('claude-haiku-4-5', usage));
  });
  it('모르는 모델은 undefined', () => {
    expect(estimateClaudeCostUsd('gpt-5.6-sol', { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 })).toBeUndefined();
  });
});
