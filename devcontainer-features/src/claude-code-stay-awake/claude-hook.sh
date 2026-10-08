#!/bin/sh
# Insomnia — Claude Code hook for dev containers (also usable in WSL).
#
# Claude Code runs this for each hook event, with the event's JSON on stdin.
# It forwards the event to Insomnia on the Windows host, and while a turn is
# open it sends a heartbeat every minute. Windows cannot see processes inside
# the container, so the heartbeat is how Insomnia tells a long build (keep the
# PC awake) from a session that has gone away (let it sleep).
#
# A hook must never get in Claude's way: nothing on stdout, always exit 0,
# short network timeouts, and the heartbeat runs fully detached.
#
# Environment (overrides insomnia.conf next to this script):
#   INSOMNIA_URL                 bridge base URL (default http://host.docker.internal:47391)
#   INSOMNIA_DISABLED=1          do nothing
#   INSOMNIA_HEARTBEAT_INTERVAL  seconds between heartbeats (default 60)

umask 077

# Talk to the host directly, never through a corporate proxy.
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY

SELF=$0
INSTALL_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)
CONFIG_FILE="$INSTALL_DIR/insomnia.conf"

config_value() {
  [ -r "$CONFIG_FILE" ] && sed -n "s/^$1=//p" "$CONFIG_FILE" 2>/dev/null | head -n 1
}

BASE_URL=${INSOMNIA_URL:-$(config_value url)}
BASE_URL=${BASE_URL:-http://host.docker.internal:47391}
BASE_URL=${BASE_URL%/}

INTERVAL=${INSOMNIA_HEARTBEAT_INTERVAL:-60}
case $INTERVAL in ''|*[!0-9]*) INTERVAL=60 ;; esac
[ "$INTERVAL" -lt 1 ] && INTERVAL=1
MAX_SECONDS=21600 # a heartbeat never outlives 6 hours, whatever happens

STATE_DIR="${TMPDIR:-/tmp}/insomnia-$(id -u 2>/dev/null || echo 0)"

detect_origin() {
  if [ -f /.dockerenv ] || [ -f /run/.containerenv ] || [ -n "${REMOTE_CONTAINERS:-}" ] || [ -n "${CODESPACES:-}" ]; then
    echo devcontainer
  elif [ -n "${WSL_DISTRO_NAME:-}" ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop ]; then
    echo wsl
  else
    echo remote
  fi
}
ORIGIN=$(detect_origin)
HOST_LABEL=$(hostname 2>/dev/null || cat /etc/hostname 2>/dev/null)
HOST_LABEL=$(printf '%s' "$HOST_LABEL" | tr -cd 'A-Za-z0-9._-' | cut -c1-64)

with_timeout() {
  _secs=$1; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$_secs" "$@"; else "$@"; fi
}

# http_post <path> <body-file> — prints the response body, fails quietly.
http_post() {
  if command -v curl >/dev/null 2>&1; then
    curl -sS -f --noproxy '*' --connect-timeout 1 --max-time 3 \
      -H 'Content-Type: application/json' \
      -H "X-Insomnia-Origin: $ORIGIN" -H "X-Insomnia-Host: $HOST_LABEL" \
      --data-binary "@$2" "$BASE_URL$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    with_timeout 4 wget -q -O - -T 3 \
      --header='Content-Type: application/json' \
      --header="X-Insomnia-Origin: $ORIGIN" --header="X-Insomnia-Host: $HOST_LABEL" \
      --post-file="$2" "$BASE_URL$1" 2>/dev/null
  else
    return 1
  fi
}

# json_field <name> <file> — first "name":"value" in the head of the event.
# Claude Code writes session_id and hook_event_name before the (possibly huge)
# tool input/output, so the first 16 KB always hold them.
json_field() {
  head -c 16384 "$2" 2>/dev/null | tr -d '\r\n' \
    | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n 1 \
    | sed 's/^.*:[[:space:]]*"\(.*\)"$/\1/'
}

# The Claude process that ran this hook: the nearest ancestor named claude*
# (the native binary is "claude"; an npm install shows up as "claude.exe").
find_claude_pid() {
  _pid=$PPID
  _depth=0
  while [ -n "$_pid" ] && [ "$_pid" -gt 1 ] 2>/dev/null && [ "$_depth" -lt 8 ]; do
    _comm=$(cat "/proc/$_pid/comm" 2>/dev/null) || return 0
    case $_comm in claude*) echo "$_pid"; return 0 ;; esac
    _stat=$(cat "/proc/$_pid/stat" 2>/dev/null) || return 0
    _stat=${_stat##*) }   # drop "pid (comm) " — comm may contain spaces
    # shellcheck disable=SC2086
    set -- $_stat         # now: state ppid ...
    _pid=$2
    _depth=$((_depth + 1))
  done
  return 0
}

