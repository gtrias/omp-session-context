#!/usr/bin/env bash
# End-to-end check against a real Herdr Desktop and a real OMP agent.
#
# Starts an OMP agent in a new, unfocused tab on a throwaway repo, waits for it to finish, then asserts that the
# extension wrote a sensible context file. With SHOT=out.png it also focuses that tab, saves the window frame and
# puts the previously shown tab back.
#
# Env:
#   HERDR_SSH   host that runs Herdr Desktop, when it is not this machine (e.g. kelymaster-vpn)
#   SHOT        path for a window screenshot (kept on this machine)
#   KEEP=1      leave the demo tab open
set -euo pipefail

APP() { if [ -n "${HERDR_SSH:-}" ]; then ssh "$HERDR_SSH" "herdr-app $(printf '%q ' "$@")"; else herdr-app "$@"; fi; }
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/omp-session-context"
DEMO="$(mktemp -d /tmp/omp-session-context-e2e.XXXXXX)"
fail() { echo "FAIL: $*" >&2; exit 1; }

git -C "$DEMO" init -q -b main
printf '#!/usr/bin/env bash\necho "installing demo-tool"\n' >"$DEMO/install.sh"
printf 'import { expect, it } from "bun:test";\nit("adds", () => expect(1 + 1).toBe(2));\n' >"$DEMO/add.test.ts"
chmod +x "$DEMO/install.sh"
git -C "$DEMO" add -A && git -C "$DEMO" -c user.name=e2e -c user.email=e2e@example.com commit -qm init

TASK='Use the todo tool to plan 3 short tasks. Add a --version flag to install.sh that prints 0.1.0, check it by running ./install.sh --version, then run bun test. Keep replies short.'
BEFORE="$(APP status | jq -r .tab)"
OUT="$(APP do tab.new --name e2e-demo --folder "$DEMO" --argv '["omp"]' --task "$TASK" --focus false)"
TAB="$(jq -r .tab <<<"$OUT")"
TERMINAL="$(jq -r .terminal <<<"$OUT")"; TERMINAL="${TERMINAL##*/}"
echo "tab $TAB terminal $TERMINAL in $DEMO"
cleanup() {
  [ -n "${KEEP:-}" ] && return
  APP do tab.close --id "$TAB" >/dev/null 2>&1 || true
  rm -rf "$DEMO"
}
trap cleanup EXIT

hc wait "$TERMINAL" --timeout 300000 >/dev/null
FILE="$STATE/$TERMINAL.json"
[ -f "$FILE" ] || fail "no context file at $FILE"
# The extension debounces writes (about 1 s): wait until the final reply has landed.
for _ in $(seq 20); do jq -e '.lastReply != null' "$FILE" >/dev/null 2>&1 && break; sleep 0.5; done

check() { jq -e "$1" "$FILE" >/dev/null || fail "$2 (jq: $1)"; echo "ok: $2"; }
check '.version == 1' "file has version 1"
check '.ask.first | length > 0' "records what was asked"
check '.todo.total == .todo.done and .todo.total > 0' "todo fully done"
check '.stats.tests.status == "passed"' "test run detected as passed"
check '.stats.toolCalls > 0 and .stats.toolErrors <= .stats.toolCalls' "tool calls counted (the model may make real errors)"
check '.lastReply | test("\\*\\*|^- ") | not' "last reply is plain text"
check '.waiting == null' "not waiting on anything"

if [ -n "${SHOT:-}" ]; then
  APP do tab.select --id "$TAB" >/dev/null
  sleep 4
  REMOTE="${HERDR_SSH:+/tmp/omp-session-context-e2e.png}"
  APP shot "${REMOTE:-$SHOT}" >/dev/null
  [ -n "$REMOTE" ] && scp -q "$HERDR_SSH:$REMOTE" "$SHOT"
  APP do tab.select --id "$BEFORE" >/dev/null
  echo "screenshot: $SHOT"
fi

echo "e2e passed"

