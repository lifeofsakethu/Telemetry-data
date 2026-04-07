const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json());

// ========================
// 🔒 RATE LIMIT
// ========================
app.use(rateLimit({
  windowMs: 10 * 1000,
  max: 100
}));

// ========================
// 🔐 CONFIG
// ========================
const SECRET = process.env.JWT_SECRET || "supersecret";

// ========================
// 🔗 MONGODB
// ========================
const client = new MongoClient(process.env.MONGO_URI);
let db;

async function connectDB() {
  try {
    await client.connect();
    db = client.db("rolag");
    console.log("✅ MongoDB Connected");
  } catch (err) {
    console.error(err);
  }
}
connectDB();

// ========================
// 🧠 MEMORY (LIVE SERVERS)
// ========================
let servers = {};

// ========================
// 🔒 AUTH MIDDLEWARE
// ========================
function auth(req, res, next) {
  const token = req.headers.authorization;

  if (!token) return res.status(401).send("No token");

  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).send("Invalid token");
  }
}

// ========================
// 👤 REGISTER USER
// ========================
app.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;

    const exists = await db.collection("users").findOne({ email });
    if (exists) return res.status(400).send("User exists");

    const hash = await bcrypt.hash(password, 10);

    await db.collection("users").insertOne({
      email,
      password: hash,
      createdAt: new Date()
    });

    res.send("registered");
  } catch {
    res.status(500).send("error");
  }
});

// ========================
// 🔑 LOGIN
// ========================
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await db.collection("users").findOne({ email });
    if (!user) return res.status(400).send("User not found");

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).send("Wrong password");

    const token = jwt.sign(
      { id: user._id, email: user.email },
      SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token });
  } catch {
    res.status(500).send("error");
  }
});

// ========================
// 🎮 REGISTER GAME (AUTH)
// ========================
app.post("/register-game", auth, async (req, res) => {
  try {
    const { gameId, name } = req.body;

    await db.collection("games").updateOne(
      { gameId },
      {
        $set: {
          name: name || "Unnamed",
          owner: req.user.id,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    res.send("registered");
  } catch {
    res.status(500).send("error");
  }
});

// ========================
// 📡 DATA INGEST
// ========================
app.post("/data", async (req, res) => {
  try {
    const data = { ...req.body, time: new Date() };

    await db.collection("metrics").insertOne(data);

    if (data.serverId) {
      servers[data.serverId] = {
        ...data,
        lastUpdate: Date.now()
      };
    }

    // ALERT
    if (data.fps && data.fps < 30) {
      await db.collection("alerts").insertOne({
        gameId: data.gameId,
        message: `[${data.serverId}] Low FPS: ${data.fps}`,
        time: new Date()
      });
    }

    res.send("ok");
  } catch {
    res.status(500).send("error");
  }
});

// ========================
// 🖥️ LIVE SERVERS
// ========================
app.get("/live/:gameId", (req, res) => {
  const out = [];

  for (let id in servers) {
    const s = servers[id];

    if (s.gameId === req.params.gameId) {
      out.push({
        serverId: id,
        players: s.players || 0,
        fps: s.fps || 0
      });
    }
  }

  res.json(out);
});

// ========================
// 🚨 ALERTS
// ========================
app.get("/alerts/:gameId", async (req, res) => {
  const alerts = await db.collection("alerts")
    .find({ gameId: req.params.gameId })
    .sort({ time: -1 })
    .limit(50)
    .toArray();

  res.json(alerts);
});

// ========================
// 📊 METRICS
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
// 🔍 SERVER DETAILS
// ========================
app.get("/server/:id", async (req, res) => {
  const data = await db.collection("metrics")
    .find({ serverId: req.params.id })
    .sort({ time: -1 })
    .limit(100)
    .toArray();

  res.json(data);
});

// ========================
// 🧠 ROOT CAUSE
// ========================
app.get("/root/:id", async (req, res) => {
  const data = await db.collection("metrics")
    .find({ serverId: req.params.id })
    .sort({ time: 1 })
    .toArray();

  let insights = [];

  for (let i = 1; i < data.length; i++) {
    const prev = data[i - 1];
    const curr = data[i];

    if (curr.players > prev.players + 3 && curr.fps < prev.fps - 10) {
      insights.push({
        msg: "FPS dropped after player spike",
        cause: "Server overload"
      });
    }

    if (Math.abs(curr.players - prev.players) < 1 && curr.fps < prev.fps - 15) {
      insights.push({
        msg: "FPS dropped without player increase",
        cause: "Script or memory issue"
      });
    }
  }

  res.json({ insights });
});

// ========================
// 👤 USER GAMES
// ========================
app.get("/my-games", auth, async (req, res) => {
  const games = await db.collection("games")
    .find({ owner: req.user.id })
    .toArray();

  res.json(games);
});

// ========================
// 🧹 CLEANUP
// ========================
setInterval(() => {
  const now = Date.now();

  for (let id in servers) {
    if (now - servers[id].lastUpdate > 30000) {
      delete servers[id];
    }
  }
}, 10000);

// ========================
// 🧪 ROOT
// ========================
app.get("/", (req, res) => {
  res.send("API running 🚀");
});

// ========================
// 🚀 START
// ========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});	try {
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
