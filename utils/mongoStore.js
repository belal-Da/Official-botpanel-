"use strict";
/**
 * mongoStore.js — bot/ ফোল্ডারের commands/utils ফাইল MongoDB-তে সিঙ্ক রাখে।
 * Render কন্টেইনার রিসেট হলেও বুট হওয়ার সময় এখান থেকে সব ফাইল ফিরিয়ে
 * আনা হয় — bot-template/-এর চেয়েও আপ-টু-ডেট (কারণ এখানে প্রতিটা সেভ/
 * ডিলিট সাথে সাথেই জমা হয়)।
 */
const { MongoClient } = require("mongodb");

let client = null;
let col = null; // collection: files  { _id: "commands/video.js", content: "...", updatedAt }

async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("⚠️ MONGODB_URI সেট করা নেই — MongoDB ছাড়াই চলবে (শুধু bot-template থেকে অটো-সিড হবে)");
    return false;
  }
  try {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    col = client.db("botpanel").collection("files");
    console.log("✅ MongoDB কানেক্ট হয়েছে");
    return true;
  } catch (e) {
    console.error("❌ MongoDB কানেক্ট ব্যর্থ:", e.message);
    client = null;
    col = null;
    return false;
  }
}

function isConnected() {
  return !!col;
}

async function saveFile(relPath, content) {
  if (!col) return;
  await col.updateOne(
    { _id: relPath },
    { $set: { content, updatedAt: new Date() } },
    { upsert: true }
  );
}

async function deleteFile(relPath) {
  if (!col) return;
  await col.deleteOne({ _id: relPath });
}

// সব ফাইল ফেরত দেয় — [{ path, content }]
async function listAll() {
  if (!col) return [];
  const docs = await col.find({}).toArray();
  return docs.map((d) => ({ path: d._id, content: d.content }));
}

async function countAll() {
  if (!col) return 0;
  return col.countDocuments();
}

module.exports = { connect, isConnected, saveFile, deleteFile, listAll, countAll };
      
