#!/bin/bash
# Run by `devcontainer features test` inside a container built with the feature.
set -e

# shellcheck source=/dev/null
source dev-container-features-test-lib

HOOK=/usr/local/share/insomnia/claude-hook.sh
DROPIN=/etc/claude-code/managed-settings.d/50-insomnia.json

check "hook script installed and executable" test -x "$HOOK"
check "bridge address configured" grep -q '^url=http://host.docker.internal:47391$' /usr/local/share/insomnia/insomnia.conf
check "managed-settings drop-in installed" test -f "$DROPIN"
check "drop-in registers the hook for Stop" grep -q '"Stop"' "$DROPIN"
check "drop-in readable by every user" bash -c "[ \"\$(stat -c %a $DROPIN)\" = 644 ]"
check "an HTTP client is available" bash -c 'command -v curl || command -v wget'
# With no Insomnia reachable the hook must stay silent, succeed, and be quick.
check "hook exits 0 and prints nothing when the host is unreachable" bash -c \
  "out=\$(echo '{\"session_id\":\"t1\",\"hook_event_name\":\"UserPromptSubmit\"}' | INSOMNIA_URL=http://127.0.0.1:9 timeout 5 $HOOK); [ \$? -eq 0 ] && [ -z \"\$out\" ]"
check "Stop is accepted and closes the turn" bash -c \
  "echo '{\"session_id\":\"t1\",\"hook_event_name\":\"Stop\"}' | INSOMNIA_URL=http://127.0.0.1:9 timeout 5 $HOOK && grep -qx closed \"\${TMPDIR:-/tmp}/insomnia-\$(id -u)/turn-t1\""
check "hook does nothing when disabled" bash -c \
  "echo '{}' | INSOMNIA_DISABLED=1 $HOOK"

reportResults
