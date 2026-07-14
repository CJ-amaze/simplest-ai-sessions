#!/bin/bash
# agent-monitor hook — appends one JSON event line per invocation.
# Usage:
#   agent-monitor-hook.sh claude notification|stop    (Claude Code hook: JSON on stdin)
#   agent-monitor-hook.sh codex '<json>'              (codex notify: JSON as last arg)
#   agent-monitor-hook.sh codex-hook                  (codex hook: JSON on stdin)
AGENT="$1"
DIR="$HOME/.vscode-agent-monitor"
FILE="$DIR/events.jsonl"
mkdir -p "$DIR"

# "key":"value"의 첫 번째 등장에서 value 추출 — BSD sed는 BRE alternation(\|)을 지원하지
# 않고, greedy `.*"key"`는 뒤쪽 중첩 키를 잡으므로 grep -o + head -1로 첫 매치만 취한다
json_str() { # $1=json, $2=key
  printf '%s' "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 \
    | sed 's/.*"\([^"]*\)"$/\1/'
}

if [ "$AGENT" = "claude" ]; then
  KIND="$2"
  INPUT=$(cat)
  SID=$(json_str "$INPUT" "session_id")
  if [ "$KIND" = "notification" ]; then
    MESSAGE=$(json_str "$INPUT" "message")
    case "$MESSAGE" in
      *ermission*|*pproval*|*pprove*) KIND="approval" ;;
      *waiting*) KIND="idle" ;;
    esac
  fi
elif [ "$AGENT" = "codex-hook" ]; then
  INPUT=$(cat)
  SID=$(json_str "$INPUT" "session_id")
  HOOK_EVENT=$(json_str "$INPUT" "hook_event_name")
  KIND="notification"
  [ "$HOOK_EVENT" = "PermissionRequest" ] && KIND="approval"
  AGENT="codex"
else
  PAYLOAD="$2"
  # payload 전문이 아니라 "type" 필드 값만으로 분기 — 자유 텍스트(예: last-assistant-message)에
  # 우연히 "approval" 등의 단어가 섞여도 오탐하지 않도록 함
  TYPE=$(json_str "$PAYLOAD" "type")
  case "$TYPE" in
    *approval*) KIND="approval" ;;
    *turn-complete*|*turn_complete*|*task_complete*) KIND="turn-complete" ;;
    *) KIND="notification" ;;
  esac
  SID=$(json_str "$PAYLOAD" "thread-id")
  [ -z "$SID" ] && SID=$(json_str "$PAYLOAD" "thread_id")
  [ -z "$SID" ] && SID=$(json_str "$PAYLOAD" "session-id")
  [ -z "$SID" ] && SID=$(json_str "$PAYLOAD" "session_id")
fi

# ms 정밀도 — 1초 정밀도면 같은 초의 prompt→Stop / approval→Stop 순서가 역전됨
NOW=$(perl -MTime::HiRes=time -e 'printf("%.0f", time()*1000)' 2>/dev/null)
[ -z "$NOW" ] && NOW=$(($(date +%s) * 1000))

printf '{"agent":"%s","kind":"%s","sessionId":"%s","pid":%s,"observedAt":%s}\n' \
  "$AGENT" "$KIND" "$SID" "${PPID:-0}" "$NOW" >> "$FILE"

# rotate at 1MB (tail 파서는 size<offset 리셋으로 대응)
if [ "$(wc -c < "$FILE" | tr -d ' ')" -gt 1048576 ]; then
  tail -c 262144 "$FILE" > "$FILE.tmp" && mv "$FILE.tmp" "$FILE"
fi
exit 0
