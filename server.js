console.log("=== SERVER STARTING ===");
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { Resend } = require("resend");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(rateLimit({ windowMs: 10000, max: 100 }));

const SECRET = process.env.JWT_SECRET || "secret";
const resend = new Resend(process.env.RESEND_API_KEY);

// ================= DB =================
console.log("Connecting to MongoDB...");
const client = new MongoClient(process.env.MONGO_URI);
let db;

client.connect().then(() => {
  db = client.db("rolag");
  console.log("✅ DB connected");
});

// ================= MEMORY =================
let servers = {};
let lastAlertSent = {};
let clients = [];

// ================= WEBSOCKET =================
wss.on("connection", ws => {
  clients.push(ws);

  ws.on("close", () => {
    clients = clients.filter(c => c !== ws);
  });
});

function broadcast(type, data) {
  clients.forEach(ws => {
    ws.send(JSON.stringify({ type, data }));
  });
}

// ================= AUTH =================
function auth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).send("No token");

  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).send("Invalid token");
  }
}

// ================= REGISTER =================
app.post("/register", async (req, res) => {
  const { email, password } = req.body;

  const hash = await bcrypt.hash(password, 10);

  await db.collection("users").insertOne({
    email,
    password: hash,
    alertPrefs: {
      enabled: true,
      minFps: 30,
      cooldown: 60
    }
  });

  res.send("ok");
});

// ================= LOGIN =================
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

// ================= ALERT PREFS =================
app.get("/me/prefs", auth, async (req, res) => {
  const user = await db.collection("users").findOne({
    _id: new ObjectId(req.user.id)
  });

  res.json(user.alertPrefs);
});

app.post("/me/prefs", auth, async (req, res) => {
  await db.collection("users").updateOne(
    { _id: new ObjectId(req.user.id) },
    { $set: { alertPrefs: req.body } }
  );

  res.send("saved");
});

// ================= GAME =================
app.post("/register-game", auth, async (req, res) => {
  const { gameId, name } = req.body;

  await db.collection("games").updateOne(
    { gameId },
    {
      $set: {
        name: name || "Unnamed",
        owner: req.user.id
      }
    },
    { upsert: true }
  );

  res.send("ok");
});

// ================= EMAIL =================
async function sendEmail(to, message) {
  try {
    await resend.emails.send({
      from: "onboarding@resend.dev",
      to,
      subject: "🚨 FPS Alert",
      html: `<p>${message}</p>`
    });
  } catch (err) {
    console.error("Email failed", err);
  }
}

// ================= DATA =================
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

    broadcast("metrics", data);

    // find game owner
    const game = await db.collection("games").findOne({
      gameId: data.gameId
    });

    if (!game) return res.send("ok");

    const user = await db.collection("users").findOne({
      _id: new ObjectId(game.owner)
    });

    if (!user || !user.alertPrefs?.enabled) return res.send("ok");

    const threshold = user.alertPrefs.minFps;
    const cooldown = user.alertPrefs.cooldown * 1000;

    if (data.fps && data.fps < threshold) {
      const key = `${user._id}-${data.serverId}`;
      const now = Date.now();

      if (!lastAlertSent[key] || now - lastAlertSent[key] > cooldown) {
        lastAlertSent[key] = now;

        const msg = `[${data.serverId}] FPS ${data.fps}`;

        await db.collection("alerts").insertOne({
          gameId: data.gameId,
          message: msg,
          time: new Date()
        });

        await sendEmail(user.email, msg);

        broadcast("alert", { message: msg });
      }
    }

    res.send("ok");

  } catch (err) {
    console.error(err);
    res.status(500).send("error");
  }
});

// ================= LIVE =================
app.get("/live/:gameId", (req, res) => {
  res.json(
    Object.values(servers).filter(
      s => s.gameId === req.params.gameId
    )
  );
});

// ================= ALERTS =================
app.get("/alerts/:gameId", async (req, res) => {
  const data = await db.collection("alerts")
    .find({ gameId: req.params.gameId })
    .sort({ time: -1 })
    .limit(50)
    .toArray();

  res.json(data);
});

// ================= METRICS =================
app.get("/metrics/:gameId", async (req, res) => {
  const data = await db.collection("metrics")
    .find({ gameId: req.params.gameId })
    .sort({ time: -1 })
    .limit(100)
    .toArray();

  res.json(data);
});

// ================= ROOT CAUSE =================
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

// ================= CLEANUP =================
setInterval(() => {
  const now = Date.now();

  for (let id in servers) {
    if (now - servers[id].lastUpdate > 30000) {
      delete servers[id];
    }
  }
}, 10000);

// ================= ROOT =================
app.get("/", (req, res) => {
  res.send("API running 🚀");
});

// ================= START =================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});
  res.send("saved");
});

// ================= GAME =================
app.post("/register-game", auth, async (req, res) => {
  const { gameId, name } = req.body;

  await db.collection("games").updateOne(
    { gameId },
    { $set: { name, owner: req.user.id } },
    { upsert: true }
  );

  res.send("ok");
});

// ================= DATA =================
app.post("/data", async (req, res) => {
  const d = { ...req.body, time: new Date() };
  await db.collection("metrics").insertOne(d);

  servers[d.serverId] = { ...d, last: Date.now() };

  broadcast("metrics", d);

  const game = await db.collection("games").findOne({ gameId: d.gameId });
  if (!game) return res.send("ok");

  const user = await db.collection("users").findOne({
    _id: new ObjectId(game.owner)
  });

  if (!user || !user.alertPrefs?.enabled) return res.send("ok");

  const minFps = user.alertPrefs.minFps;
  const cooldown = user.alertPrefs.cooldown * 1000;

  if (d.fps < minFps) {
    const key = `${user._id}-${d.serverId}`;
    const now = Date.now();

    if (!lastAlertSent[key] || now - lastAlertSent[key] > cooldown) {
      lastAlertSent[key] = now;

      await db.collection("alerts").insertOne({
        gameId: d.gameId,
        message: `Low FPS ${d.fps}`,
        time: new Date()
      });

      await resend.emails.send({
        from: "onboarding@resend.dev",
        to: user.email,
        subject: "🚨 FPS Alert",
        html: `<p>Server ${d.serverId} FPS ${d.fps}</p>`
      });

      broadcast("alert", { message: `⚠️ FPS ${d.fps}` });
    }
  }

  res.send("ok");
});

// ================= LIVE =================
app.get("/live/:gameId", (req, res) => {
  res.json(Object.values(servers));
});

// ================= START =================
server.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server running");
});app.post("/login", async (req, res) => {
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
