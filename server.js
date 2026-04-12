const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Resend } = require("resend");

const app = express();

// ========================
app.use(cors());
app.use(express.json());
app.use(rateLimit({ windowMs: 10000, max: 100 }));

// ========================
const SECRET = process.env.JWT_SECRET || "supersecret";
const resend = new Resend(process.env.RESEND_API_KEY);

// ========================
// DB
// ========================
const client = new MongoClient(process.env.MONGO_URI);
let db;

async function connectDB() {
  await client.connect();
  db = client.db("rolag");
  console.log("✅ DB connected");
}
connectDB();

// ========================
// MEMORY
// ========================
let servers = {};
let lastAlertTime = {};

// ========================
// EMAIL
// ========================
async function sendEmail(to, msg) {
  try {
    await resend.emails.send({
      from: "alerts@yourdomain.com",
      to,
      subject: "🚨 Rolag Alert",
      html: `<strong>${msg}</strong>`
    });
  } catch (err) {
    console.error("Email error:", err);
  }
}

// ========================
// AUTH
// ========================
function auth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.sendStatus(401);

  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.sendStatus(401);
  }
}

// ========================
// 👤 REGISTER
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
      alertSettings: {
        enabled: true,
        fpsThreshold: 30
      },
      createdAt: new Date()
    });

    res.send("registered");
  } catch (err) {
    console.error(err);
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
    if (!user) return res.status(400).send("No user");

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).send("Wrong password");

    const token = jwt.sign(
      { id: user._id },
      SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token });

  } catch (err) {
    console.error(err);
    res.status(500).send("error");
  }
});

// ========================
// ⚙️ ALERT SETTINGS
// ========================
app.get("/alert-settings", auth, async (req, res) => {
  const user = await db.collection("users").findOne({
    _id: new ObjectId(req.user.id)
  });

  res.json(user.alertSettings || {});
});

app.post("/alert-settings", auth, async (req, res) => {
  const { enabled, fpsThreshold } = req.body;

  await db.collection("users").updateOne(
    { _id: new ObjectId(req.user.id) },
    {
      $set: {
        alertSettings: {
          enabled,
          fpsThreshold
        }
      }
    }
  );

  res.send("saved");
});

// ========================
// 🎮 REGISTER GAME
// ========================
app.post("/register-game", auth, async (req, res) => {
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

  res.send("ok");
});

// ========================
// 📡 DATA INGEST + ALERT
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

    // 🔍 find game owner
    const game = await db.collection("games").findOne({
      gameId: data.gameId
    });

    if (!game) return res.send("ok");

    const owner = await db.collection("users").findOne({
      _id: new ObjectId(game.owner)
    });

    if (!owner || !owner.alertSettings?.enabled) return res.send("ok");

    const threshold = owner.alertSettings.fpsThreshold || 30;

    if (data.fps && data.fps < threshold) {
      const now = Date.now();

      if (
        !lastAlertTime[data.serverId] ||
        now - lastAlertTime[data.serverId] > 60000
      ) {
        lastAlertTime[data.serverId] = now;

        const msg = `[${data.serverId}] FPS ${data.fps} < ${threshold}`;

        await db.collection("alerts").insertOne({
          gameId: data.gameId,
          message: msg,
          time: new Date()
        });

        await sendEmail(owner.email, msg);
      }
    }

    res.send("ok");

  } catch (err) {
    console.error(err);
    res.status(500).send("error");
  }
});

// ========================
// 🎯 SESSION
// ========================
app.post("/session", async (req, res) => {
  await db.collection("sessions").insertOne({
    ...req.body,
    time: new Date()
  });

  res.send("saved");
});

// ========================
// 🖥️ LIVE SERVERS
// ========================
app.get("/live/:gameId", (req, res) => {
  res.json(
    Object.values(servers).filter(
      s => s.gameId === req.params.gameId
    )
  );
});

// ========================
// 🚨 ALERTS
// ========================
app.get("/alerts/:gameId", async (req, res) => {
  const data = await db.collection("alerts")
    .find({ gameId: req.params.gameId })
    .sort({ time: -1 })
    .limit(50)
    .toArray();

  res.json(data);
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
// 🧠 ROOT CAUSE
// ========================
app.get("/root/:id", async (req, res) => {
  const data = await db.collection("metrics")
    .find({ serverId: req.params.id })
    .sort({ time: 1 })
    .toArray();

  let out = [];

  for (let i = 1; i < data.length; i++) {
    if (data[i].fps < data[i - 1].fps - 10) {
      out.push("FPS drop detected");
    }
  }

  res.json(out);
});

// ========================
// ⏪ TIMELINE
// ========================
app.get("/timeline/:id", async (req, res) => {
  const data = await db.collection("metrics")
    .find({ serverId: req.params.id })
    .sort({ time: 1 })
    .limit(500)
    .toArray();

  res.json(data);
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
// ROOT
// ========================
app.get("/", (req, res) => {
  res.send("API running 🚀");
});

// ========================
// START
// ========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});
