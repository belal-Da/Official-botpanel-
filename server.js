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
      if (await fs.pathExists(fp)) {
        const st = await fs.stat(fp);
        result.push({ path: f, size: st.size, mtime: st.mtimeMs });
      }
    }
    for (const dir of EDITABLE_SUBDIRS) {
      const dirPath = path.join(BDIR, dir);
      if (!(await fs.pathExists(dirPath))) continue;
      for (const f of await fs.readdir(dirPath)) {
        if (!f.endsWith(".js")) continue;
        const stat = await fs.stat(path.join(dirPath, f));
        result.push({ path: `${dir}/${f}`, size: stat.size, mtime: stat.mtimeMs });
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

// ── নাম পরিবর্তন ──
app.post("/api/file/rename", auth, async (req, res) => {
  try {
    const { from, to } = req.body;
    const fullFrom = safeResolve(from);
    const fullTo = safeResolve(to);
    if (!(await fs.pathExists(fullFrom))) throw new Error("সোর্স ফাইল পাওয়া যায়নি");
    if (await fs.pathExists(fullTo)) throw new Error("এই নামে ইতিমধ্যে একটা ফাইল আছে");
    await fs.move(fullFrom, fullTo);
    const content = await fs.readFile(fullTo, "utf8");
    mongoStore.deleteFile(from).catch(() => {});
    if (to !== ".env") mongoStore.saveFile(to, content).catch(() => {});
    pushLog("info", `🔤 নাম পরিবর্তন: ${from} → ${to}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── কপি/ডুপ্লিকেট ──
app.post("/api/file/copy", auth, async (req, res) => {
  try {
    const { from, to } = req.body;
    const fullFrom = safeResolve(from);
    const fullTo = safeResolve(to);
    if (!(await fs.pathExists(fullFrom))) throw new Error("সোর্স ফাইল পাওয়া যায়নি");
    if (await fs.pathExists(fullTo)) throw new Error("এই নামে ইতিমধ্যে একটা ফাইল আছে");
    await fs.copy(fullFrom, fullTo);
    const content = await fs.readFile(fullTo, "utf8");
    if (to !== ".env") mongoStore.saveFile(to, content).catch(() => {});
    pushLog("info", `📋 কপি হলো: ${from} → ${to}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── ডাউনলোড ──
app.get("/api/file/download", (req, res) => {
  try {
    if (req.query.token !== PASSWORD) return res.status(401).send("ভুল পাসওয়ার্ড");
    const full = safeResolve(req.query.path);
    res.download(full);
  } catch (e) { res.status(400).send(e.message); }
});

// ──────────────────────────── UptimeRobot হেলথ-চেক ────────────────────────────
// Render free tier নিষ্ক্রিয় থাকলে ঘুমিয়ে পড়ে — UptimeRobot প্রতি কয়েক
// মিনিটে এই URL-এ পিং করলে সার্ভার জেগে থাকবে
app.get("/ping", (req, res) => res.status(200).send("OK " + new Date().toISOString()));

// ──────────────────────────── প্যানেল UI ────────────────────────────
app.get("/", (req, res) => res.type("html").send(PANEL_HTML));

const PANEL_HTML = `<!DOCTYPE html>
<html lang="bn"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#07070e">
<title>Bot Panel</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{--bg:#07070e;--s1:#0d0d18;--s2:#141424;--s3:#1a1a2e;--bd:#232338;--tx:#dde0f0;--mu:#5a5a80;--ac:#6c63ff;--gr:#3ecf8e;--rd:#f05252;--yw:#f0b429;--bl:#38bdf8}
body{background:var(--bg);color:var(--tx);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;overflow-x:hidden}

/* ── লগইন স্ক্রিন ── */
#loginScreen{min-height:100vh;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
.bg{position:fixed;inset:0}
.orb{position:absolute;border-radius:50%;filter:blur(90px);opacity:.22;animation:fl 8s ease-in-out infinite}
.o1{width:500px;height:500px;background:#6c63ff;top:-150px;left:-150px}
.o2{width:350px;height:350px;background:#ff6584;bottom:-100px;right:-100px;animation-delay:4s}
.o3{width:200px;height:200px;background:#43e97b;top:40%;left:45%;animation-delay:2s}
@keyframes fl{0%,100%{transform:scale(1)}50%{transform:scale(1.2)}}
.card{position:relative;z-index:1;background:rgba(255,255,255,.04);backdrop-filter:blur(40px);border:1px solid rgba(255,255,255,.08);border-radius:28px;padding:48px 34px;width:90%;max-width:400px;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.6)}
.logo-lg{width:84px;height:84px;margin:0 auto 20px;background:linear-gradient(135deg,#6c63ff,#ff6584);border-radius:24px;display:flex;align-items:center;justify-content:center;font-size:38px;box-shadow:0 0 60px rgba(108,99,255,.5);animation:pulse 3s ease-in-out infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 40px rgba(108,99,255,.4)}50%{box-shadow:0 0 90px rgba(108,99,255,.9)}}
.card h1{color:#fff;font-size:23px;font-weight:900;margin-bottom:4px}
.card .sub{color:rgba(255,255,255,.35);font-size:13px;margin-bottom:32px}
#loginScreen input{width:100%;padding:15px 18px;border-radius:14px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.06);color:#fff;font-size:15px;outline:none;margin-bottom:14px;transition:.3s}
#loginScreen input:focus{border-color:#6c63ff;background:rgba(108,99,255,.1)}
.login-btn{width:100%;padding:15px;border-radius:14px;border:none;background:linear-gradient(135deg,#6c63ff,#ff6584);color:#fff;font-size:16px;font-weight:800;cursor:pointer;transition:.3s}
.login-btn:active{transform:scale(.98)}
.login-err{background:rgba(255,85,85,.1);border:1px solid rgba(255,85,85,.2);color:#ff8080;padding:11px;border-radius:10px;font-size:13px;margin-bottom:14px;display:none}
.login-err.show{display:block}

/* ── টপ বার ── */
.top{position:fixed;top:0;left:0;right:0;height:54px;background:rgba(13,13,24,.97);backdrop-filter:blur(20px);border-bottom:1px solid var(--bd);display:flex;align-items:center;padding:0 14px;z-index:200;gap:10px;padding-top:env(safe-area-inset-top,0px)}
.top-logo{width:34px;height:34px;background:linear-gradient(135deg,var(--ac),#ff6584);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0;box-shadow:0 0 20px rgba(108,99,255,.4)}
.top-logo.live{animation:logoPulse 1.8s ease-in-out infinite}
@keyframes logoPulse{0%,100%{box-shadow:0 0 20px rgba(108,99,255,.4),0 0 0 0 rgba(46,213,115,.5)}50%{box-shadow:0 0 28px rgba(108,99,255,.7),0 0 0 8px rgba(46,213,115,0)}}
.top-name{font-size:15px;font-weight:800;color:#fff;flex:1}
.top-dot{width:8px;height:8px;border-radius:50%;background:var(--rd);flex-shrink:0}
.top-dot.on{background:var(--gr);box-shadow:0 0 8px var(--gr);animation:blink 2s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.35}}
.top-pill{font-size:10.5px;font-weight:700;padding:4px 10px;border-radius:99px;background:var(--s2);border:1px solid var(--bd);text-transform:uppercase;letter-spacing:.4px}

/* ── বটম ট্যাব ── */
.tabs{position:fixed;bottom:0;left:0;right:0;background:rgba(13,13,24,.97);backdrop-filter:blur(20px);border-top:1px solid var(--bd);display:grid;grid-template-columns:repeat(4,1fr);height:60px;z-index:200;padding-bottom:env(safe-area-inset-bottom,0px)}
.tab{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;border:none;background:transparent;color:var(--mu);transition:.15s;position:relative}
.tab.active{color:var(--ac)}
.tab .ti{font-size:21px;line-height:1}
.tab .tl{font-size:9.5px;font-weight:700}
.tab::after{content:"";position:absolute;top:0;left:50%;transform:translateX(-50%);width:0;height:2px;background:var(--ac);border-radius:0 0 3px 3px;transition:.2s}
.tab.active::after{width:36px}

.main{padding:66px 12px 76px;min-height:100vh}
.page{display:none}.page.active{display:block}
.pg-title{font-size:15px;font-weight:800;color:#fff;margin:4px 0 12px}

/* ── গ্রিটিং কার্ড (লাইভ ক্লক) ── */
.greet-card{display:flex;align-items:center;gap:14px;background:linear-gradient(135deg,rgba(108,99,255,.15),rgba(255,101,132,.1));border:1px solid var(--bd);border-radius:16px;padding:16px;margin-bottom:14px}
.greet-emoji{font-size:34px;animation:wave 2.4s ease-in-out infinite}
@keyframes wave{0%,100%{transform:rotate(0)}25%{transform:rotate(14deg)}75%{transform:rotate(-8deg)}}
.greet-text{font-size:14px;font-weight:800;color:#fff}
.greet-clock{font-size:20px;font-weight:900;color:var(--ac);font-variant-numeric:tabular-nums;margin-top:2px;letter-spacing:.5px}

/* ── স্ট্যাট কার্ড ── */
.sg{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.sc{background:linear-gradient(135deg,var(--s2),var(--s3));border:1px solid var(--bd);border-radius:14px;padding:14px}
.sc-i{font-size:22px;margin-bottom:6px}
.sc-v{font-size:18px;font-weight:900;color:#fff}
.sc-l{font-size:10px;color:var(--mu);margin-top:2px}

.bc{background:var(--s2);border:1px solid var(--bd);border-radius:16px;padding:14px;margin-bottom:14px}
.bc h3{font-size:12px;color:var(--mu);text-transform:uppercase;letter-spacing:.4px;margin-bottom:12px;font-weight:800}

/* ── আপলোড জোন ── */
.upzone{border:2px dashed var(--bd);border-radius:16px;padding:34px 16px;text-align:center;cursor:pointer;background:var(--s2);margin-bottom:12px;transition:.2s}
.upzone:active{border-color:var(--ac);background:rgba(108,99,255,.06)}
.uz-i{font-size:44px;margin-bottom:10px;animation:bounce 2s ease-in-out infinite}
@keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
.uz-t{font-size:13px;color:var(--tx);font-weight:700}
.uz-s{font-size:11px;color:var(--mu);margin-top:4px}
#zipInput{display:none}

/* ── বাটন ── */
.btn{padding:12px 8px;border-radius:12px;border:none;font-size:12.5px;font-weight:800;cursor:pointer;transition:.15s;display:flex;align-items:center;justify-content:center;gap:6px}
.btn:active{transform:scale(.96)}
.b-start{background:linear-gradient(135deg,#3ecf8e,#22d3ee);color:#000}
.b-stop{background:linear-gradient(135deg,#f05252,#fb7185);color:#fff}
.b-restart{background:linear-gradient(135deg,#f0b429,#fb923c);color:#000}
.b-install{background:linear-gradient(135deg,#38bdf8,#6c63ff);color:#fff}
.b-ghost{background:transparent;border:1px solid var(--bd);color:var(--tx)}
.bg2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.bg2.full{margin-top:8px}

/* ── ফাইল ম্যানেজার ── */
.sinput{width:100%;padding:11px 14px;border-radius:11px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:13px;outline:none;margin-bottom:10px;transition:.2s}
.sinput:focus{border-color:var(--ac)}
.folder-head{display:flex;align-items:center;gap:8px;padding:2px 2px 9px;color:var(--mu);font-size:11.5px;font-weight:800;text-transform:uppercase;letter-spacing:.5px}
.folder-head .count{background:var(--bd);color:#c9d1d9;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:700;text-transform:none;letter-spacing:0}
.flist{background:var(--s2);border:1px solid var(--bd);border-radius:14px;overflow:hidden;margin-bottom:16px}
.frow{display:flex;align-items:center;gap:10px;padding:12px;border-bottom:1px solid rgba(255,255,255,.03);cursor:pointer;transition:.12s}
.frow:last-child{border-bottom:none}
.frow:active{background:rgba(108,99,255,.08)}
.fi{font-size:18px;flex-shrink:0;width:22px;text-align:center}
.fn{flex:1;overflow:hidden}
.fn-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.fn-meta{font-size:10px;color:var(--mu);margin-top:2px}
.fa{display:flex;gap:4px;flex-shrink:0}
.fab{padding:6px 9px;border-radius:8px;border:none;background:var(--s3);color:var(--mu);font-size:11px;cursor:pointer}
.fab.del:active{background:rgba(240,82,82,.2);color:var(--rd)}
.empty-fm{padding:36px 14px;text-align:center;color:var(--mu);font-size:13px}

/* ── এডিটর ── */
.ed-top{background:var(--s2);border:1px solid var(--bd);border-radius:12px 12px 0 0;padding:10px 12px;display:flex;align-items:center;gap:8px}
.ed-fn{flex:1;font-size:12px;color:var(--ac);font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ced{width:100%;height:calc(100vh - 250px);background:#010108;border:1px solid var(--bd);border-top:none;border-radius:0 0 12px 12px;padding:14px;color:#e6edf3;font-family:'Courier New',monospace;font-size:12.5px;line-height:1.7;resize:none;outline:none;tab-size:2}

/* ── লগ (টার্মিনাল স্টাইল) ── */
.lbox{background:#020a02;border:1px solid #0f3d0f;border-radius:12px;padding:12px;height:calc(100vh - 170px);overflow-y:auto;font-family:'Courier New',monospace;font-size:11.5px;box-shadow:inset 0 0 30px rgba(0,255,0,.05)}
.le{margin-bottom:5px;white-space:pre-wrap;word-break:break-all;line-height:1.6}
.le .lt{color:#3a6b3a;font-size:10px;margin-right:6px}
.le.li{color:#4dff4d;text-shadow:0 0 3px rgba(77,255,77,.3)}
.le.lw{color:#ffd24d;text-shadow:0 0 3px rgba(255,210,77,.3)}
.le.lr{color:#ff5c5c;text-shadow:0 0 3px rgba(255,92,92,.3)}

.empty{text-align:center;color:var(--mu);padding:30px 10px;font-size:13.5px}

/* ── toast ── */
.tw{position:fixed;top:62px;right:12px;display:flex;flex-direction:column;gap:6px;z-index:999;pointer-events:none;max-width:260px}
.toast{background:var(--s3);border-radius:10px;padding:10px 14px;font-size:12px;animation:tIn .3s ease;box-shadow:0 8px 24px rgba(0,0,0,.5);pointer-events:auto;border-left:3px solid var(--bd);display:flex;align-items:center;gap:8px}
@keyframes tIn{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}
.toast.success{border-left-color:var(--gr);color:var(--gr)}
.toast.error{border-left-color:var(--rd);color:var(--rd)}
</style></head>
<body>

<div id="loginScreen">
  <div class="bg"><div class="orb o1"></div><div class="orb o2"></div><div class="orb o3"></div></div>
  <div class="card">
    <div class="logo-lg">🤖</div>
    <h1>Bot Panel</h1>
    <p class="sub">official-messenger-bot কন্ট্রোল সেন্টার</p>
    <div class="login-err" id="loginErr"></div>
    <input type="password" id="pwInput" placeholder="🔐 পাসওয়ার্ড লিখুন" autofocus>
    <button class="login-btn" onclick="doLogin()">প্রবেশ করুন →</button>
  </div>
</div>

<div id="app" style="display:none">
  <div class="top">
    <div class="top-logo" id="topLogo">🤖</div>
    <div class="top-name">Bot Panel</div>
    <span class="top-pill" id="stateBadge">...</span>
    <div class="top-dot" id="topDot"></div>
  </div>

  <div class="main">

    <div class="page active" id="pg-home">
      <div class="greet-card">
        <div class="greet-emoji" id="greetEmoji">👋</div>
        <div>
          <div class="greet-text" id="greetText">স্বাগতম</div>
          <div class="greet-clock" id="liveClock">--:--:--</div>
        </div>
      </div>
      <div class="pg-title">🏠 হোম</div>
      <div class="sg">
        <div class="sc"><div class="sc-i">🟢</div><div class="sc-v" id="hs-state">-</div><div class="sc-l">বট স্ট্যাটাস</div></div>
        <div class="sc"><div class="sc-i">⏱️</div><div class="sc-v" id="hs-uptime">-</div><div class="sc-l">প্যানেল আপটাইম</div></div>
        <div class="sc"><div class="sc-i">💾</div><div class="sc-v" id="hs-mem">-</div><div class="sc-l">মেমরি ব্যবহার</div></div>
        <div class="sc"><div class="sc-i">📦</div><div class="sc-v" id="hs-project">-</div><div class="sc-l">প্রজেক্ট আপলোড</div></div>
      </div>

      <div class="bc">
        <h3>জিপ ডিপ্লয়</h3>
        <div class="upzone" onclick="document.getElementById('zipInput').click()">
          <div class="uz-i">📦</div>
          <div class="uz-t" id="uzText">official-bot.zip আপলোড করতে ট্যাপ করুন</div>
          <div class="uz-s">পুরনো bot/ ফোল্ডার মুছে নতুনটা বসবে</div>
        </div>
        <input type="file" id="zipInput" accept=".zip" onchange="onZipPicked()">
        <button class="btn b-install" style="width:100%" onclick="uploadZip()">⬆️ আপলোড করুন</button>
      </div>

      <div class="bc">
        <h3>কন্ট্রোল</h3>
        <div class="bg2">
          <button class="btn b-install" onclick="botAction('install-start')">📦 Install+Start</button>
          <button class="btn b-start" onclick="botAction('start')">▶️ Start</button>
          <button class="btn b-stop" onclick="botAction('stop')">⏹️ Stop</button>
          <button class="btn b-restart" onclick="botAction('restart')">🔄 Restart</button>
        </div>
      </div>
    </div>

    <div class="page" id="pg-files">
      <div class="pg-title">📁 ফাইল ম্যানেজার</div>
      <div class="bc">
        <input type="text" class="sinput" id="newFilePath" placeholder="commands/mycommand.js">
        <button class="btn b-install" style="width:100%" onclick="createFile()">➕ নতুন ফাইল তৈরি করুন</button>
      </div>
      <input type="text" class="sinput" id="fileSearch" placeholder="🔍 ফাইল খুঁজুন..." oninput="loadFiles()">
      <div id="fileList"></div>
    </div>

    <div class="page" id="pg-editor">
      <div class="pg-title">✏️ এডিটর</div>
      <div class="bg2" style="margin-bottom:10px">
        <button class="btn b-ghost" onclick="closeEditor()">← ফিরে যান</button>
        <button class="btn b-install" onclick="saveFile()">💾 সেভ</button>
      </div>
      <div class="ed-top"><span class="ed-fn" id="editorPath"></span></div>
      <textarea id="editorContent" spellcheck="false"></textarea>
      <button class="btn b-stop" style="width:100%;margin-top:10px" onclick="deleteFile()">🗑️ এই ফাইল ডিলিট করুন</button>
    </div>

    <div class="page" id="pg-logs">
      <div class="pg-title">📋 লাইভ লগ</div>
      <button class="btn b-ghost" style="margin-bottom:10px" onclick="loadLogs()">🔄 রিফ্রেশ</button>
      <div class="lbox" id="logView"></div>
    </div>

    <div class="page" id="pg-more">
      <div class="pg-title">⚙️ আরো</div>
      <div class="bc">
        <h3>প্রয়োজনীয় লিংক</h3>
        <p style="font-size:12.5px;color:var(--mu);line-height:1.8">UptimeRobot মনিটর URL: <code style="color:var(--bl)">/ping</code></p>
      </div>
      <div class="bc">
        <h3>সেশন</h3>
        <button class="btn b-stop" style="width:100%" onclick="logout()">🚪 লগআউট</button>
      </div>
    </div>

  </div>

  <div class="tabs">
    <button class="tab active" data-tab="home" onclick="goTab('home',this)"><span class="ti">🏠</span><span class="tl">হোম</span></button>
    <button class="tab" data-tab="files" onclick="goTab('files',this)"><span class="ti">📁</span><span class="tl">ফাইল</span></button>
    <button class="tab" data-tab="logs" onclick="goTab('logs',this)"><span class="ti">📋</span><span class="tl">লগ</span></button>
    <button class="tab" data-tab="more" onclick="goTab('more',this)"><span class="ti">⚙️</span><span class="tl">আরো</span></button>
  </div>
</div>

<div class="tw" id="tw"></div>

<script>
let TOKEN = localStorage.getItem("panelToken") || "";
let currentFile = null;
let pickedZip = null;
let statusTimer = null;

function toast(msg,type){
  const w=document.getElementById("tw"),el=document.createElement("div");
  const icons={success:"✅",error:"❌"};
  el.className="toast "+(type||"success");
  el.innerHTML="<span>"+(icons[type]||"ℹ️")+"</span><span>"+msg+"</span>";
  w.appendChild(el);
  setTimeout(()=>{el.style.opacity="0";el.style.transition=".3s";setTimeout(()=>el.remove(),300);},3500);
}

function api(p, opts = {}) {
  opts.headers = Object.assign({ "x-panel-token": TOKEN }, opts.headers || {});
  return fetch(p, opts).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || "এরর"); return d; });
}

function doLogin(){
  TOKEN = document.getElementById("pwInput").value.trim();
  localStorage.setItem("panelToken", TOKEN);
  boot();
}
function logout(){ localStorage.removeItem("panelToken"); location.reload(); }

function updateClock() {
  const now = new Date();
  const el = document.getElementById("liveClock");
  if (el) el.textContent = now.toLocaleTimeString("bn-BD", { hour12: true });

  const h = now.getHours();
  let emoji = "👋", text = "স্বাগতম";
  if (h >= 5 && h < 12) { emoji = "☀️"; text = "শুভ সকাল"; }
  else if (h >= 12 && h < 17) { emoji = "🌤️"; text = "শুভ দুপুর"; }
  else if (h >= 17 && h < 20) { emoji = "🌇"; text = "শুভ সন্ধ্যা"; }
  else { emoji = "🌙"; text = "শুভ রাত্রি"; }
  const ge = document.getElementById("greetEmoji"), gt = document.getElementById("greetText");
  if (ge) ge.textContent = emoji;
  if (gt) gt.textContent = text;
}
setInterval(updateClock, 1000);
updateClock();

async function boot() {
  if (!TOKEN) return;
  try {
    await api("/api/status");
    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("app").style.display = "block";
    refreshBadge();
    statusTimer = setInterval(refreshBadge, 8000);
  } catch (e) {
    document.getElementById("loginScreen").style.display = "flex";
    document.getElementById("app").style.display = "none";
    const err=document.getElementById("loginErr");
    if (TOKEN) { err.textContent = "❌ ভুল পাসওয়ার্ড"; err.classList.add("show"); }
  }
}

function goTab(id, btn) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  btn.classList.add("active");
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.getElementById("pg-" + id).classList.add("active");
  if (id === "files") loadFiles();
  if (id === "logs") loadLogs();
}

async function refreshBadge() {
  try {
    const s = await api("/api/status");
    const badge = document.getElementById("stateBadge");
    badge.textContent = s.botState;
    document.getElementById("topLogo").className = "top-logo" + (s.botState === "running" ? " live" : "");
    document.getElementById("topDot").className = "top-dot" + (s.botState === "running" ? " on" : "");
    document.getElementById("hs-state").textContent = s.botState;
    document.getElementById("hs-uptime").textContent = Math.floor(s.panelUptimeSec/60) + "m";
    document.getElementById("hs-mem").textContent = s.memoryMB + " MB";
    document.getElementById("hs-project").textContent = s.hasProject ? "✅" : "❌";
  } catch (e) {}
}

function onZipPicked(){
  const f = document.getElementById("zipInput").files[0];
  if (f) document.getElementById("uzText").textContent = "✅ " + f.name;
}

async function uploadZip() {
  const f = document.getElementById("zipInput").files[0];
  if (!f) return toast("আগে একটা zip ফাইল বাছুন","error");
  const fd = new FormData(); fd.append("zip", f);
  toast("⏳ আপলোড হচ্ছে...");
  try {
    const r = await fetch("/api/upload?token=" + encodeURIComponent(TOKEN), { method: "POST", body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast(d.msg, "success");
    refreshBadge();
  } catch (e) { toast("❌ " + e.message, "error"); }
}

async function botAction(action) {
  try {
    await api("/api/bot/" + action, { method: "POST" });
    toast("✅ কমান্ড পাঠানো হয়েছে: " + action);
  } catch (e) { toast("❌ " + e.message, "error"); }
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

function fmtSize(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / 1024 / 1024).toFixed(1) + " MB";
}
function fmtAgo(ms) {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "এইমাত্র";
  if (min < 60) return min + " মিনিট আগে";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + " ঘণ্টা আগে";
  return Math.floor(hr / 24) + " দিন আগে";
}

let _lastFiles = [];
async function loadFiles() {
  const { files } = await api("/api/files");
  _lastFiles = files;
  const q = (document.getElementById("fileSearch")?.value || "").trim().toLowerCase();
  const filtered = q ? files.filter(f => f.path.toLowerCase().includes(q)) : files;

  if (!filtered.length) {
    document.getElementById("fileList").innerHTML = "<div class='empty'>" + (q ? "🔍 কিছু পাওয়া যায়নি" : "এখনো কোনো ফাইল আপলোড হয়নি") + "</div>";
    return;
  }
  const groups = {};
  for (const f of filtered) {
    const parts = f.path.split("/");
    const folder = parts.length > 1 ? parts[0] : "";
    (groups[folder] = groups[folder] || []).push(f);
  }
  const order = ["", "commands", "utils"].filter((k) => groups[k]);
  for (const k of Object.keys(groups)) if (!order.includes(k)) order.push(k);

  document.getElementById("fileList").innerHTML = order.map((folder) => {
    const list = groups[folder].sort((a, b) => a.path.localeCompare(b.path));
    const rows = list.map(f => \`
      <div class="frow" onclick="openFile('\${f.path}')">
        <span class="fi">\${fileIcon(f.path)}</span>
        <span class="fn">
          <span class="fn-name">\${f.path.split("/").pop()}</span>
          <span class="fn-meta">\${fmtSize(f.size)} · \${f.mtime ? fmtAgo(f.mtime) : ""}</span>
        </span>
        <span class="fa">
          <button class="fab" onclick="event.stopPropagation();openFile('\${f.path}')">✏️</button>
          <button class="fab" onclick="event.stopPropagation();promptRename('\${f.path}')">🔤</button>
          <button class="fab" onclick="event.stopPropagation();promptCopy('\${f.path}')">📋</button>
          <button class="fab" onclick="event.stopPropagation();downloadFile('\${f.path}')">⬇️</button>
          <button class="fab del" onclick="event.stopPropagation();quickDelete('\${f.path}')">🗑️</button>
        </span>
      </div>\`).join("");
    return \`<div class="folder-head">\${FOLDER_LABELS[folder] || folder}<span class="count">\${list.length}</span></div>
      <div class="flist">\${rows}</div>\`;
  }).join("");
}

async function promptRename(p) {
  const name = prompt("নতুন নাম দিন:", p.split("/").pop());
  if (!name || name === p.split("/").pop()) return;
  const dir = p.includes("/") ? p.split("/").slice(0, -1).join("/") : "";
  const to = dir ? dir + "/" + name : name;
  try {
    await api("/api/file/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: p, to }) });
    toast("✅ নাম পরিবর্তন হয়েছে"); loadFiles();
  } catch (e) { toast("❌ " + e.message, "error"); }
}

async function promptCopy(p) {
  const ext = p.includes(".") ? "." + p.split(".").pop() : "";
  const base = ext ? p.slice(0, -ext.length) : p;
  const to = prompt("কপি কোন নামে হবে?", base + "_copy" + ext);
  if (!to) return;
  try {
    await api("/api/file/copy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: p, to }) });
    toast("📋 কপি হয়েছে"); loadFiles();
  } catch (e) { toast("❌ " + e.message, "error"); }
}

function downloadFile(p) {
  window.open("/api/file/download?path=" + encodeURIComponent(p) + "&token=" + encodeURIComponent(TOKEN));
}

async function quickDelete(p) {
  if (!confirm("\\"" + p + "\\" ডিলিট করবেন?")) return;
  try {
    await api("/api/file?path=" + encodeURIComponent(p), { method: "DELETE" });
    toast("🗑️ ডিলিট হয়েছে"); loadFiles();
  } catch (e) { toast("❌ " + e.message, "error"); }
}

async function createFile() {
  const p = document.getElementById("newFilePath").value.trim();
  if (!p) return toast("ফাইলের পাথ দিন","error");
  const isJs = p.endsWith(".js");
  const template = isJs
    ? "\\"use strict\\";\\nmodule.exports = async function (senderId, args, { sendText }) {\\n  await sendText(senderId, 'হ্যালো! এটা একটা নতুন কমান্ড।');\\n};\\n"
    : "";
  try {
    await api("/api/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p, content: template }) });
    document.getElementById("newFilePath").value = "";
    loadFiles();
    toast("✅ ফাইল তৈরি হয়েছে");
  } catch (e) { toast("❌ " + e.message, "error"); }
}

async function openFile(p) {
  const { content } = await api("/api/file?path=" + encodeURIComponent(p));
  currentFile = p;
  document.getElementById("editorPath").textContent = p;
  document.getElementById("editorContent").value = content;
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".page").forEach(pg => pg.classList.remove("active"));
  document.getElementById("pg-editor").classList.add("active");
}

function closeEditor() {
  document.querySelectorAll(".tab")[1].classList.add("active"); // files tab
  document.querySelectorAll(".page").forEach(pg => pg.classList.remove("active"));
  document.getElementById("pg-files").classList.add("active");
  currentFile = null;
}

async function saveFile() {
  try {
    await api("/api/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: currentFile, content: document.getElementById("editorContent").value }) });
    toast("✅ সেভ হয়েছে");
  } catch (e) { toast("❌ " + e.message, "error"); }
}

async function deleteFile() {
  if (!confirm("নিশ্চিত? " + currentFile + " ডিলিট হয়ে যাবে")) return;
  try {
    await api("/api/file?path=" + encodeURIComponent(currentFile), { method: "DELETE" });
    toast("🗑️ ডিলিট হয়েছে");
    closeEditor(); loadFiles();
  } catch (e) { toast("❌ " + e.message, "error"); }
}

async function loadLogs() {
  const { lines } = await api("/api/logs");
  document.getElementById("logView").innerHTML = lines.slice().reverse().map(l => {
    const cls = l.level === "error" ? "lr" : l.level === "warn" ? "lw" : "li";
    return \`<div class="le \${cls}"><span class="lt">[\${new Date(l.t).toLocaleTimeString('bn-BD')}]</span>\${l.text}</div>\`;
  }).join("") || "<div class='empty'>কোনো লগ নেই</div>";
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
