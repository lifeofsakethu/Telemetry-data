-- RoLagPlayerSessions
-- Type: Script
-- Location: ServerScriptService
-- Requires: RoLagConfig ModuleScript in ServerScriptService

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local ServerScriptService = game:GetService("ServerScriptService")

local Config = require(ServerScriptService:WaitForChild("RoLagConfig"))

if not Config.ENABLED then
	return
end

local SERVER_ID = game.JobId
if SERVER_ID == "" then
	SERVER_ID = "studio-" .. tostring(game.PlaceId)
end

local function waitForRetry(attempt)
	local base = Config.RETRY_BASE_DELAY or 1
	local maximum = Config.RETRY_MAX_DELAY or 8
	local delay = math.min(maximum, base * (2 ^ (attempt - 1)))
	task.wait(delay + math.random() * 0.25)
end

local function sendSession(player, action)
	local payload = {
		gameId = Config.GAME_ID,
		placeId = game.PlaceId,
		serverId = SERVER_ID,
		userId = player and player.UserId or 0,
		username = player and string.sub(player.Name, 1, 120) or "unknown",
		action = action,
		timestamp = os.time()
	}

	local attempts = Config.MAX_RETRIES or 3
	for attempt = 1, attempts do
		local success, response = pcall(function()
			return HttpService:RequestAsync({
				Url = Config.API_URL .. "/session",
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

		if attempt < attempts then
			waitForRetry(attempt)
		else
			warn("[RoLag] Session delivery failed for " .. payload.username .. ": " .. tostring(response))
		end
	end

	return false
end

Players.PlayerAdded:Connect(function(player)
	task.spawn(sendSession, player, "join")
end)

Players.PlayerRemoving:Connect(function(player)
	sendSession(player, "leave")
end)

-- Try to record remaining players when the server is shutting down.
game:BindToClose(function()
	local pending = {}
	for _, player in ipairs(Players:GetPlayers()) do
		table.insert(pending, task.spawn(sendSession, player, "leave"))
	end

	local deadline = os.clock() + 8
	while #pending > 0 and os.clock() < deadline do
		local stillRunning = 0
		for _, thread in ipairs(pending) do
			if coroutine.status(thread) ~= "dead" then
				stillRunning += 1
			end
		end
		if stillRunning == 0 then
			break
		end
		task.wait(0.1)
	end
end)
