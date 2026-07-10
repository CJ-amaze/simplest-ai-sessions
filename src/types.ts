export type AgentKind = 'claude' | 'codex';
export type Status = 'running' | 'approval' | 'idle' | 'exited';
export type MappingConfidence = 'exact' | 'heuristic' | 'none';

/** 어댑터/훅이 갱신 가능한 세션 필드 (식별자 제외) */
export interface SessionFields {
  cwd?: string;
  launchCwd?: string;       // 세션 시작 시점 cwd — 프로세스 OS cwd와 일치 (세션 내부 cd에도 불변)
  gitBranch?: string;
  model?: string;
  mode?: string;            // claude: permissionMode / codex: "approval·sandbox"
  effort?: string;          // 모델 effort — codex: rollout turn_context, claude: statusLine 연동
  topic?: string;
  totalTokens?: number;     // 세션 누적
  contextTokens?: number;   // 마지막 turn 컨텍스트 점유
  contextWindow?: number;   // codex는 rollout에서, claude는 models 테이블에서
  costUsd?: number;
  lastActivityAt?: number;  // ms epoch (파일 mtime 기준) — 모든 append 포함, prune/생존 판정용
  lastWorkAt?: number;      // 실작업 라인(assistant/tool/프롬프트)의 자체 timestamp — running 판정용.
                            // system/ai-title 등 턴 종료 후 늦게 오는 메타 기록이 "작업 중"을 되살리지 않도록 분리
  approvalAt?: number;
  stoppedAt?: number;
  turnStartedAt?: number;   // claude=사용자 프롬프트, codex=task_started (라인 자체 timestamp)
}

export interface SessionState extends Required<Pick<SessionFields, 'lastActivityAt'>> {
  key: string;              // `${agent}:${sessionId}`
  agent: AgentKind;
  sessionId: string;
  filePath: string;
  cwd?: string;
  launchCwd?: string;
  gitBranch?: string;
  model?: string;
  mode?: string;
  effort?: string;
  topic?: string;
  totalTokens: number;
  contextTokens: number;
  contextWindow?: number;
  costUsd?: number;
  approvalAt?: number;
  stoppedAt?: number;
  lastEventAt: number;      // stale 훅 이벤트 필터용 (patch의 approvalAt/stoppedAt도 여기에 반영)
  registeredAt?: number;    // 스토어 등록 시각 — 시작 레이스 grace 판정용 (mapper reconcile)
  lastWorkAt?: number;
  turnStartedAt?: number;
  pid?: number;
  hookPid?: number;         // 훅 이벤트 유래 pid 힌트 (매핑 검증용 — mapper가 생사 확인 후에만 신뢰)
  processAlive?: boolean;   // undefined = 미확인(외부)
  busy?: boolean;           // 프로세스 트리 CPU 사용 중 — 긴 도구/사고(작업중) vs Esc 중단(대기) 판별
  nativeStatus?: 'busy' | 'idle'; // Claude Code 자체 상태(~/.claude/sessions/<pid>.json) — 있으면 최우선
  everAlive?: boolean;      // 이번 확장 수명 중 생존 확인된 적 있음 (부트스트랩 유령 즉시 제거용)
  mapping: MappingConfidence;
  parentKey?: string;       // 부모 세션 key (다른 agent 프로세스가 띄운 서브에이전트)
  terminalName?: string;    // 표시 전용 — 이름은 중복 가능하므로 포커스 식별자로 쓰지 말 것
  shellPid?: number;        // 매핑된 VS Code 터미널의 shell pid (포커스 식별용)
}

export interface SessionPatch {
  agent: AgentKind;
  sessionId: string;
  filePath: string;
  fields: SessionFields;
}

export interface HookEvent {
  agent: AgentKind;
  kind: 'notification' | 'stop' | 'approval' | 'turn-complete' | 'idle';
  sessionId?: string;
  pid?: number;
  observedAt: number;       // ms epoch
}

export interface SessionView extends SessionState {
  status: Status;
  children?: SessionView[]; // 서브에이전트 세션 (1단계만 — children의 children은 항상 undefined)
}
