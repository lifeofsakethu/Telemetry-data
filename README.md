# RoLag

RoLag is a Roblox server telemetry and performance observability platform. The repository contains the Render API and the static dashboard deployed to Netlify.

## Local development

```bash
npm install
JWT_SECRET="a-strong-secret-at-least-32-characters" \
MONGO_URI="mongodb://127.0.0.1:27017" \
TELEMETRY_SECRET="a-separate-telemetry-secret" \
node server.js
```

The API serves the dashboard from `public/` and listens on `PORT` (default `10000`).

## Render environment

Set these values in the Render service environment, never in source control:

- `MONGO_URI`
- `JWT_SECRET` (32+ characters)
- `TELEMETRY_SECRET` (used by Roblox server scripts as `x-telemetry-secret`)
- `RESEND_API_KEY` (optional)
- `EMAIL_FROM` (optional, defaults to Resend onboarding sender)
- `ADMIN_EMAIL` (optional)
- `ALLOWED_ORIGINS=https://rolag.netlify.app`
- `NSYS_MODE=false` or `true`
- `NSYS_MODULES=ping.js` when NSYS is enabled

## API highlights

Existing routes remain available: `/`, `/register`, `/login`, `/me/prefs`, `/register-game`, `/data`, `/session`, `/live/:gameId`, `/alerts/:gameId`, `/metrics/:gameId`, `/timeline/:serverId`, and `/root/:serverId`.

The upgrade adds authenticated game management, `/me`, `/games`, `/me/export`, `/me/import`, admin statistics and controls under `/admin/*`, health checks, per-user alert preferences, ownership checks, secure WebSocket subscriptions, telemetry authentication, MongoDB indexes, maintenance mode, and controlled NSYS modules.

## Roblox telemetry

Use server-side Scripts only. Set the same `TELEMETRY_SECRET` in the HTTP header sent by the scripts. The telemetry FPS is a server-side estimate and must not be presented as player client FPS.

## Deployment

Render is connected to the `main` branch and uses `npm install` followed by `node server.js`. The Netlify site can be deployed from the `public/` directory with the existing site ID.
