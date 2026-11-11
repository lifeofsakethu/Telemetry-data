"use strict";

const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { MongoClient, ObjectId } = require("mongodb");
const { Resend } = require("resend");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 10000);
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const TELEMETRY_SECRET = process.env.TELEMETRY_SECRET;
const IS_PRODUCTION = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const LIVE_TTL_MS = Number(process.env.LIVE_TTL_MS || 30000);
const MAX_HISTORY = 500;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.warn("JWT_SECRET is missing or shorter than 32 characters; set a strong secret before production use.");
}
if (!MONGO_URI) console.warn("MONGO_URI is not configured; database-backed routes will remain unavailable.");

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const mongo = MONGO_URI ? new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 }) : null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
let db = null;
let shuttingDown = false;
let maintenance = { enabled: false, message: "" };
const liveServers = new Map();
const sockets = new Set();
const lastAlerts = new Map();
const telemetryStats = { accepted: 0, rejected: 0, lastAcceptedAt: null };
const loadedModules = [];

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "https://rolag.netlify.app,http://localhost:5173")
  .split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: (origin, callback) => {
  if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error("Origin not allowed"));
}}));
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false, limit: "32kb" }));
app.use(rateLimit({ windowMs: 60 * 1000, limit: 180, standardHeaders: true, legacyHeaders: false }));
// The frontend is deployed separately to Netlify. Keep GET / as the API status route.


const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const jsonError = (res, status, error, details) => res.status(status).json({ error, ...(details ? { details } : {}) });
const isValidId = value => typeof value === "string" && ObjectId.isValid(value);
const cleanEmail = value => String(value || "").trim().toLowerCase();
const now = () => new Date();

function requireDb(req, res, next) {
  if (!db) return jsonError(res, 503, "Database unavailable");
  next();
}
function getToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}
async function auth(req, res, next) {
  const token = getToken(req);
  if (!token || !JWT_SECRET) return jsonError(res, 401, "Authentication required");
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    if (!db || !isValidId(claims.id)) return jsonError(res, 401, "Invalid token");
    const user = await db.collection("users").findOne({ _id: new ObjectId(claims.id) }, { projection: { password: 0 } });
    if (!user || user.status === "banned") return jsonError(res, 403, "Account is unavailable");
    req.user = user;
    next();
  } catch (error) {
    return jsonError(res, 401, "Invalid or expired token");
  }
}
function superadmin(req, res, next) {
  if (req.user?.role !== "superadmin") return jsonError(res, 403, "Superadmin access required");
  next();
}
function telemetryAuth(req, res, next) {
  if (!TELEMETRY_SECRET) return jsonError(res, 503, "Telemetry secret is not configured");
  const supplied = req.headers["x-telemetry-secret"] || req.body?.telemetrySecret;
  const providedBuffer = Buffer.from(String(supplied || ""));
  const expectedBuffer = Buffer.from(String(TELEMETRY_SECRET));
  if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    telemetryStats.rejected += 1;
    return jsonError(res, 401, "Telemetry authentication failed");
  }
  next();
}
function validateTelemetry(body) {
  const gameId = String(body.gameId || "").trim();
  const serverId = String(body.serverId || "").trim();
  const fps = Number(body.fps);
  const players = Number(body.players);
  if (!gameId || gameId.length > 120 || !serverId || serverId.length > 180) return "gameId and serverId are required";
  if (!Number.isFinite(fps) || fps < 0 || fps > 1000) return "fps must be between 0 and 1000";
  if (!Number.isInteger(players) || players < 0 || players > 100000) return "players must be a non-negative integer";
  return null;
}
async function getOwnedGame(userId, gameId) {
  return db.collection("games").findOne({ gameId: String(gameId), owner: String(userId) });
}
function safeUser(user) {
  if (!user) return null;
  return { id: String(user._id), email: user.email, role: user.role || "user", status: user.status || "active", createdAt: user.createdAt };
}
function broadcast(type, data, predicate = () => true) {
  const payload = JSON.stringify({ type, data });
  for (const client of sockets) {
    if (client.readyState === WebSocket.OPEN && predicate(client)) client.send(payload);
  }
}
async function sendEmail(to, subject, message) {
  if (!resend || !to || !process.env.ADMIN_EMAIL) return;
  try {
    await resend.emails.send({ from: process.env.EMAIL_FROM || "RoLag <onboarding@resend.dev>", to, subject, html: `<div style="font-family:Arial"><h2>${subject}</h2><p>${message}</p></div>` });
  } catch (error) {
    console.error("Email delivery failed:", error.message);
  }
}
async function recordAdmin(admin, action, targetUser, details = {}) {
  await db.collection("adminLogs").insertOne({ adminId: String(admin._id), action, targetUser: targetUser ? String(targetUser) : null, details, timestamp: now() });
}
async function ensureIndexes() {
  const indexes = [
    ["users", { email: 1 }, { unique: true }],
    ["games", { gameId: 1 }, { unique: true }],
    ["games", { owner: 1 }],
    ["metrics", { gameId: 1, time: -1 }], ["metrics", { serverId: 1, time: -1 }],
    ["alerts", { gameId: 1, time: -1 }], ["sessions", { gameId: 1, time: -1 }],
    ["adminLogs", { timestamp: -1 }]
  ];
  for (const [collection, key, options] of indexes) {
    try { await db.collection(collection).createIndex(key, options); } catch (error) { console.warn(`Index ${collection} skipped:`, error.message); }
  }
  const config = await db.collection("platformConfig").findOne({ _id: "platform" });
  if (config) maintenance = { enabled: Boolean(config.maintenance?.enabled), message: config.maintenance?.message || "" };
}
function maintenanceGuard(req, res, next) {
  if (maintenance.enabled && !req.path.startsWith("/admin") && !["/", "/health", "/login", "/register"].includes(req.path)) return jsonError(res, 503, "Maintenance mode", maintenance.message);
  next();
}
app.use(maintenanceGuard);

