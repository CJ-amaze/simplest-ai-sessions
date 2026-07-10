import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TailReader } from '../src/tail';

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tail-'));
  const f = join(dir, 'a.jsonl');
  writeFileSync(f, content);
  return f;
}

describe('TailReader', () => {
  it('처음엔 전체, 이후엔 새 라인만', async () => {
    const f = tmpFile('l1\nl2\n');
    const t = new TailReader();
    expect((await t.readNewLines(f)).lines).toEqual(['l1', 'l2']);
    expect((await t.readNewLines(f)).lines).toEqual([]);
    appendFileSync(f, 'l3\n');
    expect((await t.readNewLines(f)).lines).toEqual(['l3']);
  });

  it('partial line은 개행 도착까지 버퍼', async () => {
    const f = tmpFile('l1\npar');
    const t = new TailReader();
    expect((await t.readNewLines(f)).lines).toEqual(['l1']);
    appendFileSync(f, 'tial\n');
    expect((await t.readNewLines(f)).lines).toEqual(['partial']);
  });

  it('truncate(size<offset)면 리셋 + reset 플래그', async () => {
    const f = tmpFile('long-long-line\n');
    const t = new TailReader();
    expect((await t.readNewLines(f)).reset).toBe(false);
    writeFileSync(f, 'new\n'); // 더 짧게 교체
    const r = await t.readNewLines(f);
    expect(r.reset).toBe(true);
    expect(r.lines).toEqual(['new']);
  });

  it('bootstrapBytes: 첫 관찰 시 끝부분만, 잘린 첫 조각은 폐기하되 유효 라인은 보존', async () => {
    // start가 개행 경계 직후가 아닌 경우: buf가 "\nrecent\n" → 첫 개행까지("") 폐기 후 recent 반환
    const f = tmpFile('old1\nold2\nrecent\n');
    const t = new TailReader();
    expect((await t.readNewLines(f, { bootstrapBytes: 8 })).lines).toEqual(['recent']);
    // start가 라인 중간인 경우: buf가 "d2\nrecent\n" → "d2" 폐기 후 recent 반환
    const f2 = tmpFile('old1\nold2\nrecent\n');
    const t2 = new TailReader();
    expect((await t2.readNewLines(f2, { bootstrapBytes: 10 })).lines).toEqual(['recent']);
  });

  it('없는 파일은 빈 배열', async () => {
    const t = new TailReader();
    expect((await t.readNewLines('/nonexistent/x.jsonl')).lines).toEqual([]);
  });
});
