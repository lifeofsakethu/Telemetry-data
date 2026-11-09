# RoLag Patch Notes

## Release: RoLag 2.0

**Release date:** 2026-11-09  
**Repository:** `lifeofsakethu/Telemetry-data`  
**Frontend:** [rolag.netlify.app](https://rolag.netlify.app)  
**Backend:** [telemetry-data.onrender.com](https://telemetry-data.onrender.com)

RoLag has been upgraded from a minimal telemetry API and placeholder dashboard into a production-ready Roblox server observability platform.

## Dashboard

- Replaced the generic LoadView page with a dedicated RoLag dashboard.
- Added a modern dark responsive interface for desktop and mobile.
- Added authenticated login and registration screens.
- Added overview metrics for:
  - Live servers
  - Average server FPS
  - Players online
  - Tracked games
- Added live server monitoring with server status, player count, FPS, memory, and last update information.
- Added historical metrics tables for FPS, player count, memory, and timestamps.
- Added FPS pulse visualization.
- Added alert history with low-FPS details.
- Added game registration and removal controls.
- Added alert preference management.
- Added admin navigation for superadmin accounts.
- Added account logout and responsive mobile navigation.
- Added user data export and import controls.
- Added clear loading, empty, error, and status states.
- Clearly labels telemetry as a server-side FPS estimate and does not claim to measure player client FPS.

## Authentication and authorization

- Added secure JWT-based authentication.
- Passwords are hashed with bcrypt.
- Added account status checks on authenticated requests.
- Added banned-account handling.
- Added role-based superadmin authorization.
- Added duplicate email protection.
- Added email and password validation.
- Added protection against users accessing other users’ games, telemetry, alerts, and metrics.
- Added authorization checks for WebSocket connections and game subscriptions.
- Added stronger error responses with appropriate HTTP status codes.

## Telemetry improvements

- Added secure telemetry authentication using the `TELEMETRY_SECRET` environment variable.
- Added validation for game ID, server ID, FPS, player count, memory, and uptime values.
- Added support for multiple Roblox servers per game.
- Added live server tracking with automatic inactive-server cleanup.
- Added server online and offline WebSocket events.
- Added server-side metric broadcasting to authorized dashboard users.
- Added protection against unauthorized telemetry ingestion.
- Added validation so telemetry is accepted only for registered games.
- Preserved the existing telemetry endpoints:
  - `POST /data`
  - `POST /session`
  - `GET /live/:gameId`
  - `GET /metrics/:gameId`
  - `GET /timeline/:serverId`
  - `GET /root/:serverId`

## Alert system

- Added independent alert preferences for every user.
- Added configurable minimum FPS threshold.
- Added configurable alert cooldown.
- Added email notification preference.
- Added dashboard notification preference.
- Added low-FPS alert persistence in MongoDB.
- Added user-specific WebSocket alert delivery.
- Added email failure handling so Resend failures do not stop telemetry ingestion.
- Added server ID, measured FPS, and configured threshold to alert records.

## Admin features

Added protected superadmin endpoints and dashboard capabilities for:

- Platform statistics.
- Total users.
- Total games.
- Total metrics.
- Total alerts.
- Active Roblox servers.
- Database status.
- Platform uptime.
- User search.
- User IDs and registration dates.
- User account status.
- Games owned by each user.
- Ban and unban actions.
- Maintenance mode activation and recovery.
- Maintenance announcements.
- NSYS status inspection.
- Administrative action logging.

Administrative logs do not expose passwords or secrets.

## NSYS Mode

Added controlled optional service loading through environment variables:

```env
NSYS_MODE=false
NSYS_MODULES=ping.js
```

NSYS modules:

- Load only from the approved `services/` directory.
- Validate module filenames.
- Prevent path traversal.
- Prevent duplicate loading.
- Load only after MongoDB connects.
- Receive controlled access to the Express app, database, broadcaster, logger, and configuration.
- Log successful and failed module initialization.

A sample `services/ping.js` module is included.

## Database

Added repeatable MongoDB initialization and indexes for:

- Unique user emails.
- Unique game identifiers.
- Game ownership.
- Game IDs and timestamps.
- Server IDs and timestamps.
- Alert history.
- Administrative logs.

Required collections are created automatically as data is written:

- `users`
- `games`
- `metrics`
- `alerts`
- `sessions`
- `adminLogs`
- `platformConfig`

## Reliability and deployment

- Added `/health` endpoint for deployment health checks.
- Added database-aware health reporting.
- Added graceful HTTP, WebSocket, and MongoDB shutdown handling.
- Ensured only one HTTP listener is created.
- WebSockets are attached to the same HTTP server.
- Added Render reverse-proxy support for accurate rate limiting.
- Added production startup logging.
- Added consistent JSON error responses.
- Added request body size limits.
- Upgraded bcrypt and Resend dependency versions.
- Reduced dependency audit findings to low-severity issues only.
- Added `.gitignore` coverage for dependencies, secrets, logs, and local environment files.
- Added deployment and configuration documentation in `README.md`.

## Environment variables

Configure these values on Render and do not commit them to GitHub:

```env
PORT=10000
MONGO_URI=your-mongodb-atlas-connection-string
JWT_SECRET=your-strong-32-character-or-longer-secret
TELEMETRY_SECRET=your-telemetry-secret
RESEND_API_KEY=your-resend-key
ADMIN_EMAIL=your-admin-email
EMAIL_FROM=RoLag <your-sender-domain>
ALLOWED_ORIGINS=https://rolag.netlify.app
NSYS_MODE=false
NSYS_MODULES=ping.js
```

## Roblox integration notes

- Enable **Allow HTTP Requests** in Roblox Studio.
- Run telemetry from server-side Scripts, not LocalScripts.
- Send the telemetry secret in the `x-telemetry-secret` request header.
- Do not expose telemetry secrets in publicly distributed client code.
- Use the server-side FPS estimate for server performance monitoring only.
- Keep telemetry intervals reasonable to avoid excessive HTTP traffic.

## Deployment verification

The release was verified in production:

- Render deployment status: **live**.
- MongoDB connectivity: **healthy**.
- API health response: `status: ok`, `database: true`.
- Netlify deployment status: **ready**.
- Netlify dashboard title: `RoLag · Roblox observability`.

## Git commits

- `493833e` — Complete RoLag observability platform
- `50e81c5` — Respect Render proxy headers
