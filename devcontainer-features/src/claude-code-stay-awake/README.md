# Insomnia: keep the host awake for Claude Code (`claude-code-stay-awake`)

Lets [Insomnia](https://github.com/stanley-projects/Insomnia) on your Windows PC see Claude Code working **inside a dev container**, so the PC doesn't go to sleep — and pause your container — in the middle of a task.

## Usage

```jsonc
// .devcontainer/devcontainer.json
"features": {
  "ghcr.io/stanley-projects/insomnia/claude-code-stay-awake:1": {}
}
```

Rebuild the container. That's it — with the Claude Code integration switched on in Insomnia, the tray shows *"Staying awake for — Claude Code (dev container)"* while Claude works.

**Not published yet, or using a fork?** Copy this folder into your project's `.devcontainer/` and reference it locally:

```jsonc
"features": { "./claude-code-stay-awake": {} }
```

**Want it in every dev container?** Add it once to your VS Code user settings instead of each repo:

```jsonc
"dev.containers.defaultFeatures": {
  "ghcr.io/stanley-projects/insomnia/claude-code-stay-awake:1": {}
}
```

## Options

| Option | Default | Description |
|---|---|---|
| `hostAddress` | `host.docker.internal` | How the container reaches the PC running Insomnia. |
| `bridgePort` | `47391` | Insomnia's bridge port. Change only if you set `bridgePort` in Insomnia's `config.json`. |

At runtime, environment variables override these: `INSOMNIA_URL` (e.g. `http://host.docker.internal:47391`) and `INSOMNIA_DISABLED=1` to switch the hook off.

## How it works

- The feature installs `/usr/local/share/insomnia/claude-hook.sh` and registers it through Claude Code's managed-settings drop-in folder (`/etc/claude-code/managed-settings.d/50-insomnia.json`, Claude Code 2.1.83+). That lives in the image, so it works even when `~/.claude` is a mounted volume, never touches your own `settings.json`, and covers both the `claude` CLI and the VS Code extension in the container.
- On each hook event the script posts the event to Insomnia's loopback endpoint on the host (`http://host.docker.internal:47391`). Docker Desktop forwards that name to the Windows host.
- While a turn is open it sends a heartbeat every 60 seconds. Windows can't see processes inside the container, so the heartbeat is how Insomnia tells a long build (stay awake) from a container that has stopped (let the PC sleep within about 2½ minutes). The heartbeat stops when the turn ends, when Claude exits, or after 6 hours at most.
- It never gets in Claude's way: no output, always exits 0, 1-second connect timeout. If Insomnia isn't running, nothing happens.
- It needs `curl` or `wget`; the feature installs `curl` if the image has neither.

## Firewalled containers

Containers that block outbound traffic — such as Anthropic's reference Claude Code dev container with its `init-firewall.sh` — also block the host bridge. Allow it in the firewall script, before the final `REJECT` rule:

```bash
# Let Claude Code hooks reach Insomnia on the host
INSOMNIA_IP=$(getent hosts host.docker.internal | awk '{print $1; exit}')
if [ -n "$INSOMNIA_IP" ]; then
  iptables -A OUTPUT -p tcp -d "$INSOMNIA_IP" --dport 47391 -j ACCEPT
fi
```

## Troubleshooting

From a terminal inside the container:

```bash
curl -s http://host.docker.internal:47391/v1/ping
# {"app":"insomnia","version":"…","integrations":{"claude-code":true}}
```

- **Connection refused / no answer** — Insomnia isn't running on the host, its Claude Code integration is off, or something else holds port 47391 (set `bridgePort` in both places).
- **`"claude-code": false`** — switch the Claude Code integration on in Insomnia.
- **`host.docker.internal` doesn't resolve** — you're not on Docker Desktop. On Docker Engine for Linux, add `"runArgs": ["--add-host=host.docker.internal:host-gateway"]`; note that Insomnia listens on Windows' loopback, which a Docker Engine running inside WSL can only reach with WSL's mirrored networking mode.
