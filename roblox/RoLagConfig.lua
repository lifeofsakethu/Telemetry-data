-- RoLagConfig
-- Type: ModuleScript
-- Location: ServerScriptService
--
-- Keep this ModuleScript in ServerScriptService. Do not place it in
-- ReplicatedStorage because TELEMETRY_SECRET must never replicate to clients.

local Config = {}

-- Your deployed RoLag API URL. Do not add a trailing slash.
Config.API_URL = "https://telemetry-data.onrender.com"

-- Use the Roblox universe/game ID shown in the RoLag dashboard.
Config.GAME_ID = tostring(game.GameId)

-- This must exactly match Render's TELEMETRY_SECRET environment variable.
-- Generate a long random value and keep it server-side.
Config.TELEMETRY_SECRET = "REPLACE_WITH_YOUR_TELEMETRY_SECRET"

-- Ten to fifteen seconds is a safe default for server telemetry.
Config.INTERVAL = 10
Config.ENABLED = true

-- HTTP retry policy for temporary network failures.
Config.MAX_RETRIES = 3
Config.RETRY_BASE_DELAY = 1
Config.RETRY_MAX_DELAY = 8

-- FPS is sampled over this window to smooth out one-frame spikes.
Config.FPS_SAMPLE_WINDOW = 5

return Config
