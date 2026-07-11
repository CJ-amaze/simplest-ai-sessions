import { appendFileSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdapterWatcher, claudeSpec, codexSpec } from '../src/adapters/watcher';
import { TailReader } from '../src/tail';
import type { SessionPatch } from '../src/types';

const SID = 'aaaabbbb-1111-4222-8333-cccccccc0001';
const T = 1_000_000_000_000;

function makeClaudeRoot(): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'claude-'));
  const proj = join(root, '-Users-cj-Desktop-CJI');
  mkdirSync(proj);
  const file = join(proj, `${SID}.jsonl`);
  writeFileSync(file, '{"type":"ai-title","aiTitle":"주제A"}\n');
  return { root, file };
}

describe('AdapterWatcher + claudeSpec', () => {
  it('bootstrap 스캔에서 세션 발견 + 파일 mtime으로 활동 시각 기록', async () => {
    const { root, file } = makeClaudeRoot();
    const mtime = Date.now() - 5_000;
    utimesSync(file, mtime / 1000, mtime / 1000);
    const eventTime = statSync(file).mtimeMs;
    const patches: SessionPatch[] = [];
    const w = new AdapterWatcher(claudeSpec(root), new TailReader(), (p) => patches.push(p));
    await w.scan(Date.now());
    expect(patches).toHaveLength(1);
    expect(patches[0].sessionId).toBe(SID);
    expect(patches[0].fields.topic).toBe('주제A');
    expect(patches[0].fields.lastActivityAt).toBe(eventTime);
  });

  it('append 시에만 재-patch (변경 없으면 무음)', async () => {
    const { root, file } = makeClaudeRoot();
    const patches: SessionPatch[] = [];
    const w = new AdapterWatcher(claudeSpec(root), new TailReader(), (p) => patches.push(p));
    await w.scan(Date.now());
    await w.scan(Date.now());
    expect(patches).toHaveLength(1);
    appendFileSync(file, '{"type":"permission-mode","permissionMode":"plan"}\n');
    await w.scan(Date.now());
    expect(patches).toHaveLength(2);
    expect(patches[1].fields.mode).toBe('plan');
  });

  it('24h보다 오래된 파일은 무시', async () => {
    const { root, file } = makeClaudeRoot();
    const old = (Date.now() - 25 * 3600_000) / 1000;
    utimesSync(file, old, old);
    const patches: SessionPatch[] = [];
    const w = new AdapterWatcher(claudeSpec(root), new TailReader(), (p) => patches.push(p));
    await w.scan(Date.now());
    expect(patches).toHaveLength(0);
  });

  it('claudeSpec은 프롬프트 라인의 자체 timestamp를 turnStartedAt으로 (재발행에도 안정적)', () => {
    const spec = claudeSpec();
    const acc = spec.createAccum();
    spec.applyLine(acc, JSON.stringify({
      type: 'user', timestamp: new Date(T).toISOString(), message: { content: '질문' },
    }));
    expect(spec.toFields(acc, T + 5000).turnStartedAt).toBe(T); // 스캔 시각이 아니라 라인 시각
    expect(spec.toFields(acc, T + 9000).turnStartedAt).toBe(T); // 재호출에도 동일 (소거 없음)
  });

  it('bootstrap replay에서도 진행 중 턴이 복원됨 — 확장 리로드 중 작업이 "대기"로 오판되지 않음', async () => {
    const { root, file } = makeClaudeRoot();
    const promptAt = Date.now() - 3 * 60_000; // 3분 전 프롬프트, 턴 아직 진행 중
    writeFileSync(file, JSON.stringify({
      type: 'user', timestamp: new Date(promptAt).toISOString(), message: { content: '진행 중 질문' },
    }) + '\n');
    const patches: SessionPatch[] = [];
    const w = new AdapterWatcher(claudeSpec(root), new TailReader(), (p) => patches.push(p));
    await w.scan(Date.now());
    expect(patches).toHaveLength(1);
    expect(patches[0].fields.turnStartedAt).toBe(promptAt); // 실제 프롬프트 시각으로 복원
  });

  it('긴 턴: 프롬프트가 창 밖이어도 미완결 tool_use가 턴 열림을 복원, tool_result가 닫으면 해제', () => {
    const spec = claudeSpec();
    const acc = spec.createAccum();
    // 프롬프트 라인은 부트스트랩 창 밖 — tail에는 tool_use/tool_result만 남은 상황
    spec.applyLine(acc, JSON.stringify({
      type: 'assistant', timestamp: new Date(T + 1000).toISOString(),
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash' }] },
    }));
    expect(spec.toFields(acc, T + 9000).turnStartedAt).toBe(T + 1000); // 미완결 → 턴 열림
    spec.applyLine(acc, JSON.stringify({
      type: 'user', timestamp: new Date(T + 5000).toISOString(),
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] },
    }));
    expect(spec.toFields(acc, T + 9000).turnStartedAt).toBeUndefined(); // 결과 도착 → 해제
  });
});

