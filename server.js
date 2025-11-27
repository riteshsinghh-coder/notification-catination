/**
 * Catination Push Server — FINAL 2025 VERSION (PATCHED)
 * - Original behavior preserved
 * - Added deduplication for:
 *    • duplicate DB tokens
 *    • duplicate SSE events for same leadId (short TTL)
 * - Defensive token normalization before sending to FCM
 * - Logging improved
 *
 * NOTE:
 * - This file is the corrected FULL server.js requested (option A)
 * - No inventory routes included (per your choice)
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const admin = require("firebase-admin");
const Token = require("./models/Token");

// Node 18+ fetch fix
if (typeof fetch === "undefined") {
  global.fetch = require("node-fetch");
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------------------------------------------------------
// CORS CONFIG (Supports Local + Production)
// ---------------------------------------------------------
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

// ---------------------------------------------------------
// ENV VALIDATION
// ---------------------------------------------------------
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

// ---------------------------------------------------------
// FIREBASE ADMIN INITIALIZATION
// ---------------------------------------------------------
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

// ---------------------------------------------------------
// MONGO CONNECTION
// ---------------------------------------------------------
mongoose.set("strictQuery", false);

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err);
    process.exit(1);
  });

// ---------------------------------------------------------
// Utility: Chunk tokens
// ---------------------------------------------------------
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// ---------------------------------------------------------
// DEDUPLICATION HELPERS (new)
//  - recentLeads: short TTL cache for leadId -> prevents processing same lead repeatedly
//  - normalizes tokens to unique list before sending to FCM
// ---------------------------------------------------------
const recentLeads = new Map(); // leadId -> timestamp(ms)
const RECENT_LEAD_TTL = 20 * 1000; // 20 seconds (tune if needed)

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

// periodic cleanup to avoid memory growth
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of recentLeads) {
    if (now - v > RECENT_LEAD_TTL) recentLeads.delete(k);
  }
}, 30000);

// ---------------------------------------------------------
// PUSH NOTIFICATIONS (patched)
//  - removes falsy tokens, dedupes tokens
//  - sends ONLY leadId, leadName, source in data
// ---------------------------------------------------------
async function sendPushToTokens(data, tokens) {
  // Defensive normalization: remove falsy tokens and dedupe
  const normalized = Array.from(new Set((tokens || []).filter(Boolean)));
  if (!normalized.length) return;

  const ICON = "https://app.catination.com/catination-app-logo.png";

  // Build only the required fields
  const leadId = String(data.leadId || "");
  const leadName = String(data.name || "");
  const source = String(data.source || "");

  // Visible notification text per your request:
  const title = `🔥 New Lead — ${source || "Lead"}`;
  const body = leadName || "New Lead";

  const msgBase = {
    notification: { title, body },

    // << ONLY THESE THREE FIELDS IN data >>
    data: {
      leadId,
      leadName,
      source,
    },

    android: {
      priority: "high",
      notification: {
        title,
        body,
        icon: ICON,
        sound: "default", // Android respects channel sound too; client must create channel properly
        channelId: "catination_leads",
      },
    },

    apns: {
      headers: { "apns-priority": "10" },
      payload: {
        aps: {
          alert: { title, body },
          sound: "default",
        },
      },
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
      // intentionally no fcmOptions.link included
    },
  };

  const batches = chunkArray(normalized, 500);

  for (const batch of batches) {
    try {
      const res = await admin.messaging().sendEachForMulticast({
        ...msgBase,
        tokens: batch,
      });

      console.log(
        `📨 Push sent → success:${res.successCount} failed:${res.failureCount}`
      );

      // Cleanup invalid tokens
      res.responses.forEach((r, i) => {
        if (!r.success) {
          const err = r.error || {};
          const bad = batch[i];

          console.log("❌ Invalid Token:", bad, err.code);

          if (
            err.code === "messaging/invalid-registration-token" ||
            err.code === "messaging/registration-token-not-registered"
          ) {
            Token.deleteOne({ token: bad })
              .then(() => console.log("🗑 Token deleted:", bad))
              .catch((e) => console.log("❌ Delete error:", e));
          }
        }
      });
    } catch (err) {
      console.error("🔥 FCM Send Error:", err && err.message ? err.message : err);
    }
  }
}

// ---------------------------------------------------------
// LEAD EVENT HANDLER (patched)
//  - dedupe by leadId (recentLeads)
//  - dedupe tokens from DB
// ---------------------------------------------------------
async function handleLeadEvent(data) {
  try {
    console.log("\n🚀 LEAD EVENT RECEIVED:", data);

    if (!data.companyId && data.tenantId) {
      data.companyId = data.tenantId;
    }

    if (!data.companyId) {
      console.log("⚠ No companyId — skipping push");
      return;
    }

    const leadId = data.leadId ? String(data.leadId) : null;
    if (leadId && isLeadRecentlyProcessed(leadId)) {
      console.log(`⏭ Duplicate lead event ignored (recent): ${leadId}`);
      return;
    }

    // Fetch tokens for the company
    const allTokens = await Token.find({
      companyId: String(data.companyId),
      enabled: true,
    }).lean();

    // Build unique token set (dedupe identical tokens)
    const tokenSet = new Set();

    allTokens.forEach((t) => {
      if (!t || !t.token) return;
      // keep same logic for target selection
      if (t.role === "ADMIN") tokenSet.add(String(t.token));
      if (t.role === "EMPLOYEE" && String(t.roleExperience) === "1")
        tokenSet.add(String(t.token));
    });

    const targets = Array.from(tokenSet).filter(Boolean);

    console.log("🎯 TARGET TOKENS (deduped):", targets.length);

    if (targets.length === 0) {
      if (leadId) markLeadProcessed(leadId);
      return;
    }

    await sendPushToTokens(data, targets);

    // Mark processed to avoid immediate duplicate handling
    if (leadId) markLeadProcessed(leadId);
  } catch (err) {
    console.error("handleLeadEvent ERROR:", err);
  }
}

// ---------------------------------------------------------
// SSE LISTENER
// ---------------------------------------------------------
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
          await handleLeadEvent(json);
        } catch (err) {
          console.error("❌ SSE JSON Parse Error:", err);
        }
      }
    }
  } catch (err) {
    console.error("❌ SSE Connection Error:", err.message);
  }

  console.log("⚠ SSE Closed — reconnecting soon...");
  sseRunning = false;

  reconnectDelay = Math.min(reconnectDelay * 1.4, MAX_DELAY);
  setTimeout(startSSE, reconnectDelay);
}

// Start SSE on boot
startSSE();

// ---------------------------------------------------------
// REGISTER TOKEN (Matches frontend firebase.js)
// ---------------------------------------------------------
// ---------------------------------------------------------
// 🚀 SUPER-OPTIMIZED REGISTER TOKEN (FAST RESPONSE + ASYNC WRITE)
// ---------------------------------------------------------
app.post("/register-token", async (req, res) => {
  console.log("\n🔥 /register-token HIT");
  console.log("REQ BODY:", req.body);

  try {
    const { token, userId, companyId, role, roleExperience, clientInfo } =
      req.body;

    if (!token || !userId || !companyId) {
      console.log("❌ MISSING FIELDS:", { token, userId, companyId });
      return res.status(400).json({ error: "Missing fields" });
    }

    // ⭐ Respond IMMEDIATELY (NON-BLOCKING)
    // This fixes all login delay & Render queue spikes
    res.json({ success: true });

    // 🧵 Background processing (NON-BLOCKING)
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

        console.log("📝 (BG) Upserting Token:", payload);

        await Token.updateOne({ token }, payload, { upsert: true });

        console.log("✔ (BG) Token stored successfully");
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


// ---------------------------------------------------------
// LOGOUT TOKEN
// ---------------------------------------------------------
app.post("/logout-token", async (req, res) => {
  const { userId, token } = req.body;

  if (token) await Token.updateOne({ token }, { enabled: false });
  if (userId) await Token.updateMany({ userId }, { enabled: false });

  res.json({ success: true });
});

// ---------------------------------------------------------
// HEALTH CHECK
// ---------------------------------------------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------
// START SERVER
// ---------------------------------------------------------
app.listen(PORT, () =>
  console.log(`🚀 Catination Push Server running on PORT ${PORT}`)
);
