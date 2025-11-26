/**
 * Catination Push Server — FINAL 2025 VERSION
 * Supports:
 *  • FCM Token Registration (LOCAL + PROD)
 *  • SSE Lead Listener
 *  • Push Notifications
 *  • Admin + Employee Logic
 *  • Full Console Logs
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
// PUSH NOTIFICATIONS
// ---------------------------------------------------------
async function sendPushToTokens(data, tokens) {
  if (!tokens.length) return;

  const ICON = "https://app.catination.com/catination-app-logo.png";

  const title = `🔥 New Lead — ${data.source || "Lead"}`;
  const body = `${data.name || ""} ${data.phone || ""} ${data.propertyName || ""}`;
  const leadId = String(data.leadId || "");

  const link =
    data.webLink ||
    `https://app.catination.com/dashboard/lead-management?leadId=${leadId}`;

  const msgBase = {
    notification: { title, body },

    data: {
      leadId,
      name: String(data.name || ""),
      phone: String(data.phone || ""),
      property: String(data.propertyName || ""),
    },

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
      fcmOptions: { link },
    },
  };

  const batches = chunkArray(tokens, 500);

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
      console.error("🔥 FCM Send Error:", err.message);
    }
  }
}

// ---------------------------------------------------------
// LEAD EVENT HANDLER
// ---------------------------------------------------------
async function handleLeadEvent(data) {
  console.log("\n🚀 LEAD EVENT RECEIVED:", data);

  if (!data.companyId && data.tenantId) {
    data.companyId = data.tenantId;
  }

  if (!data.companyId) {
    console.log("⚠ No companyId — skipping push");
    return;
  }

  const allTokens = await Token.find({
    companyId: String(data.companyId),
    enabled: true,
  }).lean();

  const targets = [];
  allTokens.forEach((t) => {
    if (t.role === "ADMIN") targets.push(t.token);
    if (t.role === "EMPLOYEE" && String(t.roleExperience) === "1")
      targets.push(t.token);
  });

  console.log("🎯 TARGET TOKENS:", targets.length);

  if (targets.length === 0) return;

  await sendPushToTokens(data, targets);
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

    console.log("📝 UPSERT:", payload);

    await Token.updateOne({ token }, payload, { upsert: true });

    console.log("✅ TOKEN STORED SUCCESSFULLY");

    return res.json({ success: true });
  } catch (err) {
    console.error("🔥 REGISTER ERROR:", err);
    return res.status(500).json({ error: err.message });
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
