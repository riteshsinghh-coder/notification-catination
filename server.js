/**
 * server.js
 * Complete push server with MongoDB + Firebase Admin + SSE listener
 *
 * Endpoints:
 * POST /register-token     { token, userId, companyId, roleExperience, role, clientInfo }
 * POST /logout-token       { token } OR { userId }  (disables tokens)
 * POST /remove-token       { token } (deletes token record)
 * GET  /tokens             (debug list)
 * GET  /health
 *
 * SSE: starts and reconnects automatically to SSE_URL
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
  try {
    global.fetch = require("node-fetch");
  } catch (err) {
    console.error("fetch is not available. Use Node 18+ or install node-fetch.");
    process.exit(1);
  }
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

// ---------- Config from .env ----------
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const SSE_URL = process.env.SSE_URL || ""; // set your SSE URL in .env
const FIREBASE_SERVICE_ACCOUNT_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "serviceAccountKey.json";

if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing in env");
  process.exit(1);
}

if (!SSE_URL) {
  console.error("⚠ SSE_URL not set — server will run but SSE will be skipped (useful for local testing)");
}

// ---------- Initialize Firebase Admin ----------
const saPath = path.join(__dirname, FIREBASE_SERVICE_ACCOUNT_PATH);
if (!fs.existsSync(saPath)) {
  console.error(`❌ Firebase service account not found at ${saPath}`);
  console.error("Place your serviceAccountKey.json at project root or set FIREBASE_SERVICE_ACCOUNT_PATH");
  process.exit(1);
}

const serviceAccount = require(saPath);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
console.log("✅ Firebase admin initialized");

// ---------- Connect to MongoDB ----------
mongoose.set("strictQuery", false);
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => {
    console.error("❌ MongoDB connect error:", err);
    process.exit(1);
  });

// ---------- Helper: chunk array ----------
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------- SEND PUSH ----------
async function sendPushToTokens(data, tokens) {
  if (!tokens || tokens.length === 0) return;

  const ICON = "https://app.catination.com/catination-app-logo.png";
  const title = `🔥 New Lead — ${data.source || "lead"}`;
  const body = `${data.name || "Unknown"} — ${data.phone || ""} — ${data.propertyName || ""}`;
  const leadId = String(data.leadId || "");
  const link = (data.webLink) || `https://app.catination.com/dashboard/lead-management?leadId=${leadId}`;

  const baseMessage = {
    notification: { title, body },
    data: {
      leadId,
      name: String(data.name || ""),
      phone: String(data.phone || ""),
      property: String(data.propertyName || "")
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
        tag: "catination_high_priority"
      },
      fcmOptions: { link }
    }
  };

  const batches = chunkArray(tokens, 500);
  for (const batch of batches) {
    const msg = { ...baseMessage, tokens: batch };
    try {
      const res = await admin.messaging().sendMulticast(msg);
      console.log(`📨 Sent push — success:${res.successCount} failed:${res.failureCount}`);

      // cleanup invalid tokens returned by FCM
      res.responses.forEach((r, i) => {
        if (!r.success) {
          const errCode = r.error?.code;
          const badToken = batch[i];
          if (
            errCode === "messaging/registration-token-not-registered" ||
            errCode === "messaging/invalid-registration-token"
          ) {
            Token.deleteOne({ token: badToken })
              .then(() => console.log("❌ Removed invalid token:", badToken))
              .catch((e) => console.error("Error removing token:", e));
          } else {
            console.log("⚠ FCM error for token:", batch[i], r.error?.message || r.error);
          }
        }
      });
    } catch (err) {
      console.error("🔥 FCM send error:", err);
    }
  }
}

// ---------- HANDLE LEAD EVENT ----------
async function handleLeadEvent(data) {
  try {
    console.log("🚀 Lead event:", data);
    if (!data || !data.companyId) {
      console.log("⚠ Lead missing companyId → ignoring");
      return;
    }

    // Get ALL tokens for this company that are enabled
    const allTokens = await Token.find({
      companyId: String(data.companyId),
      enabled: true
    }).lean();

    if (!allTokens || allTokens.length === 0) {
      console.log("⚠ No tokens for this company");
      return;
    }

    // Filter tokens according to role & roleExperience rules:
    // - If role === "EMPLOYEE": only if roleExperience === "1"
    // - If role === "ADMIN": always include (admin logic placeholder)
    const targets = [];

    for (const t of allTokens) {
      if (!t.role) {
        // if role missing, skip (or decide default behavior)
        continue;
      }

      if (t.role === "EMPLOYEE") {
        if (String(t.roleExperience) === "1") {
          targets.push(t.token);
        }
      } else if (t.role === "ADMIN") {
        // ADMIN receives notifications regardless of roleExperience.
        // (You asked to keep admin part empty — future admin filters can be added here)
        targets.push(t.token);
      } else {
        // other roles: skip by default (or add behavior if needed)
      }
    }

    if (targets.length === 0) {
      console.log("⚠ No eligible employees/admins to notify");
      return;
    }

    console.log(`📌 Sending notification to ${targets.length} target(s)`);
    await sendPushToTokens(data, targets);

  } catch (err) {
    console.error("handleLeadEvent ERROR:", err);
  }
}

// ---------- SSE Listener ----------
let sseAbortController = null;
let sseRunning = false;
let reconnectDelay = 2000;
const MAX_DELAY = 60000;

async function startSSE() {
  if (!SSE_URL) {
    console.log("SSE_URL not configured — startSSE skipped");
    return;
  }
  if (sseRunning) return;
  sseRunning = true;
  console.log("🔌 Connecting to SSE:", SSE_URL);

  try {
    sseAbortController = new AbortController();
    const res = await fetch(SSE_URL, { signal: sseAbortController.signal });

    if (!res.ok) {
      console.error("❌ SSE response not ok:", res.status, res.statusText);
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

        const lines = raw.split("\n").map(l => l.trim());
        let eventType = null;
        let dataLine = "";

        for (const line of lines) {
          if (line.startsWith("event:")) eventType = line.replace("event:", "").trim();
          if (line.startsWith("data:")) dataLine += line.replace("data:", "").trim();
        }

        if (!dataLine) continue;
        if (!dataLine.trim().startsWith("{")) {
          console.log("ℹ Ignored SSE non-JSON/data:", dataLine);
          continue;
        }

        try {
          const parsed = JSON.parse(dataLine);
          if (eventType === "lead" || parsed.type === "lead") {
            await handleLeadEvent(parsed);
          } else {
            console.log("ℹ SSE event ignored:", eventType || parsed.type);
          }
        } catch (err) {
          console.error("❌ SSE JSON parse error:", err, "raw:", dataLine);
        }
      }
    }

    console.log("⚠ SSE closed — reconnecting");
    sseRunning = false;
    setTimeout(startSSE, reconnectDelay);
    reconnectDelay = Math.min(MAX_DELAY, reconnectDelay * 1.5);
  } catch (err) {
    console.error("❌ SSE connection error:", err?.message || err);
    sseRunning = false;
    setTimeout(startSSE, reconnectDelay);
    reconnectDelay = Math.min(MAX_DELAY, reconnectDelay * 1.5);
  }
}

// Start SSE in background
startSSE().catch((e) => console.error("startSSE failed:", e));

// ---------- Express API routes ----------

// Register or upsert token
app.post("/register-token", async (req, res) => {
  try {
    const { token, userId, companyId, roleExperience, role, clientInfo } = req.body;
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
        clientInfo: clientInfo ?? null
      },
      { upsert: true }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("register-token ERROR:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

// Logout: disable token or disable all tokens for userId
app.post("/logout-token", async (req, res) => {
  try {
    const { token, userId } = req.body;
    if (!token && !userId) return res.status(400).json({ error: "token or userId required" });

    if (token) {
      await Token.updateOne({ token }, { enabled: false, lastSeen: new Date() });
      return res.json({ success: true, disabled: 1 });
    }

    const r = await Token.updateMany({ userId }, { enabled: false, lastSeen: new Date() });
    return res.json({ success: true, disabled: r.modifiedCount ?? r.nModified ?? 0 });
  } catch (err) {
    console.error("logout-token ERROR:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

// Remove token permanently
app.post("/remove-token", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });
    const r = await Token.deleteOne({ token });
    return res.json({ success: true, removed: r.deletedCount ?? 0 });
  } catch (err) {
    console.error("remove-token ERROR:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

// Debug: list tokens
app.get("/tokens", async (req, res) => {
  try {
    const list = await Token.find({}).sort({ lastSeen: -1 }).limit(500).lean();
    return res.json({ tokens: list, total: list.length });
  } catch (err) {
    console.error("tokens ERROR:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

// Graceful shutdown
function shutdown() {
  console.log("🔴 Shutting down...");
  if (sseAbortController) sseAbortController.abort();
  mongoose.connection.close(false, () => {
    console.log("Mongo connection closed");
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Push Server running on port ${PORT}`);
});
