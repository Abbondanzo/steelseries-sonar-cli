# SteelSeries Sonar Local HTTP API

Discovered by running the app and observing requests. All endpoints are on a local HTTP server whose address is read at runtime (see [Connection](#connection)).

---

## Connection

The Sonar web server address is found in two steps:

**1. Read the Engine address**

```
%ProgramData%\SteelSeries\SteelSeries Engine 3\coreProps.json
  → .ggEncryptedAddress   e.g. "localhost:56427"
```

**2. Get the Sonar web server address**

```
GET https://<ggEncryptedAddress>/subApps
```

The Engine uses a self-signed TLS cert — disable certificate verification.

Response (relevant fields):

```json
{
  "subApps": {
    "sonar": {
      "isEnabled": true,
      "isReady": true,
      "isRunning": true,
      "metadata": {
        "webServerAddress": "http://127.0.0.1:61432"
      }
    }
  }
}
```

All subsequent calls use `http://127.0.0.1:<port>` — plain HTTP, no TLS.

---

## Endpoints

### `GET /audioDevices`

Returns every audio device Sonar is aware of, both render (output) and capture (input).

```json
[
  {
    "friendlyName": "Headphones (SteelSeries Arctis 9 Game)",
    "id": "{0.0.0.00000000}.{9351f935-0a8a-41a8-ba9a-95428158e584}",
    "dataFlow": "render",
    "role": "none",
    "channels": 2,
    "defaultRole": "console",
    "fwUpdateRequired": false,
    "state": "active",
    "isVad": false
  },
  {
    "friendlyName": "SteelSeries Sonar - Gaming (SteelSeries Sonar Virtual Audio Device)",
    "id": "{0.0.0.00000000}.{419fbfac-dace-430b-afe2-8723c40d7156}",
    "dataFlow": "render",
    "role": "game",
    "channels": 8,
    "defaultRole": "multimedia",
    "fwUpdateRequired": false,
    "state": "active",
    "isVad": true
  }
]
```

Key fields:

| Field      | Values                                                                        | Meaning                                                                                             |
| ---------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `dataFlow` | `"render"` / `"capture"`                                                      | Output vs input device                                                                              |
| `isVad`    | `true` / `false`                                                              | Sonar virtual audio device (its own mixing endpoints) vs real hardware                              |
| `role`     | `"none"`, `"game"`, `"media"`, `"aux"`, `"chatRender"`, `"chatCapture"`       | Which Sonar channel this device is assigned to (`"none"` = real hardware not assigned to a channel) |
| `id`       | `"{0.0.0.00000000}.{GUID}"` (render) or `"{0.0.1.00000000}.{GUID}"` (capture) | Windows audio endpoint device ID used in all routing calls                                          |

---

### `GET /streamRedirections/`

Returns the current routing state for each stream type.

```json
[
  {
    "streamRedirectionId": "streaming",
    "deviceId": "",
    "status": [
      { "role": "chatCapture", "isEnabled": true },
      { "role": "chatRender", "isEnabled": false },
      { "role": "game", "isEnabled": false },
      { "role": "media", "isEnabled": false },
      { "role": "aux", "isEnabled": false }
    ],
    "isRunning": false
  },
  {
    "streamRedirectionId": "monitoring",
    "deviceId": "{0.0.0.00000000}.{9351f935-0a8a-41a8-ba9a-95428158e584}",
    "status": [
      { "role": "chatCapture", "isEnabled": false },
      { "role": "chatRender", "isEnabled": true },
      { "role": "game", "isEnabled": true },
      { "role": "media", "isEnabled": true },
      { "role": "aux", "isEnabled": true }
    ],
    "isRunning": true
  },
  {
    "streamRedirectionId": "mic",
    "deviceId": "{0.0.1.00000000}.{f4c34b53-7131-495e-b456-12e2b42dcc56}",
    "status": [],
    "isRunning": true
  }
]
```

The three `streamRedirectionId` values:

| ID           | Purpose                                                  |
| ------------ | -------------------------------------------------------- |
| `monitoring` | What you hear — the render device for the monitoring mix |
| `mic`        | Which physical microphone Sonar captures from            |
| `streaming`  | Output device for the streaming/recording mix            |

---

### `PUT /streamRedirections/monitoring/deviceId/<encoded-id>`

Sets the **monitoring output device** (speakers / headphones).

- `<encoded-id>` is the device's `id` from `/audioDevices`, URL-encoded (`{` → `%7B`, `}` → `%7D`)
- Device must have `dataFlow: "render"`

Returns the updated `streamRedirections` object for `"monitoring"`.

---

### `PUT /streamRedirections/mic/deviceId/<encoded-id>`

Sets the **microphone input device**.

- `<encoded-id>` is the device's `id` from `/audioDevices`, URL-encoded
- Device must have `dataFlow: "capture"`

Returns the updated `streamRedirections` object for `"mic"`.

---

### `GET /volumeSettings/streamer`

Returns volume and mute state for all channels, in both monitoring and streaming mixes.

```json
{
  "masters": { ... },
  "devices": {
    "game":        { "stream": { "streaming": { "volume": 1, "muted": false }, "monitoring": { ... } }, "classic": { ... } },
    "chatRender":  { ... },
    "chatCapture": { ... },
    "media":       { ... },
    "aux":         { ... }
  }
}
```

Channel names: `game`, `chatRender`, `chatCapture`, `media`, `aux`

---

### `PUT /volumeSettings/streamer/monitoring/<channel>/Volume/<float>`

Sets the **monitoring mix volume** for a channel. Float is `0.0`–`1.0`.

### `PUT /volumeSettings/streamer/streaming/<channel>/Volume/<float>`

Sets the **streaming mix volume** for a channel.

### `PUT /volumeSettings/streamer/<channel>/Mute/<bool>`

Mutes or unmutes a channel. Bool is `true` or `false` (JSON-encoded in the path).

---

### `PUT /streamRedirections/streaming/redirections/<channel>/isEnabled/<bool>`

Enables or disables a channel in the **streaming mix**.

---

## Notes

- All device IDs use Windows audio endpoint format: `{0.0.0.00000000}.{GUID}` for render, `{0.0.1.00000000}.{GUID}` for capture.
- The Sonar virtual audio devices (`isVad: true`) are Sonar's own internal mixing endpoints — do not use them as monitoring or mic targets.
- The API is only available while SteelSeries Engine and Sonar are running.
- Only **streamer mode** has been tested. Classic mode may differ.
