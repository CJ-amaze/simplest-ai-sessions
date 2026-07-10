import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  mergeClaudeSettings, mergeCodexConfig, removeClaudeHooks, removeCodexNotify,
  installHooks,
} from '../src/hooks/installer';

const SCRIPT = '/Users/x/.vscode/ext/dist/resources/agent-monitor-hook.sh';

describe('mergeClaudeSettings', () => {
  it('기존 hooks(pair-coding 등) 보존하며 Notification/Stop 추가', () => {
    const input = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'echo pair' }] }] },
      model: 'opus',
    });
    const { changed, result } = mergeClaudeSettings(input, SCRIPT);
    expect(changed).toBe(true);
    const out = JSON.parse(result);
    expect(out.model).toBe('opus');                                  // 다른 설정 보존
    expect(out.hooks.PreToolUse[0].hooks[0].command).toBe('echo pair'); // 기존 hook 보존
    expect(JSON.stringify(out.hooks.Notification)).toContain(SCRIPT);
    expect(JSON.stringify(out.hooks.Stop)).toContain(SCRIPT);
  });

  it('idempotent — 재실행 시 중복 생성 안 함', () => {
    const once = mergeClaudeSettings('{}', SCRIPT).result;
    const twice = mergeClaudeSettings(once, SCRIPT);
    expect(twice.changed).toBe(false);
    expect(twice.result).toBe(once);
  });

  it('removeClaudeHooks는 자기 항목만 제거', () => {
    const merged = JSON.parse(mergeClaudeSettings(
      JSON.stringify({ hooks: { Notification: [{ hooks: [{ type: 'command', command: 'other-tool' }] }] } }),
      SCRIPT,
    ).result);
    const { result } = removeClaudeHooks(JSON.stringify(merged), SCRIPT);
    const out = JSON.parse(result);
    expect(JSON.stringify(out)).not.toContain(SCRIPT);
    expect(JSON.stringify(out.hooks.Notification)).toContain('other-tool'); // 타인 항목 보존
  });

  it('scriptPath가 빈 문자열이면 removeClaudeHooks는 아무것도 지우지 않음 (C1 안전가드)', () => {
    const input = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'echo pair' }] }] },
    });
    const { changed, result } = removeClaudeHooks(input, '');
    expect(changed).toBe(false);
    expect(result).toBe(input);
    expect(JSON.parse(result).hooks.PreToolUse[0].hooks[0].command).toBe('echo pair'); // pair-coding hook 보존
  });
});

describe('mergeCodexConfig', () => {
  it('root 키를 첫 [section] 앞에 삽입', () => {
    const toml = 'model = "gpt-5.6-sol"\n\n[mcp_servers.docs]\nurl = "x"\n';
    const { changed, result } = mergeCodexConfig(toml, SCRIPT);
    expect(changed).toBe(true);
    const notifyIdx = result.indexOf('notify');
    const sectionIdx = result.indexOf('[mcp_servers.docs]');
    expect(notifyIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeLessThan(sectionIdx);   // 반드시 테이블 앞 (TOML root)
    expect(result).toContain(`notify = ["${SCRIPT}", "codex"]`);
  });

  it('idempotent', () => {
    const once = mergeCodexConfig('', SCRIPT).result;
    expect(mergeCodexConfig(once, SCRIPT).changed).toBe(false);
  });

  it('기존 notify가 있으면 conflict — 건드리지 않음', () => {
    const toml = 'notify = ["/other/notifier"]\n';
    const r = mergeCodexConfig(toml, SCRIPT);
    expect(r.changed).toBe(false);
    expect(r.conflict).toBeTruthy();
    expect(r.result).toBe(toml);
  });

  it('removeCodexNotify는 마커 달린 자기 항목만 제거', () => {
    const merged = mergeCodexConfig('model = "x"\n', SCRIPT).result;
    const { result } = removeCodexNotify(merged, SCRIPT);
    expect(result).not.toContain('notify');
    expect(result).toContain('model = "x"');
  });

  it('root 멀티라인 배열 연속 라인(닫는 대괄호 포함)을 테이블 헤더로 오인하지 않음', () => {
    const toml = 'matrix = [\n[1,2],\n[3,4]\n]\n\n[real_section]\nkey = 1\n';
    const { changed, result } = mergeCodexConfig(toml, SCRIPT);
    expect(changed).toBe(true);
    // 배열 리터럴은 원본 그대로 보존 (파손 없음)
    expect(result.startsWith('matrix = [\n[1,2],\n[3,4]\n]\n')).toBe(true);
    const notifyIdx = result.indexOf('notify =');
    const sectionIdx = result.indexOf('[real_section]');
    const arrayCloseIdx = result.indexOf('[3,4]');
    expect(notifyIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeGreaterThan(arrayCloseIdx); // 배열 내부가 아니라 배열 뒤에 삽입
    expect(notifyIdx).toBeLessThan(sectionIdx);        // 진짜 첫 헤더 앞(root 영역 끝)에 삽입
    expect(result).toContain(`notify = ["${SCRIPT}", "codex"]`);
  });

  it('주석과 문자열 내부의 대괄호는 depth 계산에서 제외 — 이후 진짜 헤더를 정상 인식', () => {
    const toml = '# TODO [broken\npattern = "[a-z"\n\n[real_section]\nkey = 1\n';
    const { changed, result } = mergeCodexConfig(toml, SCRIPT);
    expect(changed).toBe(true);
    const notifyIdx = result.indexOf('notify =');
    const sectionIdx = result.indexOf('[real_section]');
    expect(notifyIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeLessThan(sectionIdx); // 주석/문자열의 대괄호에 속지 않고 진짜 헤더 앞에 삽입
    expect(result).toContain(`notify = ["${SCRIPT}", "codex"]`);
    expect(result).toContain('pattern = "[a-z"'); // 원본 라인은 그대로 보존
  });

  it('테이블 내부에만 있는 notify는 conflict를 유발하지 않고 root에 정상 삽입', () => {
    const toml = '[profiles.x]\nnotify = ["/other"]\n';
    const { changed, result, conflict } = mergeCodexConfig(toml, SCRIPT);
    expect(conflict).toBeUndefined();
    expect(changed).toBe(true);
    expect(result).toContain(`notify = ["${SCRIPT}", "codex"]`);
    expect(result).toContain('notify = ["/other"]'); // 테이블 내부 값 보존
    expect(result).toContain('[profiles.x]');
    const rootNotifyIdx = result.indexOf(`notify = ["${SCRIPT}"`);
    const sectionIdx = result.indexOf('[profiles.x]');
    expect(rootNotifyIdx).toBeLessThan(sectionIdx); // root(테이블 앞)에 삽입됨
  });
});

describe('installHooks', () => {
  it('installHooks: 실제 파일에 installed→already', async () => {
    const home = mkdtempSync(join(tmpdir(), 'insthome-'));
    const r1 = await installHooks(home, SCRIPT);
    expect(r1).toEqual({ claude: 'installed', codex: 'installed' });
    const r2 = await installHooks(home, SCRIPT);
    expect(r2).toEqual({ claude: 'already', codex: 'already' });
    expect(readFileSync(join(home, '.claude/settings.json'), 'utf8')).toContain(SCRIPT);
  });
});
