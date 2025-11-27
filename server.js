/**
 * server.js
 * Catination Push Server — FINAL 2025 VERSION (STRICT SINGLE-DEVICE MODE)
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const admin = require("firebase-admin");
const Token = require("./models/Token");

// Node fetch polyfill (for older Node versions)
if (typeof fetch === "undefined") {
  global.fetch = require("node-fetch");
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// -------------------- CORS --------------------
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:3000",
      "https://app.catination.com",
      "https://catination.com",
      "https://notification-catination.onrender.com",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
  })
);

// -------------------- ENV --------------------
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const SSE_URL = process.env.SSE_URL;
const FIREBASE_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!MONGO_URI) {
  console.error("❌ ERROR: MONGO_URI missing in .env");
  process.exit(1);
}
if (!FIREBASE_JSON) {
  console.error("❌ ERROR: FIREBASE_SERVICE_ACCOUNT missing in .env");
  process.exit(1);
}

// -------------------- Firebase Admin init --------------------
let serviceAccount = null;
try {
  serviceAccount = JSON.parse(FIREBASE_JSON);
} catch (err) {
  console.error("❌ FIREBASE JSON PARSE ERROR:", err);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
console.log("✅ Firebase Admin Initialized");

// -------------------- MongoDB --------------------
mongoose.set("strictQuery", false);
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err);
    process.exit(1);
  });

// -------------------- Helpers --------------------
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// dedupe recent leads to avoid repeated processing
const recentLeads = new Map();
const RECENT_LEAD_TTL = 20 * 1000; // 20s

function markLeadProcessed(leadId) {
  if (!leadId) return;
  recentLeads.set(String(leadId), Date.now());
}
function isLeadRecentlyProcessed(leadId) {
  if (!leadId) return false;
  const ts = recentLeads.get(String(leadId));
  if (!ts) return false;
  if (Date.now() - ts < RECENT_LEAD_TTL) return true;
  recentLeads.delete(String(leadId));
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of recentLeads) {
    if (now - v > RECENT_LEAD_TTL) recentLeads.delete(k);
  }
}, 30000);

// -------------------- Push sending --------------------
async function sendPushToTokens(data, tokens) {
  const normalized = Array.from(new Set((tokens || []).filter(Boolean)));
  if (!normalized.length) return;

  const ICON = "https://app.catination.com/catination-app-logo.png";
  const leadId = String(data.leadId || "");
  const leadName = String(data.name || data.leadName || "");
  const source = String(data.source || "");

  const title = `🔥 New Lead — ${source || "Lead"}`;
  const body = leadName || "New Lead";

  const msgBase = {
    notification: { title, body },
    data: { leadId, leadName, source },

    android: {
      priority: "high",
      notification: {
        title,
        body,
        icon: ICON,
        sound: "default",
        channelId: "catination_leads",
      },
    },

    apns: {
      headers: { "apns-priority": "10" },
      payload: { aps: { alert: { title, body }, sound: "default" } },
    },

    webpush: {
      headers: { Urgency: "high" },
      notification: {
        title,
        body,
        icon: ICON,
        badge: ICON,
        vibrate: [200, 100, 200],
        renotify: true,
        requireInteraction: true,
        tag: "catination_notification",
      },
    },
  };

  const batches = chunkArray(normalized, 500);
  for (const batch of batches) {
    try {
      const res = await admin.messaging().sendEachForMulticast({
        ...msgBase,
        tokens: batch,
      });

      console.log(`📨 Push sent → success:${res.successCount} failed:${res.failureCount}`);

      // remove invalid tokens
      res.responses.forEach((r, i) => {
        if (!r.success) {
          const err = r.error || {};
          const bad = batch[i];
          console.log("❌ Invalid Token:", bad, err.code);
          if (
            err.code === "messaging/invalid-registration-token" ||
            err.code === "messaging/registration-token-not-registered"
          ) {
            Token.deleteOne({ token: bad }).catch((e) => console.log("❌ Delete error:", e));
          }
        }
      });
    } catch (err) {
      console.error("🔥 FCM Send Error:", err && err.message ? err.message : err);
    }
  }
}

// -------------------- Lead handler --------------------
async function handleLeadEvent(data) {
  try {
    console.log("\n🚀 LEAD EVENT RECEIVED:", data);

    if (!data.companyId && data.tenantId) data.companyId = data.tenantId;
    if (!data.companyId) {
      console.log("⚠ No companyId — skipping push");
      return;
    }

    const leadId = data.leadId ? String(data.leadId) : null;
    if (leadId && isLeadRecentlyProcessed(leadId)) {
      console.log(`⏭ Duplicate lead event ignored (recent): ${leadId}`);
      return;
    }

    const allTokens = await Token.find({ companyId: String(data.companyId), enabled: true }).lean();

    const tokenSet = new Set();
    allTokens.forEach((t) => {
      if (!t || !t.token) return;
      if (t.role === "ADMIN") tokenSet.add(String(t.token));
      if (t.role === "EMPLOYEE" && String(t.roleExperience) === "1") tokenSet.add(String(t.token));
    });

    const targets = Array.from(tokenSet).filter(Boolean);
    console.log("🎯 TARGET TOKENS (deduped):", targets.length);
    if (targets.length === 0) {
      if (leadId) markLeadProcessed(leadId);
      return;
    }

    await sendPushToTokens(data, targets);
    if (leadId) markLeadProcessed(leadId);
  } catch (err) {
    console.error("handleLeadEvent ERROR:", err);
  }
}

// -------------------- SSE listener --------------------
let sseRunning = false;
let reconnectDelay = 2000;
const MAX_DELAY = 60000;

async function startSSE() {
  if (!SSE_URL) {
    console.log("⚠ SSE_URL missing → skipping SSE");
    return;
  }
  if (sseRunning) return;

  sseRunning = true;
  console.log("🔌 Connecting SSE:", SSE_URL);

  try {
    const res = await fetch(SSE_URL);
    if (!res.ok) throw new Error("SSE error: " + res.status);

    console.log("🟢 SSE Connected");
    reconnectDelay = 2000;

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (buffer.includes("\n\n")) {
        const idx = buffer.indexOf("\n\n");
        const eventChunk = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        if (!eventChunk) continue;

        const line = eventChunk
          .split("\n")
          .find((l) => l.startsWith("data:"))
          ?.replace("data:", "")
          .trim();

        if (!line || !line.startsWith("{")) continue;

        try {
          const json = JSON.parse(line);
          // handle lead event (non-blocking but awaited to keep order)
          await handleLeadEvent(json);
        } catch (err) {
          console.error("❌ SSE JSON Parse Error:", err);
        }
      }
    }
  } catch (err) {
    console.error("❌ SSE Connection Error:", err && err.message ? err.message : err);
  }

  console.log("⚠ SSE Closed — reconnecting soon...");
  sseRunning = false;
  reconnectDelay = Math.min(reconnectDelay * 1.4, MAX_DELAY);
  setTimeout(startSSE, reconnectDelay);
}

// start SSE if configured
startSSE();

// -------------------- API: register-token --------------------
app.post("/register-token", async (req, res) => {
  console.log("\n🔥 /register-token HIT");
  console.log("REQ BODY:", req.body || {});

  try {
    const { token, userId, companyId, role, roleExperience, clientInfo } = req.body || {};

    if (!token || !userId || !companyId) {
      console.log("❌ MISSING FIELDS:", { tokenPresent: !!token, userId, companyId });
      return res.status(400).json({ error: "Missing fields" });
    }

    // reply quickly
    res.json({ success: true });

    // background processing
    setImmediate(async () => {
      try {
        const payload = {
          token,
          userId,
          companyId,
          role: role || "",
          roleExperience: roleExperience || "0",
          enabled: true,
          clientInfo: clientInfo || {},
          lastSeen: new Date(),
        };

        console.log("📝 (BG) Upserting Token (strict single-device):", {
          userId,
          companyId,
          tokenPreview: String(token).slice(0, 12) + "...",
        });

        // delete other tokens for same user (strict single-device)
        try {
          const delRes = await Token.deleteMany({ userId, token: { $ne: token } });
          if (delRes && delRes.deletedCount) {
            console.log(`🗑 Removed ${delRes.deletedCount} old token(s) for user ${userId}`);
          }
        } catch (delErr) {
          console.warn("⚠ Could not delete old tokens for user:", delErr);
        }

        // upsert token
        await Token.updateOne({ token }, { $set: payload }, { upsert: true });
        console.log("✔ (BG) Token stored successfully (strict mode)");
      } catch (bgErr) {
        console.error("🔥 (BG) Error storing token:", bgErr);
      }
    });
  } catch (err) {
    console.error("🔥 REGISTER ERROR (OUTER):", err);
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message });
    }
  }
});

// -------------------- API: logout-token --------------------
app.post("/logout-token", async (req, res) => {
  const { userId, token } = req.body || {};
  try {
    if (token) await Token.updateOne({ token }, { enabled: false });
    if (userId) await Token.updateMany({ userId }, { enabled: false });
  } catch (err) {
    console.error("🔥 LOGOUT TOKEN ERROR:", err);
  }
  res.json({ success: true });
});

// -------------------- health --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// -------------------- start --------------------
app.listen(PORT, () => console.log(`🚀 Catination Push Server running on PORT ${PORT}`));
