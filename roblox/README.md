# RoLag Roblox scripts

These scripts are ready to paste into Roblox Studio and are designed for server execution.

## File placement

Create the following objects:

```text
ServerScriptService
├── RoLagConfig          ModuleScript
├── RoLagTelemetry       Script
└── RoLagPlayerSessions  Script
```

Paste the matching files into each object. Keep `RoLagConfig` in `ServerScriptService`; do not move it to `ReplicatedStorage`, because it contains the telemetry secret and must not replicate to clients.

## Configuration

Edit `RoLagConfig` before running the game:

```lua
Config.API_URL = "https://telemetry-data.onrender.com"
Config.GAME_ID = tostring(game.GameId)
Config.TELEMETRY_SECRET = "the-same-value-configured-as-Render-TELEMETRY_SECRET"
```

The `GAME_ID` can remain automatic if the place belongs to the correct Roblox universe. The game must also be registered in the RoLag dashboard using the same universe ID.

## Studio settings

In Roblox Studio, enable **Game Settings → Security → Allow HTTP Requests**. Publish the experience and test with a server-side Script. Do not use a LocalScript for telemetry.

## What the scripts send

`RoLagTelemetry` sends one server-side metric at the configured interval. Each metric includes the universe ID, place ID, server/job ID, estimated server FPS, player count, available server memory, uptime, and a server timestamp.

`RoLagPlayerSessions` sends join and leave events with the Roblox user ID, bounded username, place ID, server ID, and timestamp. It also attempts to flush leave events during server shutdown.

The FPS value is an estimate of the Roblox server’s simulation loop over a rolling sample window. It is not a measurement of individual player client FPS.

## Reliability behavior

Both scripts send the `x-telemetry-secret` header required by the RoLag API. Temporary HTTP failures retry with exponential backoff and jitter. Requests are bounded so telemetry does not create an excessive request rate. If delivery fails, a warning appears in the Roblox server output and the server keeps running.

## Troubleshooting

- **Telemetry authentication failed:** confirm the secret exactly matches Render’s `TELEMETRY_SECRET` value.
- **Game is not registered:** register the Roblox universe ID in the RoLag dashboard.
- **HTTP request errors:** confirm Allow HTTP Requests is enabled and the API URL has no trailing slash.
- **No live server:** wait for one telemetry interval and check the server output.
- **No player sessions:** confirm `RoLagPlayerSessions` is a Script under ServerScriptService, not a LocalScript.