app.get("/", (req, res) => res.json({ service: "RoLag API", status: "online", version: "2.1.0", database: Boolean(db), maintenance: maintenance.enabled }));
app.get("/health", (req, res) => res.status(db ? 200 : 503).json({ status: db ? "ok" : "degraded", database: Boolean(db), uptime: process.uptime(), timestamp: now().toISOString() }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, message: { error: "Too many authentication attempts" } });
app.post("/register", authLimiter, requireDb, asyncRoute(async (req, res) => {
  const email = cleanEmail(req.body.email); const password = String(req.body.password || "");
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || password.length > 128) return jsonError(res, 400, "Use a valid email and a password between 8 and 128 characters");
  try {
    const user = { email, password: await bcrypt.hash(password, 12), createdAt: now(), role: "user", status: "active", alertPrefs: { enabled: true, minFps: 30, cooldown: 60, emailEnabled: true, dashboardEnabled: true } };
    const result = await db.collection("users").insertOne(user);
    res.status(201).json({ user: safeUser({ ...user, _id: result.insertedId }) });
  } catch (error) { if (error.code === 11000) return jsonError(res, 409, "An account with that email already exists"); throw error; }
}));
app.post("/login", authLimiter, requireDb, asyncRoute(async (req, res) => {
  const email = cleanEmail(req.body.email); const password = String(req.body.password || "");
  const user = await db.collection("users").findOne({ email });
  if (!user || !(await bcrypt.compare(password, user.password))) return jsonError(res, 401, "Invalid email or password");
  if (user.status === "banned") return jsonError(res, 403, "This account has been banned");
  const token = jwt.sign({ id: String(user._id) }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  res.json({ token, user: safeUser(user) });
}));
app.get("/me", auth, (req, res) => res.json({ user: safeUser(req.user) }));
app.get("/me/prefs", auth, requireDb, (req, res) => res.json(req.user.alertPrefs || {}));
app.post("/me/prefs", auth, requireDb, asyncRoute(async (req, res) => {
  const input = req.body || {};
  const prefs = { enabled: input.enabled !== false, minFps: Math.max(1, Math.min(240, Number(input.minFps) || 30)), cooldown: Math.max(10, Math.min(86400, Number(input.cooldown) || 60)), emailEnabled: input.emailEnabled !== false, dashboardEnabled: input.dashboardEnabled !== false };
  await db.collection("users").updateOne({ _id: req.user._id }, { $set: { alertPrefs: prefs } });
  res.json(prefs);
}));
app.get("/me/export", auth, requireDb, asyncRoute(async (req, res) => {
  const id = String(req.user._id); const games = await db.collection("games").find({ owner: id }).toArray(); const gameIds = games.map(g => g.gameId);
  const [alerts, metrics, sessions] = await Promise.all([db.collection("alerts").find({ gameId: { $in: gameIds } }).toArray(), db.collection("metrics").find({ gameId: { $in: gameIds } }).sort({ time: -1 }).limit(10000).toArray(), db.collection("sessions").find({ gameId: { $in: gameIds } }).sort({ time: -1 }).limit(10000).toArray()]);
  res.json({ exportedAt: now().toISOString(), user: safeUser(req.user), preferences: req.user.alertPrefs || {}, games, alerts, metrics, sessions });
}));
app.post("/me/import", auth, requireDb, asyncRoute(async (req, res) => {
  const payload = req.body || {}; let imported = 0;
  for (const game of Array.isArray(payload.games) ? payload.games.slice(0, 50) : []) {
    if (!game?.gameId || typeof game.gameId !== "string") continue;
    await db.collection("games").updateOne({ gameId: game.gameId, owner: String(req.user._id) }, { $set: { name: String(game.name || game.gameId).slice(0, 120), owner: String(req.user._id), updatedAt: now() }, $setOnInsert: { gameId: game.gameId, createdAt: now() } }, { upsert: true }); imported++;
  }
  res.json({ imported });
}));

app.get("/games", auth, requireDb, asyncRoute(async (req, res) => res.json(await db.collection("games").find({ owner: String(req.user._id) }).sort({ updatedAt: -1 }).toArray())));
app.post("/register-game", auth, requireDb, asyncRoute(async (req, res) => {
  const gameId = String(req.body.gameId || "").trim(); const name = String(req.body.name || gameId).trim().slice(0, 120);
  if (!gameId || gameId.length > 120) return jsonError(res, 400, "gameId is required");
  const existing = await db.collection("games").findOne({ gameId });
  if (existing && existing.owner !== String(req.user._id)) return jsonError(res, 409, "That game is already owned by another account");
  const result = await db.collection("games").findOneAndUpdate({ gameId }, { $set: { gameId, name, owner: String(req.user._id), updatedAt: now() }, $setOnInsert: { createdAt: now() } }, { upsert: true, returnDocument: "after" });
  res.status(201).json(result.value || result);
}));
app.delete("/games/:gameId", auth, requireDb, asyncRoute(async (req, res) => { const result = await db.collection("games").deleteOne({ gameId: req.params.gameId, owner: String(req.user._id) }); if (!result.deletedCount) return jsonError(res, 404, "Game not found"); res.json({ ok: true }); }));

app.post("/data", telemetryAuth, requireDb, asyncRoute(async (req, res) => {
  const error = validateTelemetry(req.body); if (error) return jsonError(res, 400, error);
  const metric = { gameId: String(req.body.gameId), placeId: req.body.placeId ? String(req.body.placeId) : null, serverId: String(req.body.serverId), fps: Number(req.body.fps), players: Number(req.body.players), memoryMb: Number.isFinite(Number(req.body.memoryMb)) ? Number(req.body.memoryMb) : null, uptime: Number.isFinite(Number(req.body.uptime)) ? Number(req.body.uptime) : null, serverTimestamp: req.body.timestamp || null, time: now() };
  const game = await db.collection("games").findOne({ gameId: metric.gameId }); if (!game) return jsonError(res, 404, "Game is not registered");
  await db.collection("metrics").insertOne(metric);
  telemetryStats.accepted += 1;
  telemetryStats.lastAcceptedAt = now().toISOString();
  liveServers.set(`${metric.gameId}:${metric.serverId}`, { ...metric, lastUpdate: Date.now(), owner: game.owner });
  broadcast("metric", metric, socket => socket.userId === game.owner && (!socket.gameId || socket.gameId === metric.gameId));
  const owner = await db.collection("users").findOne({ _id: new ObjectId(game.owner) }); const prefs = owner?.alertPrefs || {};
  if (owner && prefs.enabled && prefs.dashboardEnabled !== false && metric.fps < Number(prefs.minFps || 30)) {
    const key = `${owner._id}:${metric.gameId}:${metric.serverId}`; const cooldown = Number(prefs.cooldown || 60) * 1000; const last = lastAlerts.get(key) || 0;
    if (Date.now() - last >= cooldown) {
      lastAlerts.set(key, Date.now()); const alert = { gameId: metric.gameId, serverId: metric.serverId, fps: metric.fps, threshold: Number(prefs.minFps || 30), message: `Server ${metric.serverId} is reporting ${metric.fps} FPS`, time: now() };
      await db.collection("alerts").insertOne(alert); broadcast("alert", alert, socket => socket.userId === game.owner && (!socket.gameId || socket.gameId === metric.gameId));
      if (prefs.emailEnabled !== false) await sendEmail(owner.email, "RoLag low FPS alert", alert.message);
    }
  }
  res.status(202).json({ ok: true });
}));
app.post("/session", telemetryAuth, requireDb, asyncRoute(async (req, res) => { const { gameId, serverId, userId, username, action } = req.body; if (!gameId || !serverId || !["join", "leave"].includes(action)) return jsonError(res, 400, "Invalid session payload"); const game = await db.collection("games").findOne({ gameId }); if (!game) return jsonError(res, 404, "Game is not registered"); await db.collection("sessions").insertOne({ gameId, serverId, userId: String(userId || ""), username: String(username || "").slice(0, 120), action, time: now() }); res.status(202).json({ ok: true }); }));

app.get("/live/:gameId", auth, requireDb, asyncRoute(async (req, res) => { if (!await getOwnedGame(req.user._id, req.params.gameId)) return jsonError(res, 404, "Game not found"); const cutoff = Date.now() - LIVE_TTL_MS; const servers = [...liveServers.values()].filter(s => s.gameId === req.params.gameId && s.lastUpdate >= cutoff).map(({ owner, lastUpdate, ...s }) => ({ ...s, online: true })); res.json(servers); }));
app.get("/alerts/:gameId", auth, requireDb, asyncRoute(async (req, res) => { if (!await getOwnedGame(req.user._id, req.params.gameId)) return jsonError(res, 404, "Game not found"); res.json(await db.collection("alerts").find({ gameId: req.params.gameId }).sort({ time: -1 }).limit(100).toArray()); }));
app.get("/metrics/:gameId", auth, requireDb, asyncRoute(async (req, res) => { if (!await getOwnedGame(req.user._id, req.params.gameId)) return jsonError(res, 404, "Game not found"); res.json(await db.collection("metrics").find({ gameId: req.params.gameId }).sort({ time: -1 }).limit(MAX_HISTORY).toArray()); }));
app.get("/timeline/:serverId", auth, requireDb, asyncRoute(async (req, res) => { const game = await db.collection("games").findOne({ owner: String(req.user._id), gameId: req.query.gameId }); const query = game ? { serverId: req.params.serverId, gameId: game.gameId } : { serverId: req.params.serverId }; res.json(await db.collection("metrics").find(query).sort({ time: 1 }).limit(MAX_HISTORY).toArray()); }));
app.get("/root/:serverId", auth, requireDb, asyncRoute(async (req, res) => { const gameIds = await db.collection("games").distinct("gameId", { owner: String(req.user._id) }); const metrics = await db.collection("metrics").find({ serverId: req.params.serverId, gameId: { $in: gameIds } }).sort({ time: 1 }).limit(MAX_HISTORY).toArray(); const findings = []; for (let i = 1; i < metrics.length; i++) if (Number(metrics[i].fps) < Number(metrics[i - 1].fps) - 10) findings.push({ type: "fps_drop", severity: "warning", from: metrics[i - 1].fps, to: metrics[i].fps, time: metrics[i].time }); res.json(findings); }));

app.get("/telemetry/status", auth, superadmin, requireDb, asyncRoute(async (req, res) => {
  const registeredGames = await db.collection("games").countDocuments();
  res.json({ configured: Boolean(TELEMETRY_SECRET), registeredGames, activeServers: [...liveServers.values()].filter(s => Date.now() - s.lastUpdate < LIVE_TTL_MS).length, ...telemetryStats });
}));

app.get("/admin/stats", auth, superadmin, requireDb, asyncRoute(async (req, res) => { const [users, games, metrics, alerts] = await Promise.all([db.collection("users").countDocuments(), db.collection("games").countDocuments(), db.collection("metrics").countDocuments(), db.collection("alerts").countDocuments()]); res.json({ users, games, metrics, alerts, activeServers: [...liveServers.values()].filter(s => Date.now() - s.lastUpdate < LIVE_TTL_MS).length, uptime: process.uptime(), database: true, maintenance }); }));
app.get("/admin/users", auth, superadmin, requireDb, asyncRoute(async (req, res) => { const search = String(req.query.search || "").trim(); const query = search ? { email: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } } : {}; const users = await db.collection("users").find(query, { projection: { password: 0 } }).sort({ createdAt: -1 }).limit(100).toArray(); const withCounts = await Promise.all(users.map(async user => ({ ...safeUser(user), games: await db.collection("games").countDocuments({ owner: String(user._id) }) }))); res.json(withCounts); }));
app.get("/admin/logs", auth, superadmin, requireDb, asyncRoute(async (req, res) => res.json(await db.collection("adminLogs").find().sort({ timestamp: -1 }).limit(200).toArray())));
app.get("/admin/status", auth, superadmin, (req, res) => res.json({ maintenance, nsys: { enabled: process.env.NSYS_MODE === "true", modules: loadedModules } }));
app.post("/admin/ban/:id", auth, superadmin, requireDb, asyncRoute(async (req, res) => { if (!isValidId(req.params.id) || String(req.user._id) === req.params.id) return jsonError(res, 400, "Invalid target"); await db.collection("users").updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: "banned" } }); await recordAdmin(req.user, "ban_user", req.params.id); res.json({ ok: true }); }));
app.post("/admin/unban/:id", auth, superadmin, requireDb, asyncRoute(async (req, res) => { if (!isValidId(req.params.id)) return jsonError(res, 400, "Invalid target"); await db.collection("users").updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: "active" } }); await recordAdmin(req.user, "unban_user", req.params.id); res.json({ ok: true }); }));
async function setMaintenance(req, res, enabled) { maintenance = { enabled, message: String(req.body.message || (enabled ? "RoLag is undergoing maintenance. Please check back shortly." : "")) }; await db.collection("platformConfig").updateOne({ _id: "platform" }, { $set: { maintenance, updatedAt: now() } }, { upsert: true }); await recordAdmin(req.user, enabled ? "maintenance_on" : "maintenance_off", null, { message: maintenance.message }); broadcast("maintenance", maintenance); res.json(maintenance); }
app.post("/admin/maintenance/on", auth, superadmin, requireDb, (req, res) => setMaintenance(req, res, true));
app.post("/admin/maintenance/off", auth, superadmin, requireDb, (req, res) => setMaintenance(req, res, false));

