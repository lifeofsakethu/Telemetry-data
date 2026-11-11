-- RoLagTelemetry
-- Type: Script
-- Location: ServerScriptService
-- Requires: RoLagConfig ModuleScript in ServerScriptService

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local Stats = game:GetService("Stats")
local ServerScriptService = game:GetService("ServerScriptService")

local Config = require(ServerScriptService:WaitForChild("RoLagConfig"))

if not Config.ENABLED then
	warn("[RoLag] Telemetry is disabled in RoLagConfig")
	return
end

local function validateConfig()
	if Config.API_URL == "" or string.find(Config.API_URL, "YOUR%-ROLAG") then
		warn("[RoLag] Set Config.API_URL before enabling telemetry")
		return false
	end
	if Config.TELEMETRY_SECRET == "" or Config.TELEMETRY_SECRET == "REPLACE_WITH_YOUR_TELEMETRY_SECRET" then
		warn("[RoLag] Set Config.TELEMETRY_SECRET before enabling telemetry")
		return false
	end
	return true
end

if not validateConfig() then
	return
end

local SERVER_ID = game.JobId
if SERVER_ID == "" then
	SERVER_ID = "studio-" .. tostring(game.PlaceId)
end

local startedAt = os.clock()
local frameCount = 0
local elapsedTime = 0
local estimatedFPS = 0
local requestInFlight = false

RunService.Heartbeat:Connect(function(deltaTime)
	frameCount += 1
	elapsedTime += deltaTime

	if elapsedTime >= (Config.FPS_SAMPLE_WINDOW or 5) then
		estimatedFPS = frameCount / elapsedTime
		frameCount = 0
		elapsedTime = 0
	end
end)

local function getMemoryMb()
	local success, result = pcall(function()
		return Stats:GetTotalMemoryUsageMb()
	end)
	return success and tonumber(result) or nil
end

local function round(value)
	return math.floor(value + 0.5)
end

local function waitForRetry(attempt)
	local base = Config.RETRY_BASE_DELAY or 1
	local maximum = Config.RETRY_MAX_DELAY or 8
	local delay = math.min(maximum, base * (2 ^ (attempt - 1)))
	task.wait(delay + math.random() * 0.25)
end

local function postJson(endpoint, payload)
	local attempts = Config.MAX_RETRIES or 3
	local lastError = "unknown error"

	for attempt = 1, attempts do
		local success, response = pcall(function()
			return HttpService:RequestAsync({
				Url = Config.API_URL .. endpoint,
				Method = "POST",
				Headers = {
					["Content-Type"] = "application/json",
					["x-telemetry-secret"] = Config.TELEMETRY_SECRET,
					["User-Agent"] = "RoLag-Roblox-Server/2.0"
				},
				Body = HttpService:JSONEncode(payload)
			})
		end)

		if success and response and response.Success then
			return true
		end

		if success and response then
			lastError = "HTTP " .. tostring(response.StatusCode)
		else
			lastError = tostring(response)
		end

		if attempt < attempts then
			waitForRetry(attempt)
		end
	end

	return false, lastError
end

local function buildTelemetry()
	return {
		gameId = Config.GAME_ID,
		placeId = game.PlaceId,
		serverId = SERVER_ID,
		jobId = game.JobId,
		fps = round(estimatedFPS),
		players = #Players:GetPlayers(),
		memoryMb = getMemoryMb(),
		uptime = math.floor(os.clock() - startedAt),
		timestamp = os.time()
	}
end

local function sendTelemetry()
	if requestInFlight then
		return
	end

	requestInFlight = true
	local success, err = postJson("/data", buildTelemetry())
	requestInFlight = false

	if not success then
		warn("[RoLag] Telemetry delivery failed after retries: " .. tostring(err))
	end
end

-- Send on a controlled interval. This is intentionally server-side and not a LocalScript.
while task.wait(Config.INTERVAL or 10) do
	sendTelemetry()
end
