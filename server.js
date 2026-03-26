const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const app = express();
app.use(cors());
app.use(express.json());

// 🔗 MongoDB setup
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

// 🧪 TEST ROUTE
app.get("/", (req, res) => {
	res.send("API running");
});

// 🧪 TEST DB SAVE
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

// 🎮 ROBLOX DATA ENDPOINT
app.post("/data", async (req, res) => {
	try {
		const data = req.body;

		await db.collection("metrics").insertOne({
			...data,
			time: new Date()
		});

		res.send("ok");
	} catch (err) {
		console.error(err);
		res.status(500).send("error");
	}
});

// 🚪 SESSION SAVE (on player leave)
app.post("/session", async (req, res) => {
	try {
		const data = req.body;

		await db.collection("sessions").insertOne({
			...data,
			time: new Date()
		});

		res.send("saved");
	} catch (err) {
		res.status(500).send("error");
	}
});

// 🌐 PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log("🚀 Server running on port " + PORT);
});// GET HEATMAP
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
