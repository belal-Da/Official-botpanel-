"use strict";
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const fs = require("fs-extra");
const path = require("path");
const { spawn } = require("child_process");
const mongoStore = require("./utils/mongoStore");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const PASSWORD = process.env.PANEL_PASSWORD;
const BDIR = path.join(__dirname, "bot"); // এখানেই আপলোড করা official-bot প্রজেক্ট এক্সট্র্যাক্ট হবে
const EDITABLE_SUBDIRS = ["commands", "utils"]; // বটের ভেতরে শুধু এই ফোল্ডারগুলো এডিট/ডিলিটযোগ্য
const ROOT_EDITABLE_FILES = [".env", "package.json"]; // বটের রুটে শুধু এই ফাইলগুলো এডিটযোগ্য

fs.ensureDirSync(BDIR);

// ✅ Render free tier-এ persistent disk নেই — কন্টেইনার রিক্রিয়েট হলে
// bot/ ফোল্ডার খালি হয়ে যেতে পারে। এটা সামলাতে দুই স্তরের ব্যবস্থা:
// ১) MongoDB-তে সিঙ্ক করা প্রতিটা ফাইল (সবচেয়ে আপ-টু-ডেট, প্রতিটা সেভ/
//    ডিলিটেই আপডেট হয়) — এটাই প্রথম চেষ্টা।
// ২) bot-template/ (এই রিপোতেই কমিট করা, শুধু প্রথমবার/Mongo না থাকলে)
const TEMPLATE_DIR = path.join(__dirname, "bot-template");
async function autoSeed() {
  const isEmpty = (await fs.readdir(BDIR)).length === 0;
  if (!isEmpty) return;

  if (mongoStore.isConnected()) {
    const count = await mongoStore.countAll();
    if (count > 0) {
      const files = await mongoStore.listAll();
      for (const f of files) {
        const full = path.join(BDIR, f.path);
        await fs.ensureDir(path.dirname(full));
        await fs.writeFile(full, f.content, "utf8");
      }
      pushLog("info", `🗄️ MongoDB থেকে ${files.length}টা ফাইল রিস্টোর হলো`);
    }
  }

  // MongoDB থেকে কিছু না এলে (নতুন/খালি DB) বা index.js এখনো না থাকলে
  // bot-template/ থেকে বেস কোড বসানো — commands/utils-এর runtime এডিট
  // Mongo-তে থাকলে সেগুলো ওপরের ধাপেই ইতিমধ্যে বসে গেছে
  if (!(await fs.pathExists(path.join(BDIR, "index.js"))) && (await fs.pathExists(path.join(TEMPLATE_DIR, "index.js")))) {
    await fs.copy(TEMPLATE_DIR, BDIR, { overwrite: false });
    pushLog("info", "🌱 bot-template/ থেকে বেস কোড বসানো হলো");
  }

  if (await fs.pathExists(path.join(BDIR, "index.js"))) npmInstallThenStart();
}

// ──────────────────────────── লগ রিং-বাফার ────────────────────────────
const MAX_LOG_LINES = 800;
const logLines = [];
function pushLog(level, text) {
  logLines.push({ t: Date.now(), level, text: String(text) });
  if (logLines.length > MAX_LOG_LINES) logLines.shift();
}
pushLog("info", "🎛️ Panel চালু হলো");

// ──────────────────────────── বট সাবপ্রসেস ম্যানেজমেন্ট ────────────────────────────
let botProc = null;
let botState = "stopped"; // stopped | installing | starting | running | crashed
let restartTimestamps = [];

function spawnLogged(cmd, args, opts, onDone) {
  const p = spawn(cmd, args, { cwd: BDIR, env: process.env, ...opts });
  p.stdout.on("data", (d) => pushLog("info", d.toString().trim()));
  p.stderr.on("data", (d) => pushLog("error", d.toString().trim()));
  p.on("close", (code) => onDone && onDone(code));
  return p;
}

function npmInstallThenStart() {
  botState = "installing";
  pushLog("info", "📦 npm install শুরু হচ্ছে...");
  spawnLogged("npm", ["install", "--no-audit", "--no-fund"], {}, (code) => {
    if (code !== 0) {
      botState = "crashed";
      pushLog("error", `❌ npm install ব্যর্থ (exit ${code})`);
      return;
    }
    pushLog("info", "✅ npm install সম্পন্ন");
    startBot();
  });
}

