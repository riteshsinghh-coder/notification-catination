/**
 * server.js — Catination Push Server (FINAL & FULLY FIXED)
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const admin = require("firebase-admin");
const Token = require("./models/Token");

// node-fetch polyfill for older node versions where fetch isn't present
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

// ---------------------------------------------------------
// ENV CONFIG
// ---------------------------------------------------------
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const SSE_URL = process.env.SSE_URL || "";
const FIREBASE_SERVICE_ACCOUNT_PATH =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "serviceAccountKey.json";

if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing from .env");
  process.exit(1);
}

// ---------------------------------------------------------
// FIREBASE ADMIN INIT
// ---------------------------------------------------------
const saPath = path.join(__dirname, FIREBASE_SERVICE_ACCOUNT_PATH);
if (!fs.existsSync(saPath)) {
  console.error("❌ Firebase service account file missing:", saPath);
  process.exit(1);
}

const serviceAccount = require(saPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
console.log("✅ Firebase admin initialized");

// ---------------------------------------------------------
// MONGO INIT
// ---------------------------------------------------------
mongoose.set("strictQuery", false);

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => {
    console.error("❌ MongoDB error:", err);
    process.exit(1);
  });

// ---------------------------------------------------------
// HELPERS
// ---------------------------------------------------------
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// ---------------------------------------------------------
// SEND PUSH TO TOKENS  (Admin SDK v12+)
// ---------------------------------------------------------
async function sendPushToTokens(data, tokens) {
  if (!tokens || !tokens.length) return;

  const ICON = "https://app.catination.com/catination-app-logo.png";

  const title = `🔥 New Lead — ${data.source || "Lead"}`;
  const body = `${data.name || ""} — ${data.phone || ""} — ${data.propertyName || ""}`;
  const leadId = String(data.leadId || "");

  const link =
    data.webLink ||
    `https://app.catination.com/dashboard/lead-management?leadId=${leadId}`;

  // --------------- FINAL FIXED MESSAGE ---------------
  const baseMsg = {
    // Top-level notification ensures mobile platforms show system notifications
    notification: {
      title,
      body,
    },

    // Data for your service worker / deep linking
    data: {
      leadId,
      name: String(data.name || ""),
      phone: String(data.phone || ""),
      property: String(data.propertyName || ""),
    },

    // Android-specific options (heads-up, channel, sound)
    android: {
      priority: "high",
      notification: {
        title,
        body,
        channelId: "catination_leads",
        sound: "default",
        icon: ICON,
        // click_action is sometimes used by some clients; keep generic click action
        clickAction: "FLUTTER_NOTIFICATION_CLICK",
        notificationCount: 1,
      },
    },

    // iOS / APNs options
    apns: {
      headers: {
        "apns-priority": "10",
      },
      payload: {
        aps: {
          alert: {
            title,
            body,
          },
          sound: "default",
          // content-available:1 can be used for silent notifications if needed
        },
      },
    },

    // Web push (PWA / Chrome) — your service worker will handle click and extras
    webpush: {
      headers: { Urgency: "high" },
      notification: {
        title,
        body,
        icon: ICON,
        badge: ICON,
        vibrate: [200, 100, 200],
        requireInteraction: true,
        renotify: true,
        tag: "catination_notification",
      },
      fcmOptions: {
        link,
      },
    },
  };
  // ---------------------------------------------------

  const batches = chunkArray(tokens, 500);

  for (const batch of batches) {
    const msg = { ...baseMsg, tokens: batch };

    try {
      // Admin SDK v12+: sendEachForMulticast accepts tokens + platform options
      const res = await admin.messaging().sendEachForMulticast(msg);

      console.log(
        `📨 Push sent → success:${res.successCount} failed:${res.failureCount}`
      );

      // detailed logging and cleanup for failed tokens
      res.responses.forEach((r, i) => {
        if (!r.success) {
          const err = r.error || {};
          const failedToken = batch[i];

          console.error("❌ FCM ERROR FOR TOKEN:", failedToken);
          console.error("   → code:", err.code || "N/A");
          console.error("   → message:", err.message || "N/A");
          if (err.details) console.error("   → details:", err.details);
          if (err.info) console.error("   → info:", err.info);

          if (
            err.code === "messaging/registration-token-not-registered" ||
            err.code === "messaging/invalid-registration-token"
          ) {
            Token.deleteOne({ token: failedToken })
              .then(() => console.log("❌ Removed invalid token:", failedToken))
              .catch((err) => console.error("Token removal error:", err));
          }
        }
      });
    } catch (err) {
      // If admin.messaging throws, log entire error for debugging
      console.error("🔥 FCM sendEachForMulticast ERROR:", err);
    }
  }
}

// ---------------------------------------------------------
// HANDLE LEAD EVENT
// ---------------------------------------------------------
async function handleLeadEvent(data) {
  try {
    console.log("🚀 Lead event received:", data);

    // map tenantId → companyId
    if (!data.companyId && data.tenantId) {
      data.companyId = data.tenantId;
      console.log("🔄 tenantId → companyId mapped:", data.companyId);
    }

    if (!data.companyId) {
      console.log("⚠ Lead missing companyId — ignored");
      return;
    }

    const allTokens = await Token.find({
      companyId: String(data.companyId),
      enabled: true,
    }).lean();

    if (!allTokens.length) {
      console.log("⚠ No tokens found for company:", data.companyId);
      return;
    }

    const targets = [];

    for (const t of allTokens) {
      if (t.role === "EMPLOYEE" && String(t.roleExperience) === "1") {
        targets.push(t.token);
      }
      if (t.role === "ADMIN") {
        targets.push(t.token);
      }
    }

    if (!targets.length) {
      console.log("⚠ No eligible notification receivers");
      return;
    }

    console.log(`📌 Final targets: ${targets.length}`);
    await sendPushToTokens(data, targets);
  } catch (err) {
    console.error("❌ handleLeadEvent ERROR:", err);
  }
}

// ---------------------------------------------------------
// SSE LISTENER
// ---------------------------------------------------------
let sseRunning = false;
let reconnectDelay = 2000;
const MAX_DELAY = 60000;

async function startSSE() {
  if (!SSE_URL) return;
  if (sseRunning) return;

  console.log("🔌 Connecting to SSE:", SSE_URL);
  sseRunning = true;

  try {
    const res = await fetch(SSE_URL);

    if (!res.ok) {
      console.error("❌ SSE failed:", res.status);
      sseRunning = false;
      return setTimeout(startSSE, reconnectDelay);
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

      while (buffer.includes("\n\n")) {
        const idx = buffer.indexOf("\n\n");
        const raw = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);

        if (!raw) continue;

        // find the first data: line (handle multi-line SSE safely)
        const dataLines = raw
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("data:"));

        if (!dataLines.length) {
          console.log("ℹ Ignored non-data SSE chunk:", raw);
          continue;
        }

        // Join multiple data lines into one JSON string (SSE allows splitting)
        let dataLine = dataLines.map((l) => l.replace(/^data:\s?/, "")).join("");

        if (!dataLine.startsWith("{")) {
          console.log("ℹ Ignored non-JSON SSE:", dataLine);
          continue;
        }

        try {
          const parsed = JSON.parse(dataLine);
          await handleLeadEvent(parsed);
        } catch (err) {
          console.error("❌ SSE parse error:", err, dataLine);
        }
      }
    }
  } catch (err) {
    console.error("❌ SSE connection error:", err);
  }

  console.log("⚠ SSE closed — reconnecting…");
  sseRunning = false;

  reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_DELAY);
  setTimeout(startSSE, reconnectDelay);
}

startSSE();

// ---------------------------------------------------------
// EXPRESS ROUTES
// ---------------------------------------------------------
// REGISTER TOKEN
// ---------------------------------------------------------
app.post("/register-token", async (req, res) => {
  try {
    console.log("📩 Incoming /register-token:", req.body);

    const { token, userId, companyId, role, roleExperience, clientInfo } =
      req.body || {};

    if (!token) return res.status(400).json({ error: "token required" });
    if (!userId) return res.status(400).json({ error: "userId required" });
    if (!companyId) return res.status(400).json({ error: "companyId required" });

    await Token.updateOne(
      { token },
      {
        token,
        userId,
        companyId,
        role: role || "",
        roleExperience: roleExperience || "0",
        enabled: true,
        clientInfo: clientInfo || null,
        lastSeen: new Date(),
      },
      { upsert: true }
    );

    console.log("✅ Token saved for:", userId);
    return res.json({ success: true });
  } catch (err) {
    console.error("register-token ERROR:", err);
    return res.status(500).json({ error: "internal_error", details: err.message });
  }
});

// LOGOUT TOKEN
app.post("/logout-token", async (req, res) => {
  try {
    const { token, userId } = req.body || {};

    if (token) {
      await Token.updateOne({ token }, { enabled: false });
    } else if (userId) {
      await Token.updateMany({ userId }, { enabled: false });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("logout-token ERROR:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// REMOVE TOKEN
app.post("/remove-token", async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "token required" });

    const r = await Token.deleteOne({ token });
    res.json({ success: true, removed: r.deletedCount });
  } catch (err) {
    console.error("remove-token ERROR:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

app.get("/tokens", async (req, res) => {
  try {
    const list = await Token.find({}).sort({ lastSeen: -1 }).limit(200);
    res.json({ total: list.length, tokens: list });
  } catch (err) {
    console.error("tokens ERROR:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------
// START SERVER
// ---------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Push Server running on port ${PORT}`);
});
