const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

// 🔒 Rate limit
app.use(rateLimit({ windowMs: 10000, max: 100 }));

const SECRET = process.env.JWT_SECRET || "secret";

// ================= DB =================
const client = new MongoClient(process.env.MONGO_URI);
let db;

async function init() {
  await client.connect();
  db = client.db("rolag");
  await db.collection("metrics").createIndex({ serverId: 1, time: 1 });
  console.log("DB ready");
}
init();

// ================= MEMORY =================
let servers = {};

// ================= WS =================
const server = app.listen(process.env.PORT || 3000);
const wss = new WebSocket.Server({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

// ================= AUTH =================
function auth(req, res, next) {
  const t = req.headers.authorization;
  if (!t) return res.sendStatus(401);

  try {
    req.user = jwt.verify(t, SECRET);
    next();
  } catch {
    res.sendStatus(401);
  }
}

// ================= USER =================
app.post("/register", async (req,res)=>{
  const {email,password} = req.body;
  const hash = await bcrypt.hash(password,10);
  await db.collection("users").insertOne({email,password:hash});
  res.send("ok");
});

app.post("/login", async (req,res)=>{
  const {email,password} = req.body;
  const u = await db.collection("users").findOne({email});
  if (!u) return res.sendStatus(400);

  const ok = await bcrypt.compare(password,u.password);
  if (!ok) return res.sendStatus(400);

  const token = jwt.sign({id:u._id},SECRET);
  res.json({token});
});

// ================= GAME =================
app.post("/register-game", auth, async (req,res)=>{
  const {gameId,name} = req.body;
  await db.collection("games").updateOne(
    {gameId},
    {$set:{name,owner:req.user.id}},
    {upsert:true}
  );
  res.send("ok");
});

// ================= DATA =================
app.post("/data", async (req,res)=>{
  const d = {...req.body,time:new Date()};

  await db.collection("metrics").insertOne(d);

  servers[d.serverId] = {...d,last:Date.now()};

  broadcast({type:"metric",data:d});

  if (d.fps < 30) {
    const alert = {
      gameId:d.gameId,
      message:`[${d.serverId}] Low FPS ${d.fps}`,
      time:new Date()
    };

    await db.collection("alerts").insertOne(alert);
    broadcast({type:"alert",data:alert});
  }

  res.send("ok");
});

// ================= SESSION =================
app.post("/session", async (req,res)=>{
  await db.collection("sessions").insertOne({
    ...req.body,
    time:new Date()
  });
  res.send("ok");
});

// ================= LIVE =================
app.get("/live/:gameId",(req,res)=>{
  res.json(
    Object.values(servers).filter(s=>s.gameId===req.params.gameId)
  );
});

// ================= ALERTS =================
app.get("/alerts/:gameId", async (req,res)=>{
  res.json(
    await db.collection("alerts")
      .find({gameId:req.params.gameId})
      .toArray()
  );
});

// ================= METRICS =================
app.get("/metrics/:gameId", async (req,res)=>{
  res.json(
    await db.collection("metrics")
      .find({gameId:req.params.gameId})
      .sort({time:-1})
      .limit(100)
      .toArray()
  );
});

// ================= ROOT =================
app.get("/root/:id", async (req,res)=>{
  const d = await db.collection("metrics")
    .find({serverId:req.params.id})
    .toArray();

  let out=[];
  for(let i=1;i<d.length;i++){
    if(d[i].fps < d[i-1].fps - 10){
      out.push("FPS drop detected");
    }
  }
  res.json(out);
});

// ================= HEATMAP =================
app.get("/heatmap", async (req,res)=>{
  const data = await db.collection("metrics")
    .find({x:{$exists:true}})
    .toArray();

  let map={};
  data.forEach(d=>{
    const k=`${d.x},${d.z}`;
    if(!map[k]) map[k]={count:0};
    map[k].count++;
  });

  res.json(map);
});

// ================= TIMELINE =================
app.get("/timeline/:id", async (req,res)=>{
  const data = await db.collection("metrics")
    .find({serverId:req.params.id})
    .sort({time:1})
    .limit(500)
    .toArray();

  res.json(data);
});

// ================= CLEANUP =================
setInterval(()=>{
  const now=Date.now();
  for(let id in servers){
    if(now - servers[id].last > 30000){
      delete servers[id];
    }
  }
},10000);

app.get("/",(req,res)=>res.send("API running"));      gameId: d.gameId,
      message: "Low FPS",
      time: new Date()
    });
  }

  res.send("ok");
});

// ========================
// SESSION
// ========================
app.post("/session", async (req, res) => {
  await db.collection("sessions").insertOne({
    ...req.body,
    time: new Date()
  });

  res.send("ok");
});

// ========================
// LIVE
// ========================
app.get("/live/:gameId", (req, res) => {
  const out = Object.values(servers).filter(
    s => s.gameId === req.params.gameId
  );
  res.json(out);
});

// ========================
// ALERTS
// ========================
app.get("/alerts/:gameId", async (req, res) => {
  const a = await db.collection("alerts")
    .find({ gameId: req.params.gameId })
    .toArray();
  res.json(a);
});

// ========================
// METRICS
// ========================
app.get("/metrics/:gameId", async (req, res) => {
  const m = await db.collection("metrics")
    .find({ gameId: req.params.gameId })
    .sort({ time: -1 })
    .limit(100)
    .toArray();
  res.json(m);
});

// ========================
// ROOT CAUSE
// ========================
app.get("/root/:id", async (req, res) => {
  const d = await db.collection("metrics")
    .find({ serverId: req.params.id })
    .toArray();

  let out = [];

  for (let i = 1; i < d.length; i++) {
    if (d[i].fps < d[i-1].fps - 10) {
      out.push("FPS drop detected");
    }
  }

  res.json(out);
});

// ========================
// HEATMAP
// ========================
app.get("/heatmap", async (req, res) => {
  const data = await db.collection("metrics")
    .find({ x: { $exists: true } })
    .toArray();

  let map = {};

  data.forEach(d => {
    const key = `${d.x},${d.z}`;
    if (!map[key]) map[key] = { count: 0 };
    map[key].count++;
  });

  res.json(map);
});

// ========================
setInterval(() => {
  const now = Date.now();
  for (let id in servers) {
    if (now - servers[id].last > 30000) delete servers[id];
  }
}, 10000);

app.get("/", (req,res)=>res.send("API running"));

app.listen(process.env.PORT || 3000);      SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token });
  } catch {
    res.status(500).send("error");
  }
});

// ========================
// 🎮 REGISTER GAME
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

    // alert if low fps
    if (data.fps && data.fps < 30) {
      await db.collection("alerts").insertOne({
        gameId: data.gameId,
        message: `[${data.serverId}] Low FPS: ${data.fps}`,
        time: new Date()
      });
    }

    res.send("ok");
  } catch (err) {
    console.error(err);
    res.status(500).send("error");
  }
});

// ========================
// 🧠 SESSION SAVE (FIXED)
// ========================
app.post("/session", async (req, res) => {
  try {
    await db.collection("sessions").insertOne({
      ...req.body,
      time: new Date()
    });

    res.send("saved");
  } catch (err) {
    console.error(err);
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
      insights.push("FPS dropped after player spike → overload");
    }

    if (Math.abs(curr.players - prev.players) < 1 && curr.fps < prev.fps - 15) {
      insights.push("FPS dropped without players → script issue");
    }
  }

  res.json(insights);
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
});