function startBot() {
  const idx = path.join(BDIR, "index.js");
  if (!fs.existsSync(idx)) {
    pushLog("error", "❌ bot/index.js পাওয়া যায়নি — আগে জিপ আপলোড করুন");
    botState = "stopped";
    return;
  }
  botState = "starting";
  pushLog("info", "🚀 বট চালু হচ্ছে...");
  botProc = spawnLogged("node", ["index.js"], {}, (code) => {
    botState = "stopped";
    pushLog("error", `⚠️ বট বন্ধ হয়ে গেছে (exit ${code})`);
    botProc = null;

    // ✅ ৩০ মিনিটে ৪ বারের বেশি অটো-রিস্টার্ট না — বারবার ক্র্যাশ-লুপ
    // (যেমন খারাপ কোড সেভ হয়ে থাকলে) সার্ভার overload করবে না
    const now = Date.now();
    restartTimestamps = restartTimestamps.filter((t) => now - t < 30 * 60 * 1000);
    if (restartTimestamps.length >= 4) {
      pushLog("error", "🛑 ৩০ মিনিটে ৪ বার ক্র্যাশ হয়েছে — অটো-রিস্টার্ট বন্ধ রাখা হলো। প্যানেল থেকে ম্যানুয়ালি স্টার্ট করুন।");
      return;
    }
    restartTimestamps.push(now);
    setTimeout(() => { if (botState === "stopped") startBot(); }, 5000);
  });
  botState = "running";
}

function stopBot() {
  if (botProc) {
    botProc.kill();
    botProc = null;
  }
  botState = "stopped";
  pushLog("info", "⏹️ বট বন্ধ করা হলো");
}

// ──────────────────────────── অথ মিডলওয়্যার ────────────────────────────
function auth(req, res, next) {
  if (!PASSWORD) return res.status(500).json({ error: "PANEL_PASSWORD .env এ সেট করা নেই" });
  const token = req.headers["x-panel-token"] || req.query.token;
  if (token !== PASSWORD) return res.status(401).json({ error: "ভুল পাসওয়ার্ড" });
  next();
}

// জিপ আপলোডের পর commands/utils/package.json — সবকিছু MongoDB-তে সিঙ্ক
// করা (.env ইচ্ছা করেই বাদ — সিক্রেট key ডাটাবেজে না রাখাই ভালো অভ্যাস,
// সেগুলো Render Environment Variables-এ রাখুন)
async function syncAllToMongo() {
  if (!mongoStore.isConnected()) return 0;
  let count = 0;
  for (const dir of EDITABLE_SUBDIRS) {
    const dirPath = path.join(BDIR, dir);
    if (!(await fs.pathExists(dirPath))) continue;
    for (const f of await fs.readdir(dirPath)) {
      if (!f.endsWith(".js")) continue;
      const content = await fs.readFile(path.join(dirPath, f), "utf8");
      await mongoStore.saveFile(`${dir}/${f}`, content);
      count++;
    }
  }
  const pkgPath = path.join(BDIR, "package.json");
  if (await fs.pathExists(pkgPath)) {
    await mongoStore.saveFile("package.json", await fs.readFile(pkgPath, "utf8"));
    count++;
  }
  return count;
}

// ──────────────────────────── আপলোড (zip → bot/) ────────────────────────────
const upload = multer({ storage: multer.diskStorage({ destination: "/tmp", filename: (r, f, cb) => cb(null, Date.now() + "_" + f.originalname) }), limits: { fileSize: 200 * 1024 * 1024 } });

