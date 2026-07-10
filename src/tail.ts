import { promises as fs } from 'node:fs';

interface TailState {
  offset: number;
  partial: string;
  discardPending: boolean; // 중간 시작: 첫 개행까지의 조각 폐기 대기
}

export class TailReader {
  private files = new Map<string, TailState>();

  /** 더 이상 존재하지 않는 파일의 tail 상태(offset/partial)를 제거 (F4: 추적 정리) */
  forget(filePath: string): void {
    this.files.delete(filePath);
  }

  async readNewLines(
    filePath: string,
    opts?: { bootstrapBytes?: number },
  ): Promise<{ lines: string[]; reset: boolean }> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) return { lines: [], reset: false };
    let st = this.files.get(filePath);
    let reset = false;
    if (!st) {
      const start =
        opts?.bootstrapBytes != null ? Math.max(0, stat.size - opts.bootstrapBytes) : 0;
      st = { offset: start, partial: '', discardPending: start > 0 };
      this.files.set(filePath, st);
    }
    if (stat.size < st.offset) {
      // truncate/교체 감지 — 처음부터 다시. 호출자는 accumulator를 재생성해야 함
      st.offset = 0;
      st.partial = '';
      st.discardPending = false;
      reset = true;
    }
    if (stat.size === st.offset) return { lines: [], reset };

    const fh = await fs.open(filePath, 'r');
    try {
      const len = stat.size - st.offset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, st.offset);
      st.offset = stat.size;
      let text = st.partial + buf.toString('utf8');
      if (st.discardPending) {
        // 잘린 첫 조각을 (빈 라인 filter 이전에!) 첫 개행까지 폐기
        const nl = text.indexOf('\n');
        if (nl === -1) {
          st.partial = ''; // 아직 개행 없음 — 계속 폐기 대기
          return { lines: [], reset };
        }
        text = text.slice(nl + 1);
        st.discardPending = false;
      }
      const lines = text.split('\n');
      st.partial = lines.pop() ?? '';
      return { lines: lines.filter((l) => l.length > 0), reset };
    } finally {
      await fh.close();
    }
  }
}
