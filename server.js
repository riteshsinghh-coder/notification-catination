/**
 * server.js — Catination Push Server FINAL FIXED VERSION
 * Includes:
 * - tenantId → companyId mapping
 * - SSE reconnect
 * - Firebase Admin push
 * - MongoDB token storage
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const admin = require("firebase-admin");
const Token = require("./models/Token");

if (typeof fetch === "undefined") {
  global.fetch = require("node-fetch");
}

const app = express();
app.use(express.json({ limit: "1mb" }));

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

// -------------------------------------------
// ENVIRONMENT VARIABLES
// -------------------------------------------
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const SSE_URL = process.env.SSE_URL || "";
const FIREBASE_SERVICE_ACCOUNT_PATH =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "serviceAccountKey.json";

if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing in env");
  process.exit(1);
}

if (!SSE_URL) {
  console.error("⚠ SSE_URL not set — SSE disabled");
}

// -------------------------------------------
// FIREBASE ADMIN INITIALIZATION
// -------------------------------------------
const saPath = path.join(__dirname, FIREBASE_SERVICE_ACCOUNT_PATH);
if (!fs.existsSync(saPath)) {
  console.error("❌ Firebase service account missing:", saPath);
  process.exit(1);
}

const serviceAccount = require(saPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

console.log("✅ Firebase admin initialized");

// -------------------------------------------
// MONGODB CONNECTION
// -------------------------------------------
mongoose.set("strictQuery", false);
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => {
    console.error("❌ MongoDB error:", err);
    process.exit(1);
  });

// -------------------------------------------
// UTILITY — CHUNK ARRAY FOR FCM MULTICAST
// -------------------------------------------
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// -------------------------------------------
// SEND NOTIFICATION VIA FCM
// -------------------------------------------
async function sendPushToTokens(data, tokens) {
  if (!tokens || tokens.length === 0) return;

  const ICON = "https://app.catination.com/catination-app-logo.png";

  const title = `🔥 New Lead — ${data.source || "lead"}`;
  const body = `${data.name || ""} — ${data.phone || ""} — ${data.propertyName || ""}`;
  const leadId = String(data.leadId || "");
  const link =
    data.webLink ||
    `https://app.catination.com/dashboard/lead-management?leadId=${leadId}`;

  const baseMessage = {
    notification: { title, body },
    data: {
      leadId,
      name: String(data.name || ""),
      phone: String(data.phone || ""),
      property: String(data.propertyName || ""),
    },
    webpush: {
      headers: { Urgency: "high" },
      notification: {
        title,
        body,
        icon: ICON,
        badge: ICON,
        requireInteraction: true,
        renotify: true,
        vibrate: [200, 100, 200],
        tag: "catination_high_priority",
      },
      fcmOptions: { link },
    },
  };

  const batches = chunkArray(tokens, 500);
  for (const batch of batches) {
    const msg = { ...baseMessage, tokens: batch };

    try {
      const res = await admin.messaging().sendMulticast(msg);
      console.log(
        `📨 Sent FCM — success:${res.successCount} failed:${res.failureCount}`
      );

      // Handle invalid tokens
      res.responses.forEach((r, i) => {
        if (!r.success) {
          const code = r.error?.code;
          const bad = batch[i];

          if (
            code === "messaging/registration-token-not-registered" ||
            code === "messaging/invalid-registration-token"
          ) {
            Token.deleteOne({ token: bad }).then(() =>
              console.log("❌ Removed invalid token:", bad)
            );
          }
        }
      });
    } catch (err) {
      console.error("🔥 FCM send error:", err);
    }
  }
}

// -------------------------------------------
// HANDLE INCOMING SSE LEAD EVENT
// -------------------------------------------
async function handleLeadEvent(data) {
  try {
    console.log("🚀 Lead event:", data);

    // ---------------------------------------
    // FIX: Assign tenantId → companyId
    // ---------------------------------------
    if (data.tenantId && !data.companyId) {
      data.companyId = data.tenantId;
    }

    if (!data.companyId) {
      console.log("⚠ Lead missing companyId → ignoring");
      return;
    }

    // Fetch all tokens for that company
    const allTokens = await Token.find({
      companyId: String(data.companyId),
      enabled: true,
    }).lean();

    if (!allTokens || allTokens.length === 0) {
      console.log("⚠ No tokens for this company");
      return;
    }

    // Filter according to role rules
    const targets = [];

    for (const t of allTokens) {
      if (t.role === "EMPLOYEE") {
        if (String(t.roleExperience) === "1") {
          targets.push(t.token);
        }
      } else if (t.role === "ADMIN") {
        targets.push(t.token);
      }
    }

    if (targets.length === 0) {
      console.log("⚠ No eligible employees/admins to notify");
      return;
    }

    console.log(`📌 Push to ${targets.length} device(s)`);
    await sendPushToTokens(data, targets);
  } catch (err) {
    console.error("handleLeadEvent ERROR:", err);
  }
}

// -------------------------------------------
// SSE LISTENER
// -------------------------------------------
let sseAbortController = null;
let sseRunning = false;
let reconnectDelay = 2000;
const MAX_DELAY = 60000;

async function startSSE() {
  if (!SSE_URL) return;

  if (sseRunning) return;
  sseRunning = true;

  console.log("🔌 Connecting to SSE:", SSE_URL);

  try {
    sseAbortController = new AbortController();

    const res = await fetch(SSE_URL, {
      signal: sseAbortController.signal,
    });

    if (!res.ok) {
      console.error("❌ SSE error:", res.status, res.statusText);
      sseRunning = false;
      setTimeout(startSSE, reconnectDelay);
      reconnectDelay = Math.min(MAX_DELAY, reconnectDelay * 1.5);
      return;
    }

    console.log("🟢 SSE connected");
    reconnectDelay = 2000;

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);

        if (!raw) continue;

        const lines = raw.split("\n");
        let eventType = null;
        let dataLine = "";

        for (const l of lines) {
          if (l.startsWith("event:")) eventType = l.replace("event:", "").trim();
          if (l.startsWith("data:")) dataLine += l.replace("data:", "").trim();
        }

        if (!dataLine.startsWith("{")) continue;

        try {
          const parsed = JSON.parse(dataLine);

          if (eventType === "lead" || parsed.type === "lead") {
            await handleLeadEvent(parsed);
          }
        } catch (err) {
          console.error("❌ JSON parse error:", err);
        }
      }
    }

    console.log("⚠ SSE closed — reconnecting...");
    sseRunning = false;
    setTimeout(startSSE, reconnectDelay);
    reconnectDelay = Math.min(MAX_DELAY, reconnectDelay * 1.5);
  } catch (err) {
    console.error("❌ SSE connection error:", err);
    sseRunning = false;
    setTimeout(startSSE, reconnectDelay);
    reconnectDelay = Math.min(MAX_DELAY, reconnectDelay * 1.5);
  }
}

// Start SSE listener
startSSE();

// -------------------------------------------
// EXPRESS ROUTES
// -------------------------------------------
app.post("/register-token", async (req, res) => {
  try {
    const { token, userId, companyId, roleExperience, role, clientInfo } =
      req.body;

    if (!token) return res.status(400).json({ error: "token required" });

    await Token.updateOne(
      { token },
      {
        token,
        userId: userId ?? null,
        companyId: companyId ?? null,
        role: role ?? null,
        roleExperience: roleExperience ?? null,
        enabled: true,
        lastSeen: new Date(),
        clientInfo: clientInfo ?? null,
      },
      { upsert: true }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("register-token ERROR:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

app.post("/logout-token", async (req, res) => {
  try {
    const { token, userId } = req.body;

    if (!token && !userId)
      return res.status(400).json({ error: "token or userId required" });

    if (token) {
      await Token.updateOne(
        { token },
        { enabled: false, lastSeen: new Date() }
      );
      return res.json({ success: true });
    }

    const r = await Token.updateMany(
      { userId },
      { enabled: false, lastSeen: new Date() }
    );

    res.json({ success: true, disabled: r.modifiedCount || 0 });
  } catch (err) {
    console.error("logout-token ERROR:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

app.post("/remove-token", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });

    const r = await Token.deleteOne({ token });
    res.json({ success: true, removed: r.deletedCount || 0 });
  } catch (err) {
    console.error("remove-token ERROR:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

app.get("/tokens", async (req, res) => {
  try {
    const list = await Token.find({})
      .sort({ lastSeen: -1 })
      .limit(500)
      .lean();

    res.json({ total: list.length, tokens: list });
  } catch (err) {
    console.error("tokens ERROR:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

// -------------------------------------------
// START SERVER
// -------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Push Server running on port ${PORT}`);
});
