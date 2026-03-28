const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const app = express();
app.use(cors());
app.use(express.json());

// ========================
// 🔗 MONGODB
// ========================
const client = new MongoClient(process.env.MONGO_URI);

let db;

async function connectDB() {
	try {
		await client.connect();
		db = client.db("loadview"); // your DB name
		console.log("✅ MongoDB Connected");
	} catch (err) {
		console.error("❌ MongoDB Error:", err);
	}
}

connectDB();

// ========================
// 🧪 ROOT
// ========================
app.get("/", (req, res) => {
	res.send("API running");
});

// ========================
// 🧪 TEST DB
// ========================
app.get("/testdb", async (req, res) => {
	try {
		await db.collection("test").insertOne({
			msg: "hello",
			time: new Date()
		});
		res.send("Saved to MongoDB");
	} catch {
		res.status(500).send("DB error");
	}
});

// ========================
// 📡 MAIN DATA
// ========================
app.post("/data", async (req, res) => {
	try {
		await db.collection("metrics").insertOne({
			...req.body,
			time: new Date()
		});
		res.send("ok");
	} catch (err) {
		console.error(err);
		res.status(500).send("error");
	}
});

// ========================
// 🚪 SESSION (PLAYER LEAVE)
// ========================
app.post("/session", async (req, res) => {
	try {
		await db.collection("sessions").insertOne({
			...req.body,
			time: new Date()
		});
		res.send("saved");
	} catch {
		res.status(500).send("error");
	}
});

// ========================
// ⚡ LOAD TIMES
// ========================
app.post("/loadtimes", async (req, res) => {
	try {
		await db.collection("loadtimes").insertOne({
			...req.body,
			time: new Date()
		});
		res.send("ok");
	} catch {
		res.status(500).send("error");
	}
});

// ========================
// 🖥️ SERVER HISTORY
// ========================
app.post("/server-history", async (req, res) => {
	try {
		await db.collection("serverHistory").insertOne({
			...req.body,
			time: new Date()
		});
		res.send("ok");
	} catch {
		res.status(500).send("error");
	}
});

// ========================
// 📊 GET METRICS
// ========================
app.get("/metrics", async (req, res) => {
	const data = await db.collection("metrics")
		.find()
		.sort({ time: -1 })
		.limit(100)
		.toArray();

	res.json(data);
});

// ========================
// 🔥 HEATMAP
// ========================
app.get("/heatmap", async (req, res) => {
	const data = await db.collection("metrics")
		.find({ x: { $exists: true } })
		.toArray();

	let heatmap = {};

	data.forEach(d => {
		const key = `${d.x},${d.z}`;

		if (!heatmap[key]) {
			heatmap[key] = { count: 0, totalFPS: 0 };
		}

		heatmap[key].count++;
		heatmap[key].totalFPS += d.fps || 0;
	});

	let out = {};

	for (let k in heatmap) {
		out[k] = {
			count: heatmap[k].count,
			avgFPS: Math.floor(heatmap[k].totalFPS / heatmap[k].count)
		};
	}

	res.json(out);
});

// ========================
// ⚡ GET LOAD TIMES
// ========================
app.get("/loadtimes", async (req, res) => {
	const data = await db.collection("loadtimes")
		.find()
		.sort({ time: -1 })
		.limit(100)
		.toArray();

	res.json(data);
});

// ========================
// 🖥️ GET SERVER HISTORY
// ========================
app.get("/server-history", async (req, res) => {
	const data = await db.collection("serverHistory")
		.find()
		.sort({ time: -1 })
		.limit(100)
		.toArray();

	res.json(data);
});

// ========================
// 🚀 START SERVER
// ========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
	console.log("🚀 Server running on port " + PORT);
});			serverHistory[data.serverId].push({
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
