const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");

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
		db = client.db("loadview");
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
// 👤 USER REGISTER
// ========================
app.post("/register", async (req, res) => {
	const { username, password } = req.body;

	const exists = await db.collection("users").findOne({ username });
	if (exists) return res.status(400).send("User exists");

	await db.collection("users").insertOne({
		username,
		password, // (later hash this)
		created: new Date()
	});

	res.send("registered");
});

// ========================
// 🔐 LOGIN
// ========================
app.post("/login", async (req, res) => {
	const { username, password } = req.body;

	const user = await db.collection("users").findOne({ username, password });
	if (!user) return res.status(401).send("invalid");

	res.json({ userId: user._id });
});

// ========================
// 🎮 REGISTER GAME
// ========================
app.post("/register-game", async (req, res) => {
	const { userId, gameName } = req.body;

	const apiKey = Math.random().toString(36).substring(2);

	await db.collection("games").insertOne({
		userId: new ObjectId(userId),
		gameName,
		apiKey,
		created: new Date()
	});

	res.json({ apiKey });
});

// ========================
// 📡 DATA (WITH API KEY)
// ========================
app.post("/data", async (req, res) => {
	try {
		const { apiKey } = req.body;

		const game = await db.collection("games").findOne({ apiKey });
		if (!game) return res.status(403).send("invalid key");

		await db.collection("metrics").insertOne({
			...req.body,
			gameId: game._id,
			time: new Date()
		});

		res.send("ok");
	} catch (err) {
		console.error(err);
		res.status(500).send("error");
	}
});

// ========================
// 🚪 SESSION
// ========================
app.post("/session", async (req, res) => {
	try {
		await db.collection("sessions").insertOne({
			...req.body,
			time: new Date()
		});
		res.send("ok");
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
// 📊 GET METRICS (PER GAME)
// ========================
app.get("/metrics/:apiKey", async (req, res) => {
	const game = await db.collection("games").findOne({ apiKey: req.params.apiKey });
	if (!game) return res.status(404).send("no game");

	const data = await db.collection("metrics")
		.find({ gameId: game._id })
		.sort({ time: -1 })
		.limit(100)
		.toArray();

	res.json(data);
});

// ========================
// 🔥 HEATMAP
// ========================
app.get("/heatmap/:apiKey", async (req, res) => {
	const game = await db.collection("games").findOne({ apiKey: req.params.apiKey });
	if (!game) return res.status(404).send("no game");

	const data = await db.collection("metrics")
		.find({ gameId: game._id, x: { $exists: true } })
		.toArray();

	let heatmap = {};

	data.forEach(d => {
		const key = `${d.x},${d.z}`;
		if (!heatmap[key]) heatmap[key] = { count: 0, totalFPS: 0 };

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
// 🚀 START SERVER
// ========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
	console.log("🚀 Server running on port " + PORT);
});