function makeCodexDir(root: string): string {
  const d = new Date();
  const dir = join(root, String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

describe('codexSpec', () => {
  it('YYYY/MM/DD 하위의 rollout 파일에서 세션 ID 추출 + append로 온 approval 이벤트 → 라인 시각의 approvalAt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-'));
    const dir = makeCodexDir(root);
    const file = join(dir, `rollout-2026-07-10T11-42-47-${SID}.jsonl`);
    writeFileSync(file, '{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}\n');
    const patches: SessionPatch[] = [];
    const w = new AdapterWatcher(codexSpec(root), new TailReader(), (p) => patches.push(p));
    await w.scan(Date.now()); // bootstrap — 이 시점엔 approval 이벤트 없음
    const approvalAt = Date.now() - 5_000;
    appendFileSync(file,
      `{"timestamp":"${isoAt(approvalAt)}","type":"event_msg","payload":{"type":"exec_approval_request"}}\n`);
    await w.scan(Date.now());
    const last = patches[patches.length - 1];
    expect(last.sessionId).toBe(SID);
    expect(last.fields.model).toBe('gpt-5.6-sol');
    expect(last.fields.approvalAt).toBe(approvalAt); // 스캔/mtime이 아니라 라인 시각
  });

  it('bootstrap 스캔: 완료된 rollout의 과거 approval은 라인 시각 그대로 — stoppedAt이 더 나중이라 승인대기로 오판되지 않음', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-'));
    const dir = makeCodexDir(root);
    const file = join(dir, `rollout-2026-07-10T11-42-47-${SID}.jsonl`);
    const t1 = Date.now() - 60_000;
    const t2 = t1 + 30_000;
    writeFileSync(file,
      '{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}\n' +
      `{"timestamp":"${isoAt(t1)}","type":"event_msg","payload":{"type":"exec_approval_request"}}\n` +
      `{"timestamp":"${isoAt(t2)}","type":"event_msg","payload":{"type":"task_complete"}}\n`);
    const patches: SessionPatch[] = [];
    const w = new AdapterWatcher(codexSpec(root), new TailReader(), (p) => patches.push(p));
    await w.scan(Date.now());
    expect(patches).toHaveLength(1);
    expect(patches[0].fields.approvalAt).toBe(t1);
    expect(patches[0].fields.stoppedAt).toBe(t2); // stoppedAt > approvalAt → status가 승인대기 해제
  });

  it('F4: listFiles 스캔 범위(오늘+어제)를 벗어나도 이미 추적 중인 파일은 계속 tail됨', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-'));
    const dir = makeCodexDir(root);
    const file = join(dir, `rollout-2026-07-10T11-42-47-${SID}.jsonl`);
    writeFileSync(file, '{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}\n');
    const baseSpec = codexSpec(root);
    let outOfRange = false;
    // 이틀 이상 지속되는 세션을 시뮬레이션: listFiles가 더 이상 이 파일을 반환하지 않음
    const spec = { ...baseSpec, listFiles: async () => (outOfRange ? [] : baseSpec.listFiles()) };
    const patches: SessionPatch[] = [];
    const w = new AdapterWatcher(spec, new TailReader(), (p) => patches.push(p));
    await w.scan(Date.now()); // bootstrap — 추적 시작
    expect(patches).toHaveLength(1);

    outOfRange = true; // 이제 listFiles 범위 밖 (2일차 디렉토리로 밀려남)
    const approvalAt = Date.now() - 5_000;
    appendFileSync(file,
      `{"timestamp":"${isoAt(approvalAt)}","type":"event_msg","payload":{"type":"exec_approval_request"}}\n`);
    await w.scan(Date.now());
    const last = patches[patches.length - 1];
    expect(last.sessionId).toBe(SID);
    expect(last.fields.approvalAt).toBe(approvalAt); // 여전히 patch 발행 — tail에서 이탈하지 않음
  });

  it('미인식 라인만 append돼도 활동 신호로 최소 patch(lastActivityAt만) 발행', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-'));
    const dir = makeCodexDir(root);
    const file = join(dir, `rollout-2026-07-10T11-42-47-${SID}.jsonl`);
    writeFileSync(file, '{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}\n');
    const patches: SessionPatch[] = [];
    const w = new AdapterWatcher(codexSpec(root), new TailReader(), (p) => patches.push(p));
    await w.scan(Date.now()); // bootstrap
    appendFileSync(file, '{"type":"response_item","payload":{}}\n');
    const mtime = Date.now() - 5_000;
    utimesSync(file, mtime / 1000, mtime / 1000);
    const eventTime = statSync(file).mtimeMs;
    const now = Date.now();
    await w.scan(now);
    expect(patches).toHaveLength(2);
    expect(patches[1].fields.lastActivityAt).toBe(eventTime);
    expect(patches[1].fields.model).toBeUndefined(); // 전체 필드가 아니라 최소 patch
  });

  it('한 batch에 complete→started가 섞여도 라인 시각으로 턴 열림이 보존됨', () => {
    const spec = codexSpec();
    const acc = spec.createAccum();
    // 이전 턴 종료(T) 후 같은 스캔 batch에서 새 턴 시작(T+2000)
    spec.applyLine(acc, `{"timestamp":"${isoAt(T)}","type":"event_msg","payload":{"type":"task_complete"}}`);
    spec.applyLine(acc, `{"timestamp":"${isoAt(T + 1000)}","type":"event_msg","payload":{"type":"exec_approval_request"}}`);
    spec.applyLine(acc, `{"timestamp":"${isoAt(T + 2000)}","type":"event_msg","payload":{"type":"task_started"}}`);
    const f = spec.toFields(acc, T + 9000);
    expect(f.stoppedAt).toBe(T);            // 실제 종료 시각
    expect(f.turnStartedAt).toBe(T + 2000); // stoppedAt < turnStartedAt → 턴 열림으로 판정됨
    expect(f.approvalAt).toBe(T + 1000);    // 승인 해제는 status의 활동/stop 가드가 담당
  });
});
