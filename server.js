console.log("=== SERVER STARTING ===");

process.on("uncaughtException", err => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", err => {
  console.error("UNHANDLED REJECTION:", err);
});

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { MongoClient, ObjectId } = require("mongodb");
const { Resend } = require("resend");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(rateLimit({
  windowMs: 10000,
  max: 100
}));

const SECRET = process.env.JWT_SECRET;
const resend = new Resend(process.env.RESEND_API_KEY);

const mongo = new MongoClient(process.env.MONGO_URI);

let db = null;

let liveServers = {};
let lastAlerts = {};
let sockets = [];

async function connectDB() {
  try {
    await mongo.connect();
    db = mongo.db("rolag");
    console.log("✅ Mongo connected");
  } catch (err) {
    console.error("Mongo failed:", err);
  }
}

connectDB();

wss.on("connection", ws => {
  sockets.push(ws);

  ws.on("close", () => {
    sockets = sockets.filter(s => s !== ws);
  });
});

function broadcast(type, data) {
  sockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, data }));
    }
  });
}

function auth(req, res, next) {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send("Unauthorized");
  }

  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).send("Invalid token");
  }
}

function requireDB(req, res, next) {
  if (!db) {
    return res.status(503).json({
      error: "Database unavailable"
    });
  }

  next();
}

app.get("/", (req, res) => {
  res.send("RoLag API Online");
});

app.post("/register", requireDB, async (req, res) => {
  const { email, password } = req.body;

  const existing = await db
    .collection("users")
    .findOne({ email });

  if (existing) {
    return res.status(400).send("Email exists");
  }

  const hash = await bcrypt.hash(password, 10);

  await db.collection("users").insertOne({
    email,
    password: hash,
    createdAt: new Date(),
    alertPrefs: {
      enabled: true,
      minFps: 30,
      cooldown: 60
    }
  });

  res.send("ok");
});

app.post("/login", requireDB, async (req, res) => {
  const { email, password } = req.body;

  const user = await db.collection("users").findOne({ email });

  if (!user) {
    return res.status(400).send("User not found");
  }

  const valid = await bcrypt.compare(
    password,
    user.password
  );

  if (!valid) {
    return res.status(400).send("Wrong password");
  }

  const token = jwt.sign(
    { id: user._id },
    SECRET,
    { expiresIn: "7d" }
  );

  res.json({ token });
});

app.get("/me/prefs", auth, requireDB, async (req, res) => {
  const user = await db.collection("users").findOne({
    _id: new ObjectId(req.user.id)
  });

  res.json(user.alertPrefs);
});

app.post("/me/prefs", auth, requireDB, async (req, res) => {
  await db.collection("users").updateOne(
    {
      _id: new ObjectId(req.user.id)
    },
    {
      $set: {
        alertPrefs: req.body
      }
    }
  );

  res.send("saved");
});

app.post("/register-game", auth, requireDB, async (req, res) => {
  const { gameId, name } = req.body;

  await db.collection("games").updateOne(
    { gameId },
    {
      $set: {
        name,
        owner: req.user.id,
        updatedAt: new Date()
      }
    },
    { upsert: true }
  );

  res.send("ok");
});

async function sendEmail(to, message) {
  try {
    await resend.emails.send({
      from: "onboarding@resend.dev",
      to,
      subject: "🚨 RoLag Alert",
      html: `<p>${message}</p>`
    });
  } catch (err) {
    console.error(err);
  }
}

app.post("/data", requireDB, async (req, res) => {
  const metric = {
    ...req.body,
    time: new Date()
  };

  await db.collection("metrics").insertOne(metric);

  liveServers[metric.serverId] = {
    ...metric,
    lastUpdate: Date.now()
  };

  broadcast("metric", metric);

  const game = await db.collection("games").findOne({
    gameId: metric.gameId
  });

  if (game) {
    const owner = await db.collection("users").findOne({
      _id: new ObjectId(game.owner)
    });

    if (
      owner &&
      owner.alertPrefs?.enabled &&
      metric.fps < owner.alertPrefs.minFps
    ) {
      const key =
        owner._id + "-" + metric.serverId;

      const cooldown =
        owner.alertPrefs.cooldown * 1000;

      const now = Date.now();

      if (
        !lastAlerts[key] ||
        now - lastAlerts[key] > cooldown
      ) {
        lastAlerts[key] = now;

        const msg =
          `Low FPS (${metric.fps}) on ${metric.serverId}`;

        await db.collection("alerts").insertOne({
          gameId: metric.gameId,
          message: msg,
          time: new Date()
        });

        await sendEmail(owner.email, msg);

        broadcast("alert", {
          message: msg
        });
      }
    }
  }

  res.send("ok");
});

app.post("/session", requireDB, async (req, res) => {
  await db.collection("sessions").insertOne({
    ...req.body,
    time: new Date()
  });

  res.send("saved");
});

app.get("/live/:gameId", (req, res) => {
  res.json(
    Object.values(liveServers).filter(
      s => s.gameId === req.params.gameId
    )
  );
});

app.get("/alerts/:gameId", requireDB, async (req, res) => {
  const alerts = await db
    .collection("alerts")
    .find({
      gameId: req.params.gameId
    })
    .sort({ time: -1 })
    .limit(100)
    .toArray();

  res.json(alerts);
});

app.get("/metrics/:gameId", requireDB, async (req, res) => {
  const metrics = await db
    .collection("metrics")
    .find({
      gameId: req.params.gameId
    })
    .sort({ time: -1 })
    .limit(500)
    .toArray();

  res.json(metrics);
});

app.get("/timeline/:serverId", requireDB, async (req, res) => {
  const timeline = await db
    .collection("metrics")
    .find({
      serverId: req.params.serverId
    })
    .sort({ time: 1 })
    .toArray();

  res.json(timeline);
});

app.get("/root/:serverId", requireDB, async (req, res) => {
  const metrics = await db
    .collection("metrics")
    .find({
      serverId: req.params.serverId
    })
    .sort({ time: 1 })
    .toArray();

  const findings = [];

  for (let i = 1; i < metrics.length; i++) {
    if (
      metrics[i].fps <
      metrics[i - 1].fps - 10
    ) {
      findings.push({
        type: "fps_drop",
        time: metrics[i].time
      });
    }
  }

  res.json(findings);
});

setInterval(() => {
  const now = Date.now();

  Object.keys(liveServers).forEach(id => {
    if (
      now - liveServers[id].lastUpdate >
      30000
    ) {
      delete liveServers[id];
    }
  });
}, 10000);

const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});
