

## RoLag 2.1 integration update

The Roblox integration has been expanded with three paste-ready server-side files under `roblox/`. The new configuration module keeps the telemetry secret in `ServerScriptService`, preventing replication to clients. The telemetry script now includes server FPS sampling, memory and uptime reporting, secure headers, request retries with exponential backoff, jitter, and duplicate-request protection. The player session script records joins and leaves and attempts to flush remaining leave events during server shutdown.

The backend now preserves `GET /` as an API status response and serves the bundled dashboard under `/dashboard`. Superadmins can inspect ingestion configuration and in-memory telemetry counters through `/telemetry/status`. Documentation now includes exact Roblox Studio placement, security guidance, setup steps, and troubleshooting.