# Is <pid> our heartbeat for <session>? Guards against a recycled pid.
is_heartbeat_process() {
  tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -q -- "--heartbeat $2"
}

ensure_heartbeat() {
  _pidfile="$STATE_DIR/heartbeat-$1.pid"
  if [ -r "$_pidfile" ]; then
    _hb=$(cat "$_pidfile" 2>/dev/null)
    case $_hb in
      ''|*[!0-9]*) ;;
      *) if kill -0 "$_hb" 2>/dev/null && is_heartbeat_process "$_hb" "$1"; then return 0; fi ;;
    esac
  fi
  _claude=$(find_claude_pid)
  # Detached, with no inherited pipes: Claude Code waits for a hook's output to
  # close, so anything still attached would stall it.
  if command -v setsid >/dev/null 2>&1; then
    setsid sh "$SELF" --heartbeat "$1" "$_claude" </dev/null >/dev/null 2>&1 &
  else
    nohup sh "$SELF" --heartbeat "$1" "$_claude" </dev/null >/dev/null 2>&1 &
  fi
  return 0
}

run_heartbeat() {
  sid=$(printf '%s' "$1" | tr -cd 'A-Za-z0-9._-')
  claude_pid=$2
  [ -n "$sid" ] || return 0
  trap '' HUP
  pidfile="$STATE_DIR/heartbeat-$sid.pid"
  turnfile="$STATE_DIR/turn-$sid"
  body="$STATE_DIR/heartbeat-$sid.$$.json"
  echo $$ > "$pidfile"
  printf '{"session_id":"%s"}' "$sid" > "$body"
  started=$(date +%s)
  while :; do
    sleep "$INTERVAL"
    [ "$(cat "$pidfile" 2>/dev/null)" = "$$" ] || break    # replaced by a newer heartbeat
    [ "$(cat "$turnfile" 2>/dev/null)" = open ] || break    # turn ended
    if [ -n "$claude_pid" ] && ! kill -0 "$claude_pid" 2>/dev/null; then break; fi  # Claude exited
    [ $(( $(date +%s) - started )) -lt "$MAX_SECONDS" ] || break
    resp=$(http_post /v1/heartbeat/claude-code "$body")
    case $resp in *turn=closed*) break ;; esac              # Insomnia saw the turn end
  done
  [ "$(cat "$pidfile" 2>/dev/null)" = "$$" ] && rm -f "$pidfile"
  rm -f "$body"
}

owned_by_me() {
  [ -n "$(find "$1" -maxdepth 0 -user "$(id -u)" 2>/dev/null)" ]
}

handle_event() {
  if [ "${INSOMNIA_DISABLED:-}" = 1 ]; then cat >/dev/null 2>&1; return 0; fi
  mkdir -p "$STATE_DIR" 2>/dev/null
  # The state folder holds pid files we act on; never use one someone else made.
  if [ ! -d "$STATE_DIR" ] || ! owned_by_me "$STATE_DIR"; then cat >/dev/null 2>&1; return 0; fi
  evt=$(mktemp "$STATE_DIR/event.XXXXXX" 2>/dev/null) || { cat >/dev/null 2>&1; return 0; }
  cat > "$evt" 2>/dev/null

  event=$(json_field hook_event_name "$evt")
  sid=$(json_field session_id "$evt" | tr -cd 'A-Za-z0-9._-')

  http_post /v1/hooks/claude-code "$evt" >/dev/null 2>&1
  rm -f "$evt"

  [ -n "$sid" ] || return 0
  case $event in
    Stop|StopFailure) printf closed > "$STATE_DIR/turn-$sid" ;;
    SessionEnd)       rm -f "$STATE_DIR/turn-$sid" ;;
    Notification|'')  ;;
    *)                printf open > "$STATE_DIR/turn-$sid"; ensure_heartbeat "$sid" ;;
  esac
  return 0
}

if [ "${1:-}" = --heartbeat ]; then
  run_heartbeat "${2:-}" "${3:-}"
else
  handle_event
fi
exit 0