app.post("/api/upload", auth, upload.single("zip"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "জিপ ফাইল পাওয়া যায়নি" });
    stopBot();

    await fs.emptyDir(BDIR); // পুরনো বট ফাইল মুছে নতুনটা বসানো
    const zip = new AdmZip(req.file.path);
    const entries = zip.getEntries();

    // জিপের ভেতরে যদি একটাই টপ-লেভেল ফোল্ডার থাকে (যেমন official-bot/...),
    // সেই ফোল্ডারের ভেতরের কনটেন্টটাই bot/-এ রাখা, extra nesting এড়াতে
    const topDirs = new Set(entries.map((e) => e.entryName.split("/")[0]));
    const singleRoot = topDirs.size === 1 ? [...topDirs][0] : null;

    zip.extractAllTo(BDIR, true);
    if (singleRoot && fs.existsSync(path.join(BDIR, singleRoot)) && fs.statSync(path.join(BDIR, singleRoot)).isDirectory()) {
      const inner = path.join(BDIR, singleRoot);
      for (const f of await fs.readdir(inner)) {
        await fs.move(path.join(inner, f), path.join(BDIR, f), { overwrite: true });
      }
      await fs.remove(inner);
    }

    await fs.remove(req.file.path);
    const syncedCount = await syncAllToMongo();
    pushLog("info", `📦 জিপ এক্সট্র্যাক্ট হলো (${entries.length} এন্ট্রি), MongoDB-তে ${syncedCount}টা ফাইল সিঙ্ক হলো`);
    res.json({ ok: true, msg: "জিপ এক্সট্র্যাক্ট হয়েছে। এখন 'Install + Start' চাপুন।" });
  } catch (e) {
    pushLog("error", "❌ আপলোড ব্যর্থ: " + e.message);
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────── বট কন্ট্রোল ────────────────────────────
app.post("/api/bot/install-start", auth, (req, res) => { npmInstallThenStart(); res.json({ ok: true }); });
app.post("/api/bot/start", auth, (req, res) => { startBot(); res.json({ ok: true }); });
app.post("/api/bot/stop", auth, (req, res) => { stopBot(); res.json({ ok: true }); });
app.post("/api/bot/restart", auth, (req, res) => { stopBot(); setTimeout(startBot, 1000); res.json({ ok: true }); });

app.get("/api/status", auth, (req, res) => {
  res.json({
    botState,
    panelUptimeSec: Math.floor(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    time: new Date().toISOString(),
    hasProject: fs.existsSync(path.join(BDIR, "index.js")),
  });
});

app.get("/api/logs", auth, (req, res) => res.json({ lines: logLines }));

// ──────────────────────────── ফাইল ম্যানেজার (bot/ এর ভেতরে) ────────────────────────────
function safeResolve(relPath) {
  const cleaned = String(relPath || "").replace(/^\/+/, "");
  const top = cleaned.split("/")[0];
  if (!EDITABLE_SUBDIRS.includes(top) && !ROOT_EDITABLE_FILES.includes(cleaned)) {
    throw new Error("এই পাথ এডিট/ডিলিট করার অনুমতি নেই");
  }
  const full = path.resolve(BDIR, cleaned);
  if (!full.startsWith(path.resolve(BDIR))) throw new Error("অবৈধ পাথ");
  return full;
}

app.get("/api/files", auth, async (req, res) => {
  try {
    const result = [];
    for (const f of ROOT_EDITABLE_FILES) {
      const fp = path.join(BDIR, f);
      if (await fs.pathExists(fp)) result.push({ path: f, size: (await fs.stat(fp)).size });
    }
    for (const dir of EDITABLE_SUBDIRS) {
      const dirPath = path.join(BDIR, dir);
      if (!(await fs.pathExists(dirPath))) continue;
      for (const f of await fs.readdir(dirPath)) {
        if (!f.endsWith(".js")) continue;
        const stat = await fs.stat(path.join(dirPath, f));
        result.push({ path: `${dir}/${f}`, size: stat.size });
      }
    }
    res.json({ files: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/file", auth, async (req, res) => {
  try {
    const full = safeResolve(req.query.path);
    const content = (await fs.pathExists(full)) ? await fs.readFile(full, "utf8") : "";
    res.json({ path: req.query.path, content });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/file", auth, async (req, res) => {
  try {
    const { path: relPath, content } = req.body;
    const full = safeResolve(relPath);
    if (relPath.endsWith(".js")) {
      try { new Function(content); } catch (se) { return res.status(400).json({ error: "সিনট্যাক্স এরর, সেভ হয়নি: " + se.message }); }
    }
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content, "utf8");
    if (relPath !== ".env") {
      mongoStore.saveFile(relPath, content).catch((e) => pushLog("error", "Mongo সিঙ্ক ব্যর্থ: " + e.message));
    }
    pushLog("info", `✏️ ফাইল সেভ হলো: ${relPath}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete("/api/file", auth, async (req, res) => {
  try {
    const relPath = req.body?.path || req.query.path;
    const full = safeResolve(relPath);
    await fs.remove(full);
    mongoStore.deleteFile(relPath).catch((e) => pushLog("error", "Mongo সিঙ্ক ব্যর্থ: " + e.message));
    pushLog("info", `🗑️ ফাইল ডিলিট হলো: ${relPath}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ──────────────────────────── UptimeRobot হেলথ-চেক ────────────────────────────
// Render free tier নিষ্ক্রিয় থাকলে ঘুমিয়ে পড়ে — UptimeRobot প্রতি কয়েক
// মিনিটে এই URL-এ পিং করলে সার্ভার জেগে থাকবে
app.get("/ping", (req, res) => res.status(200).send("OK " + new Date().toISOString()));

// ──────────────────────────── প্যানেল UI ────────────────────────────
app.get("/", (req, res) => res.type("html").send(PANEL_HTML));

const PANEL_HTML = `<!DOCTYPE html>
<html lang="bn"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Bot Panel</title>
<style>
:root{color-scheme:dark;--accent:#2f81f7;--accent2:#7c5cff;--bg:#0b0e14;--card:#141922;--border:#242c3a}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,system-ui,"Segoe UI",sans-serif;background:var(--bg);color:#e6edf3;padding-bottom:50px}
header{padding:16px;background:linear-gradient(135deg,#161b22 0%,#1c2333 100%);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;align-items:center;box-shadow:0 2px 12px rgba(0,0,0,.35)}
.brand{display:flex;align-items:center;gap:10px}
.logo{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:19px;box-shadow:0 2px 10px rgba(124,92,255,.4)}
header h1{font-size:17px;margin:0;font-weight:700;letter-spacing:.2px}
header .sub{font-size:11px;color:#8b949e;margin-top:1px}
.badge{font-size:11px;padding:5px 12px;border-radius:20px;background:var(--border);font-weight:600;letter-spacing:.3px}
.badge.running{background:linear-gradient(135deg,#1f6f3d,#2ea043);box-shadow:0 0 10px rgba(46,160,67,.4)}
.badge.stopped{background:linear-gradient(135deg,#5a1e1e,#da3633)}
.badge.installing,.badge.starting{background:linear-gradient(135deg,#6e5a12,#d9a521);color:#1a1300}
.tabs{display:flex;gap:6px;padding:12px 14px;background:#10141c;overflow-x:auto;border-bottom:1px solid var(--border)}
.tab{padding:9px 15px;border-radius:22px;background:var(--card);white-space:nowrap;font-size:13.5px;font-weight:600;color:#9198a1;border:1px solid var(--border)}
.tab.active{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border-color:transparent;box-shadow:0 2px 10px rgba(47,129,247,.35)}
.content{padding:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:14px}
.card h3{margin:0 0 10px;font-size:14px;color:#9198a1;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
.file-row{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:var(--card);border:1px solid var(--border);border-radius:12px;margin-bottom:8px}
.file-row .fname{font-family:monospace;font-size:13.5px;display:flex;align-items:center;gap:8px;overflow:hidden}
.file-row .fname .ico{font-size:15px;flex-shrink:0}
.file-row .fname .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.folder-group{margin-bottom:18px}
.folder-head{display:flex;align-items:center;gap:8px;padding:4px 4px 10px;color:#9198a1;font-size:12.5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border);margin-bottom:10px}
.folder-head .count{background:var(--border);color:#c9d1d9;font-size:10.5px;padding:2px 8px;border-radius:10px;font-weight:600;text-transform:none;letter-spacing:0}
button{background:var(--accent);color:#fff;border:none;padding:10px 16px;border-radius:10px;font-size:13.5px;margin:3px 3px 3px 0;font-weight:600;transition:opacity .15s}
button:active{opacity:.75}
button.danger{background:linear-gradient(135deg,#c23b3b,#da3633)}
button.secondary{background:var(--border);color:#e6edf3}
button.success{background:linear-gradient(135deg,#2ea043,#22863a)}
textarea{width:100%;height:52vh;background:#0b0e14;color:#e6edf3;border:1px solid var(--border);border-radius:10px;padding:12px;font-family:"SF Mono",monospace;font-size:12.5px;box-sizing:border-box}
input[type=text],input[type=password],input[type=file]{width:100%;box-sizing:border-box;padding:11px;border-radius:10px;border:1px solid var(--border);background:#0b0e14;color:#e6edf3;margin-bottom:10px;font-size:14px}
input[type=text]:focus,input[type=password]:focus{outline:none;border-color:var(--accent)}
.log-line{font-family:"SF Mono",monospace;font-size:11.5px;padding:5px 0;border-bottom:1px solid #1a2029;white-space:pre-wrap;word-break:break-all}
.log-error{color:#f85149}.log-warn{color:#e3b341}
.hidden{display:none}
.row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.status-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.status-box{background:var(--card);border:1px solid var(--border);padding:14px;border-radius:12px}
.status-box b{font-size:19px;display:block;background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
.status-box .lbl{font-size:12px;color:#8b949e;margin-top:2px}
.empty{text-align:center;color:#6e7681;padding:30px 10px;font-size:13.5px}
</style></head>
<body>
<div id="loginScreen" class="content" style="max-width:380px;margin:60px auto 0">
  <div style="text-align:center;margin-bottom:26px">
    <div class="logo" style="width:60px;height:60px;font-size:30px;margin:0 auto 14px">🤖</div>
    <h2 style="margin:0">Bot Panel</h2>
    <p style="color:#8b949e;font-size:13px;margin-top:4px">official-messenger-bot নিয়ন্ত্রণ কেন্দ্র</p>
  </div>
  <div class="card">
    <input type="password" id="pwInput" placeholder="PANEL_PASSWORD দিন">
    <button onclick="doLogin()" style="width:100%">🔓 লগইন করুন</button>
  </div>
</div>

<div id="app" class="hidden">
  <header>
    <div class="brand">
      <div class="logo">🤖</div>
      <div><h1>Bot Panel</h1><div class="sub">official-messenger-bot</div></div>
    </div>
    <span id="stateBadge" class="badge">...</span>
  </header>
  <div class="tabs">
    <div class="tab active" data-tab="deploy" onclick="switchTab('deploy')">🚀 ডিপ্লয়</div>
    <div class="tab" data-tab="files" onclick="switchTab('files')">📁 ফাইল</div>
    <div class="tab" data-tab="logs" onclick="switchTab('logs')">📜 লগ</div>
    <div class="tab" data-tab="status" onclick="switchTab('status')">📊 স্ট্যাটাস</div>
  </div>
  <div class="content">

    <div id="tab-deploy">
      <div class="card">
        <h3>জিপ আপলোড</h3>
        <p style="font-size:13px;color:#9198a1;margin-top:0">official-bot.zip আপলোড করুন (পুরনো bot/ ফোল্ডার মুছে নতুনটা বসবে):</p>
        <input type="file" id="zipInput" accept=".zip">
        <button onclick="uploadZip()" class="success">⬆️ আপলোড করুন</button>
        <p id="uploadMsg" style="font-size:13px;color:#9198a1"></p>
      </div>
      <div class="card">
        <h3>কন্ট্রোল</h3>
        <div class="row">
          <button onclick="botAction('install-start')" class="success">📦 Install + Start</button>
          <button onclick="botAction('start')">▶️ Start</button>
          <button onclick="botAction('stop')" class="danger">⏹️ Stop</button>
          <button onclick="botAction('restart')" class="secondary">🔄 Restart</button>
        </div>
      </div>
    </div>

    <div id="tab-files" class="hidden">
      <div class="card">
        <h3>নতুন ফাইল যোগ করুন</h3>
        <input type="text" id="newFilePath" placeholder="commands/mycommand.js">
        <button onclick="createFile()" class="success" style="width:100%">➕ ফাইল তৈরি করুন</button>
      </div>
      <div id="fileList"></div>
    </div>

    <div id="tab-logs" class="hidden">
      <button class="secondary" onclick="loadLogs()">🔄 রিফ্রেশ</button>
      <div id="logView" style="margin-top:10px"></div>
    </div>

    <div id="tab-status" class="hidden">
      <div class="status-grid" id="statusGrid"></div>
      <p style="font-size:12px;color:#9198a1;margin-top:12px">UptimeRobot মনিটর URL হিসেবে এই ঠিকানা ব্যবহার করুন: <code>/ping</code></p>
    </div>

    <div id="editorView" class="hidden">
      <div class="row">
        <button class="secondary" onclick="closeEditor()">← ফিরে যান</button>
        <button onclick="saveFile()">💾 সেভ করুন</button>
        <button class="danger" onclick="deleteFile()">🗑️ ডিলিট</button>
      </div>
      <p id="editorPath" style="font-family:monospace;font-size:13px;margin:10px 0 6px"></p>
      <textarea id="editorContent"></textarea>
    </div>

  </div>
</div>

<script>
let TOKEN = localStorage.getItem("panelToken") || "";
let currentFile = null;
let statusTimer = null;

function api(p, opts = {}) {
  opts.headers = Object.assign({ "x-panel-token": TOKEN }, opts.headers || {});
  return fetch(p, opts).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || "এরর"); return d; });
}

function doLogin() { TOKEN = document.getElementById("pwInput").value.trim(); localStorage.setItem("panelToken", TOKEN); boot(); }

async function boot() {
  if (!TOKEN) return;
  try {
    await api("/api/status");
    document.getElementById("loginScreen").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    refreshBadge();
    statusTimer = setInterval(refreshBadge, 8000);
  } catch (e) {
    document.getElementById("loginScreen").classList.remove("hidden");
    document.getElementById("app").classList.add("hidden");
  }
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  ["deploy","files","logs","status"].forEach(t => document.getElementById("tab-" + t).classList.toggle("hidden", t !== name));
  closeEditor();
  if (name === "files") loadFiles();
  if (name === "logs") loadLogs();
  if (name === "status") loadStatus();
}

async function refreshBadge() {
  try {
    const s = await api("/api/status");
    const b = document.getElementById("stateBadge");
    b.textContent = s.botState;
    b.className = "badge " + s.botState;
  } catch (e) {}
}

async function uploadZip() {
  const f = document.getElementById("zipInput").files[0];
  if (!f) return alert("আগে একটা zip ফাইল বাছুন");
  const fd = new FormData(); fd.append("zip", f);
  document.getElementById("uploadMsg").textContent = "⏳ আপলোড হচ্ছে...";
  try {
    const r = await fetch("/api/upload?token=" + encodeURIComponent(TOKEN), { method: "POST", body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    document.getElementById("uploadMsg").textContent = "✅ " + d.msg;
  } catch (e) { document.getElementById("uploadMsg").textContent = "❌ " + e.message; }
}

async function botAction(action) {
  await api("/api/bot/" + action, { method: "POST" });
  setTimeout(refreshBadge, 1500);
}

function fileIcon(p) {
  if (p.endsWith(".env")) return "🔐";
  if (p.endsWith(".json")) return "⚙️";
  if (p.endsWith(".md")) return "📘";
  if (p.startsWith("commands/")) return "⚡";
  if (p.startsWith("utils/")) return "🧩";
  return "📄";
}

const FOLDER_LABELS = { "": "রুট ফাইল", commands: "⚡ কমান্ড", utils: "🧩 ইউটিলিটি" };

async function loadFiles() {
  const { files } = await api("/api/files");
  if (!files.length) {
    document.getElementById("fileList").innerHTML = "<div class='empty'>এখনো কোনো ফাইল আপলোড হয়নি</div>";
    return;
  }

  // ফোল্ডার অনুযায়ী গ্রুপ করা: root ফাইল আগে, তারপর commands/, তারপর utils/
  const groups = {};
  for (const f of files) {
    const parts = f.path.split("/");
    const folder = parts.length > 1 ? parts[0] : "";
    (groups[folder] = groups[folder] || []).push(f);
  }
  const order = ["", "commands", "utils"].filter((k) => groups[k]);
  for (const k of Object.keys(groups)) if (!order.includes(k)) order.push(k);

  document.getElementById("fileList").innerHTML = order.map((folder) => {
    const list = groups[folder].sort((a, b) => a.path.localeCompare(b.path));
    const rows = list.map(f => \`
      <div class="file-row">
        <span class="fname"><span class="ico">\${fileIcon(f.path)}</span><span class="nm">\${f.path.split("/").pop()}</span></span>
        <button class="secondary" onclick="openFile('\${f.path}')">✏️ এডিট</button>
      </div>\`).join("");
    return \`<div class="folder-group">
      <div class="folder-head">\${FOLDER_LABELS[folder] || folder}<span class="count">\${list.length}</span></div>
      \${rows}
    </div>\`;
  }).join("");
}

async function createFile() {
  const p = document.getElementById("newFilePath").value.trim();
  if (!p) return alert("ফাইলের পাথ দিন, যেমন commands/mycommand.js");
  const isJs = p.endsWith(".js");
  const template = isJs
    ? "\\"use strict\\";\\nmodule.exports = async function (senderId, args, { sendText }) {\\n  await sendText(senderId, 'হ্যালো! এটা একটা নতুন কমান্ড।');\\n};\\n"
    : "";
  try {
    await api("/api/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p, content: template }) });
    document.getElementById("newFilePath").value = "";
    loadFiles();
    alert("✅ ফাইল তৈরি হয়েছে — লিস্টে গিয়ে এডিট করুন");
  } catch (e) { alert("❌ " + e.message); }
}

async function openFile(p) {
  const { content } = await api("/api/file?path=" + encodeURIComponent(p));
  currentFile = p;
  document.getElementById("editorPath").textContent = p;
  document.getElementById("editorContent").value = content;
  document.getElementById("editorView").classList.remove("hidden");
  document.getElementById("tab-files").classList.add("hidden");
}

function closeEditor() {
  document.getElementById("editorView").classList.add("hidden");
  const filesTab = document.querySelector('.tab[data-tab="files"]');
  if (filesTab && filesTab.classList.contains("active")) document.getElementById("tab-files").classList.remove("hidden");
  currentFile = null;
}

async function saveFile() {
  try {
    await api("/api/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: currentFile, content: document.getElementById("editorContent").value }) });
    alert("✅ সেভ হয়েছে — বট চালু থাকলে Restart চাপুন কার্যকর করতে");
  } catch (e) { alert("❌ " + e.message); }
}

async function deleteFile() {
  if (!confirm("নিশ্চিত? " + currentFile + " ডিলিট হয়ে যাবে")) return;
  await api("/api/file?path=" + encodeURIComponent(currentFile), { method: "DELETE" });
  closeEditor(); loadFiles();
}

async function loadLogs() {
  const { lines } = await api("/api/logs");
  document.getElementById("logView").innerHTML = lines.slice().reverse().map(l =>
    \`<div class="log-line \${l.level === 'error' ? 'log-error' : l.level === 'warn' ? 'log-warn' : ''}">[\${new Date(l.t).toLocaleTimeString('bn-BD')}] \${l.text}</div>\`
  ).join("") || "<p>কোনো লগ নেই</p>";
}

async function loadStatus() {
  const s = await api("/api/status");
  document.getElementById("statusGrid").innerHTML = \`
    <div class="status-box"><b>\${s.botState}</b><div class="lbl">বট স্ট্যাটাস</div></div>
    <div class="status-box"><b>\${Math.floor(s.panelUptimeSec/60)}m</b><div class="lbl">প্যানেল আপটাইম</div></div>
    <div class="status-box"><b>\${s.memoryMB} MB</b><div class="lbl">মেমরি</div></div>
    <div class="status-box"><b>\${s.hasProject ? "✅" : "❌"}</b><div class="lbl">প্রজেক্ট আপলোড আছে</div></div>\`;
}

boot();
</script>
</body></html>`;

process.on("unhandledRejection", (r) => pushLog("error", "unhandledRejection: " + r));
process.on("uncaughtException", (e) => pushLog("error", "uncaughtException: " + e.message));

app.listen(PORT, () => {
  console.log(`🎛️ Panel চালু — পোর্ট ${PORT}`);
  mongoStore
    .connect()
    .then(() => autoSeed())
    .catch((e) => pushLog("error", "স্টার্টআপ সিড ব্যর্থ: " + e.message));
});
