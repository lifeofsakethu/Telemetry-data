const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json());

// ========================
// 🔒 RATE LIMIT
// ========================
const limiter = rateLimit({
	windowMs: 60 * 1000,
	max: 100
});
app.use(limiter);

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
	res.send("🚀 Rolag API running");
});

// ========================
// 🔐 REGISTER GAME
// ========================
app.post("/register", async (req, res) => {
	try {
		const { name } = req.body;

		const game = await db.collection("games").insertOne({
			name,
			created: new Date()
		});

		const token = jwt.sign(
			{ gameId: game.insertedId },
			process.env.JWT_SECRET
		);

		res.json({ token, gameId: game.insertedId });
	} catch (err) {
		res.status(500).send("error");
	}
});

// ========================
// 🔐 AUTH MIDDLEWARE
// ========================
function auth(req, res, next) {
	const token = req.headers["authorization"];
	if (!token) return res.status(401).send("No token");

	try {
		req.user = jwt.verify(token, process.env.JWT_SECRET);
		next();
	} catch {
		res.status(403).send("Invalid token");
	}
}

// ========================
// 📡 DATA
// ========================
app.post("/data", auth, async (req, res) => {
	try {
		await db.collection("metrics").insertOne({
			gameId: req.user.gameId,
			...req.body,
			time: new Date()
		});
		res.send("ok");
	} catch {
		res.status(500).send("error");
	}
});

// ========================
// 🚪 SESSION
// ========================
app.post("/session", auth, async (req, res) => {
	try {
		await db.collection("sessions").insertOne({
			gameId: req.user.gameId,
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
app.post("/loadtimes", auth, async (req, res) => {
	try {
		await db.collection("loadtimes").insertOne({
			gameId: req.user.gameId,
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
app.get("/metrics/:gameId", async (req, res) => {
	const data = await db.collection("metrics")
		.find({ gameId: req.params.gameId })
		.sort({ time: -1 })
		.limit(100)
		.toArray();

	res.json(data);
});

// ========================
// 🔥 HEATMAP
// ========================
app.get("/heatmap/:gameId", async (req, res) => {
	const data = await db.collection("metrics")
		.find({ gameId: req.params.gameId })
		.toArray();

	let heatmap = {};

	data.forEach(d => {
		if (!d.x) return;

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
// 🚀 START
// ========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log("🚀 Server running on port " + PORT);
});
