#!/bin/bash
# agent-monitor statusline — Claude Code statusLine 연동.
# stdin의 상태 JSON에서 session_id/model/effort를 뽑아 로컬 파일에 기록하고
# (사이드바가 tail), 터미널 하단 표시용 한 줄을 출력한다.
DIR="$HOME/.vscode-agent-monitor"
FILE="$DIR/status.jsonl"
mkdir -p "$DIR"
INPUT=$(cat)

get() { # $1=key — 첫 매치의 문자열 값 (BSD 호환: grep -o + head)
  printf '%s' "$INPUT" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 \
    | sed 's/.*"\([^"]*\)"$/\1/'
}
SID=$(get session_id)
MODEL_BLOCK=$(printf '%s' "$INPUT" | grep -o '"model"[[:space:]]*:[[:space:]]*{[^}]*}' | head -1)
DISPLAY=$(printf '%s' "$MODEL_BLOCK" | grep -o '"display_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
EFFORT_BLOCK=$(printf '%s' "$INPUT" | grep -o '"effort"[[:space:]]*:[[:space:]]*{[^}]*}' | head -1)
EFFORT=$(printf '%s' "$EFFORT_BLOCK" | grep -o '"level"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')

if [ -n "$SID" ]; then
  LINE=$(printf '{"sessionId":"%s","effort":"%s"}' "$SID" "$EFFORT")
  # 같은 내용 반복 기록 방지 (statusLine은 자주 호출됨)
  [ "$(tail -1 "$FILE" 2>/dev/null)" != "$LINE" ] && printf '%s\n' "$LINE" >> "$FILE"
  if [ "$(wc -c < "$FILE" | tr -d ' ')" -gt 262144 ]; then
    tail -c 65536 "$FILE" > "$FILE.tmp" && mv "$FILE.tmp" "$FILE"
  fi
fi

# 터미널 하단 표시줄
printf '%s%s\n' "${DISPLAY:-Claude}" "${EFFORT:+ · $EFFORT}"
exit 0
