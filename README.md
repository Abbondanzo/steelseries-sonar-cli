# steelseries-sonar-cli

CLI to get/set audio device routing in [SteelSeries Sonar](https://steelseries.com/gg/sonar) via its local HTTP API.

Requires SteelSeries GG with Sonar running.

## Usage

```
node index.js <command> [options]
```

### Commands

**`set`** - Set the monitoring output and/or microphone input device.

```
node index.js set --output <id-or-name> --input <id-or-name>
```

Values starting with `{` are treated as Windows audio endpoint IDs; anything else is matched as a partial name against Sonar's device list.

```sh
node index.js set --output "Arctis 9 Game"
node index.js set --input "Arctis 9 Chat"
node index.js set --output "Arctis 9 Game" --input "Arctis 9 Chat"
node index.js set --output "{0.0.0.00000000}.{9351f935-...}"
```

**`mute <channel>`** / **`unmute <channel>`** - Mute or unmute a channel.

**`volume <channel> <0.0-1.0>`** - Set a channel's volume.

Channels: `game`, `chatRender`, `chatCapture`, `media`, `aux`

```sh
node index.js mute chatCapture
node index.js unmute chatCapture
node index.js volume game 0.8
```

**`list [--all]`** - List audio devices known to Sonar. Sonar's own virtual devices are hidden by default.

```
node index.js list
node index.js list --all
```

**`get`** - Dump the current Sonar routing config (all known API endpoints).

## No dependencies

Uses only Node.js built-ins (`http`, `https`, `fs`, `path`). Node 14+ required.
