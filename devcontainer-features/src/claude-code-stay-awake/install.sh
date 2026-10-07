#!/bin/sh
# Dev Container Feature install script — runs as root while the image builds.
#
# Installs the Insomnia hook for Claude Code and registers it through Claude
# Code's managed-settings drop-in folder. That folder lives in /etc, inside the
# image, so it works even when ~/.claude is a mounted volume (as in Anthropic's
# reference dev container), never touches the user's own settings.json, and
# applies to the CLI and the VS Code extension alike.
set -eu

FEATURE_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
INSTALL_DIR=/usr/local/share/insomnia
MANAGED_DIR=/etc/claude-code/managed-settings.d

# Feature options arrive as upper-cased environment variables.
HOST_ADDRESS=${HOSTADDRESS:-host.docker.internal}
BRIDGE_PORT=${BRIDGEPORT:-47391}

case $BRIDGE_PORT in
  ''|*[!0-9]*) echo "insomnia: bridgePort must be a number, got '$BRIDGE_PORT'" >&2; exit 1 ;;
esac
if [ "$BRIDGE_PORT" -lt 1 ] || [ "$BRIDGE_PORT" -gt 65535 ]; then
  echo "insomnia: bridgePort out of range: $BRIDGE_PORT" >&2; exit 1
fi
case $HOST_ADDRESS in
  ''|*[!A-Za-z0-9._:-]*) echo "insomnia: hostAddress must be a host name or IPv4 address, got '$HOST_ADDRESS'" >&2; exit 1 ;;
esac

echo "insomnia: installing Claude Code hook (reports to http://$HOST_ADDRESS:$BRIDGE_PORT)"

CREATED_MANAGED_DIR=false
[ -d "$MANAGED_DIR" ] || CREATED_MANAGED_DIR=true

mkdir -p "$INSTALL_DIR" "$MANAGED_DIR"
cp "$FEATURE_DIR/claude-hook.sh" "$INSTALL_DIR/claude-hook.sh"
chmod 0755 "$INSTALL_DIR" "$INSTALL_DIR/claude-hook.sh"
printf 'url=http://%s:%s\n' "$HOST_ADDRESS" "$BRIDGE_PORT" > "$INSTALL_DIR/insomnia.conf"
chmod 0644 "$INSTALL_DIR/insomnia.conf"

# A real file, not a link: Claude Code warns about links that point outside
# the managed settings folder.
cp "$FEATURE_DIR/insomnia-hooks.json" "$MANAGED_DIR/50-insomnia.json"
chmod 0644 "$MANAGED_DIR/50-insomnia.json"
# Readable by the (non-root) user Claude runs as; existing folders keep their mode.
if [ "$CREATED_MANAGED_DIR" = true ]; then chmod 0755 /etc/claude-code "$MANAGED_DIR"; fi

# The hook needs curl or wget to reach the host.
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  echo "insomnia: neither curl nor wget found, installing curl"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    { apt-get update -y && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*; } \
      || echo "insomnia: warning: could not install curl" >&2
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache curl || echo "insomnia: warning: could not install curl" >&2
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y curl || echo "insomnia: warning: could not install curl" >&2
  elif command -v microdnf >/dev/null 2>&1; then
    microdnf install -y curl || echo "insomnia: warning: could not install curl" >&2
  elif command -v yum >/dev/null 2>&1; then
    yum install -y curl || echo "insomnia: warning: could not install curl" >&2
  else
    echo "insomnia: warning: no curl or wget and no known package manager; the hook will be inactive" >&2
  fi
fi

echo "insomnia: done"
