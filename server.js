const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const app = express();
app.use(cors());
app.use(express.json());

// ========================
// MEMORY DATA (TEMP CACHE)
// ========================
let heatmap = {};
let loadTimes = [];
let serverHistory = {};
let servers = {};

// ========================
// MONGODB SETUP
// ========================
const client = new MongoClient(process.env.MONGO_URI);
let db;

async function connectDB() {
	try {
		await client.connect();
		db = client.db("loadview");
		console.log("✅ MongoDB Connected");
	} catch (err) {
		console.error("❌ MongoDB Error:", err);
	}
}
connectDB();

// ========================
// ROOT
// ========================
app.get("/", (req, res) => {
	res.send("Roblox Analytics API Running");
});

// ========================
// TEST DB SAVE
// ========================
app.get("/testdb", async (req, res) => {
	try {
		await db.collection("test").insertOne({
			msg: "hello from render",
			time: new Date()
		});
		res.send("Saved to MongoDB");
	} catch (err) {
		res.status(500).send("Error saving");
	}
});

// ========================
// ROBLOX DATA
// ========================
app.post("/data", async (req, res) => {
	try {
		const data = req.body;

		// Save to MongoDB
		await db.collection("metrics").insertOne({
			...data,
			time: new Date()
		});

		// HEATMAP UPDATE
		if (data.x && data.z && data.fps) {
			let key = `${Math.floor(data.x)}_${Math.floor(data.z)}`;

			if (!heatmap[key]) {
				heatmap[key] = { totalFPS: 0, count: 0 };
			}

			heatmap[key].totalFPS += data.fps;
			heatmap[key].count++;
		}

		// LOAD TIME TRACK
		if (data.loadTime) {
			loadTimes.push(data.loadTime);
		}

		// SERVER TRACKING
		if (data.serverId) {
			if (!servers[data.serverId]) {
				servers[data.serverId] = {
					lastUpdate: Date.now(),
					players: 0
				};
			}

			servers[data.serverId].lastUpdate = Date.now();
			servers[data.serverId].players = data.players || 0;

			if (!serverHistory[data.serverId]) {
				serverHistory[data.serverId] = [];
			}

			serverHistory[data.serverId].push({
				time: Date.now(),
				players: data.players || 0,
				fps: data.fps || 0
			});
		}

		res.send("ok");
	} catch (err) {
		console.error(err);
		res.status(500).send("error");
	}
});

// ========================
// SESSION SAVE
// ========================
app.post("/session", async (req, res) => {
	try {
		await db.collection("sessions").insertOne({
			...req.body,
			time: new Date()
		});

		res.send("saved");
	} catch (err) {
		res.status(500).send("error");
	}
});

// ========================
// HEATMAP
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
// AUTO CLEANUP
// ========================
setInterval(() => {
	const now = Date.now();

	for (let id in servers) {
		if (now - servers[id].lastUpdate > 30000) {
			delete servers[id];
			delete serverHistory[id];
		}
	}
}, 10000);

// ========================
// START SERVER (ONLY ONCE)
// ========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log("🚀 Server running on port", PORT);
});
