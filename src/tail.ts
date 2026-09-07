import { promises as fs } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

interface TailState {
  offset: number;
  partial: string;
  discardPending: boolean; // 중간 시작: 첫 개행까지의 조각 폐기 대기
  decoder: StringDecoder;
}

export class TailReader {
  private files = new Map<string, TailState>();

  /** 더 이상 존재하지 않는 파일의 tail 상태(offset/partial)를 제거 (F4: 추적 정리) */
  forget(filePath: string): void {
    this.files.delete(filePath);
  }

  async readNewLines(
    filePath: string,
    opts?: { bootstrapBytes?: number; onLine?: (line: string) => void; onReset?: () => void },
  ): Promise<{ lines: string[]; reset: boolean }> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) return { lines: [], reset: false };
    let st = this.files.get(filePath);
    let reset = false;
    if (!st) {
      const start =
        opts?.bootstrapBytes != null ? Math.max(0, stat.size - opts.bootstrapBytes) : 0;
      st = { offset: start, partial: '', discardPending: start > 0, decoder: new StringDecoder('utf8') };
      this.files.set(filePath, st);
    }
    if (stat.size < st.offset) {
      // truncate/교체 감지 — 처음부터 다시. 호출자는 accumulator를 재생성해야 함
      st.offset = 0;
      st.partial = '';
      st.discardPending = false;
      st.decoder = new StringDecoder('utf8');
      reset = true;
      opts?.onReset?.();
    }
    if (stat.size === st.offset) return { lines: [], reset };

    const fh = await fs.open(filePath, 'r');
    try {
      const lines: string[] = [];
      const buf = Buffer.alloc(Math.min(64 * 1024, stat.size - st.offset));
      while (st.offset < stat.size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, stat.size - st.offset), st.offset);
        if (bytesRead === 0) break;
        st.offset += bytesRead;
        let text = st.partial + st.decoder.write(buf.subarray(0, bytesRead));
        if (st.discardPending) {
          const nl = text.indexOf('\n');
          if (nl === -1) {
            st.partial = '';
            continue;
          }
          text = text.slice(nl + 1);
          st.discardPending = false;
        }
        const chunk = text.split('\n');
        st.partial = chunk.pop() ?? '';
        for (const line of chunk) {
          if (!line) continue;
          if (opts?.onLine) opts.onLine(line);
          else lines.push(line);
        }
      }
      return { lines, reset };
    } finally {
      await fh.close();
    }
  }
}