app.use("/dashboard", express.static(path.join(__dirname, "public")));
app.use((req, res) => jsonError(res, 404, "Route not found"));
app.use((error, req, res, next) => { console.error("Request error:", error); if (res.headersSent) return next(error); jsonError(res, 500, "Internal server error"); });

wss.on("connection", (ws, req) => { sockets.add(ws); ws.on("close", () => sockets.delete(ws)); ws.on("message", raw => { try { const message = JSON.parse(raw.toString()); if (message.type === "subscribe" && typeof message.gameId === "string") ws.gameId = message.gameId; } catch {} }); });
server.on("upgrade", async (request, socket, head) => { try { const url = new URL(request.url, `http://${request.headers.host}`); const token = url.searchParams.get("token"); if (!token || !JWT_SECRET || !db) throw new Error("unauthorized"); const claims = jwt.verify(token, JWT_SECRET); const user = await db.collection("users").findOne({ _id: new ObjectId(claims.id), status: { $ne: "banned" } }); if (!user) throw new Error("unauthorized"); wss.handleUpgrade(request, socket, head, ws => { ws.userId = String(user._id); wss.emit("connection", ws, request); }); } catch { socket.destroy(); } });

async function loadNSYS() { if (process.env.NSYS_MODE !== "true" || !db) return; const names = String(process.env.NSYS_MODULES || "").split(",").map(s => s.trim()).filter(Boolean); for (const name of [...new Set(names)]) { if (!/^[a-zA-Z0-9_-]+\.js$/.test(name)) { console.warn(`NSYS skipped unsafe module: ${name}`); continue; } try { const service = require(path.join(__dirname, "services", name)); if (typeof service !== "function") throw new Error("module must export a function"); await service({ app, db, broadcast, logger: console, config: { port: PORT } }); loadedModules.push(name); } catch (error) { console.error(`NSYS failed to load ${name}:`, error.message); } } }
setInterval(() => { const cutoff = Date.now() - LIVE_TTL_MS; for (const [key, value] of liveServers) if (value.lastUpdate < cutoff) { liveServers.delete(key); broadcast("server_offline", { gameId: value.gameId, serverId: value.serverId }, socket => socket.userId === value.owner); } }, 10000).unref();

async function start() { if (!mongo) return server.listen(PORT, () => console.log(`RoLag API listening on ${PORT} without database`)); try { await mongo.connect(); db = mongo.db("rolag"); await ensureIndexes(); await loadNSYS(); server.listen(PORT, () => console.log(`RoLag API listening on ${PORT}`)); } catch (error) { console.error("Database connection failed:", error.message); process.exitCode = 1; } }
async function shutdown(signal) { if (shuttingDown) return; shuttingDown = true; console.log(`${signal}: shutting down`); for (const ws of sockets) ws.close(); await new Promise(resolve => server.close(resolve)); if (mongo) await mongo.close(); process.exit(0); }
process.on("SIGTERM", () => shutdown("SIGTERM")); process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", error => { console.error("Uncaught exception:", error); });
process.on("unhandledRejection", error => { console.error("Unhandled rejection:", error); });
start();
