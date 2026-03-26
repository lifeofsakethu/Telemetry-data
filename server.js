const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

// ========================
// STORAGE (in-memory)
// ========================
let servers = {};
let heatmap = {};
let loadTimes = {};
let serverHistory = {};

// ========================
// CONFIG
// ========================
const GRID_SIZE = 20;
const MAX_HISTORY = 50;

// ========================
// UTILS
// ========================
function getCell(pos) {
	if (!pos) return null;
	const x = Math.floor(pos.x / GRID_SIZE);
	const z = Math.floor(pos.z / GRID_SIZE);
	return `${x},${z}`;
}

// ========================
// MAIN ENDPOINT (ROBLOX POSTS HERE)
// ========================
app.post("/server", (req, res) => {
	const s = req.body;

	if (!s || !s.jobId) {
		return res.status(400).send("Invalid data");
	}

	// STORE SERVER
	servers[s.jobId] = {
		...s,
		lastUpdate: Date.now()
	};

	// ========================
	// SERVER HISTORY (GRAPH)
	// ========================
	if (!serverHistory[s.jobId]) serverHistory[s.jobId] = [];

	serverHistory[s.jobId].push({
		time: Date.now(),
		fps: s.serverFPS,
		ping: s.avgPing
	});

	if (serverHistory[s.jobId].length > MAX_HISTORY) {
		serverHistory[s.jobId].shift();
	}

	// ========================
	// PROCESS PLAYERS
	// ========================
	for (let id in s.players) {
		let p = s.players[id];

		// LOAD TIMES
		if (p.LoadTime) {
			loadTimes[id] = p.LoadTime;
		}

		// HEATMAP
		if (p.Position) {
			let cell = getCell(p.Position);
			if (!cell) continue;

			if (!heatmap[cell]) {
				heatmap[cell] = {
					count: 0,
					totalFPS: 0
				};
			}

			heatmap[cell].count++;
			heatmap[cell].totalFPS += p.AvgFPS || 0;
		}
	}

	res.sendStatus(200);
});

// ========================
// GET SERVERS
// ========================
app.get("/servers", (req, res) => {
	res.json(servers);
});

// ========================
// GET HEATMAP
// ========================
app.get("/heatmap", (req, res) => {
	let out = {};

	for (let cell in heatmap) {
		let d = heatmap[cell];

		out[cell] = {
			avgFPS: Math.floor(d.totalFPS / d.count),
			count: d.count
		};
	}

	res.json(out);
});

// ========================
// LOAD TIMES
// ========================
app.get("/loadtimes", (req, res) => {
	res.json(loadTimes);
});

// ========================
// SERVER HISTORY
// ========================
app.get("/server-history", (req, res) => {
	res.json(serverHistory);
});

// ========================
// HEALTH CHECK
// ========================
app.get("/", (req, res) => {
	res.send("Roblox Analytics API Running");
});

// ========================
// AUTO CLEANUP (IMPORTANT)
// ========================
setInterval(() => {
	const now = Date.now();

	for (let id in servers) {
		// remove inactive servers (30s)
		if (now - servers[id].lastUpdate > 30000) {
			delete servers[id];
			delete serverHistory[id];
		}
	}
}, 10000);

// ========================
// START SERVER
// ========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log("Server running on port", PORT);
});
