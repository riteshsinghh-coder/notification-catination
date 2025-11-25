// =======================
//  SERVER.JS — FINAL PRO (Zomato Popup Optimized)
// =======================

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// ---------------- CHECK FETCH API ----------------
if (typeof fetch === "undefined") {
  console.error("❌ Node does NOT support fetch. Use Node 18+ or 20+");
  process.exit(1);
}

const app = express();

// --------- CORS (adjust origins as needed) ----------
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://app.catination.com",
  "https://catination.com",
  "https://notification-catination.onrender.com"
];
app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (like curl, server-to-server)
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
        return callback(null, true);
      } else {
        return callback(new Error("CORS policy: Origin not allowed"));
      }
    },
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
  })
);

app.use(express.json());

// ---------------- FIREBASE CREDENTIALS ----------------
const serviceAccountPath = path.join(__dirname, "serviceAccountKey.json");

if (!fs.existsSync(serviceAccountPath)) {
  console.error("❌ serviceAccountKey.json missing");
  process.exit(1);
}

const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ---------------- TOKEN STORE ----------------
// Use a Set for in-memory demo. In production persist tokens to DB.
let tokens = new Set();

// Register token
app.post("/register-token", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token required" });

  tokens.add(token);
  console.log("✅ Token registered:", token);
  console.log("👉 Total tokens:", tokens.size);

  res.json({ success: true });
});

// Remove token (logout)
app.post("/remove-token", (req, res) => {
  const { token } = req.body;
  if (token) {
    tokens.delete(token);
    console.log("❌ Token removed:", token);
  }
  res.json({ success: true });
});

// List tokens (debug)
app.get("/tokens", (req, res) => {
  res.json({ tokens: Array.from(tokens) });
});

// ---------------- ROOT CHECK URL ----------------
app.get("/", (req, res) => {
  res.send("Hi there, I am active! 🚀");
});

// ---------------- SSE STREAM URL ----------------
// (Keep your SSE URL here — this server will connect and forward leads to FCM)
const SSE_URL =
  "https://api.catination.com/service/notifications/stream?tenantId=29ABCDE1234F2Z5&streamKey=HelloAryan";

let reconnectDelay = 2000;
const MAX_DELAY = 60000;

// =====================================
//  SEND HIGH PRIORITY (ZOMATO STYLE) PUSH
// =====================================
async function handleLeadEvent(data) {
  const leadName = data?.name || "New Lead";
  const phone = data?.phone || "N/A";
  const property = data?.propertyName || "Property";
  const leadId = String(data?.leadId || "");
  const source = data?.source || "Source";

  const tokensArr = Array.from(tokens);
  if (tokensArr.length === 0) {
    console.log("⚠ No tokens to notify.");
    return;
  }

  // NOTE: Use absolute URLs for icons/badges. Relative paths often break in PWA context.
  const ICON_URL = "https://app.catination.com/catination-app-logo.png";
  const BADGE_URL = "https://app.catination.com/catination-app-logo.png";

  const title = `🔥 New Hot Lead (${source})`;
  const body = `${leadName} — ${phone} — ${property}`;

  // Build message payload — webpush + android + data
  const message = {
    notification: {
      // Top-level notification is optional for web; kept for completeness
      title,
      body
    },

    data: {
      leadId,
      name: leadName,
      phone,
      property
    },

    // ANDROID: high priority, sound, channel id (channel must be created by system — SW triggers)
    android: {
      priority: "high",
      notification: {
        channelId: "catination_high_priority",
        sound: "default",
        // vibrateTimingsMillis expects array of numbers (ms)
        vibrateTimingsMillis: [200, 100, 200, 100, 200],
        // imageUrl is supported on Android native clients
        imageUrl: "https://catination.com/assets/lead-banner.png",
        // set priority for Android notification
        priority: "HIGH"
      }
    },

    // WEBPUSH: critical for browser push behaviour. Urgency must be "high".
    webpush: {
      headers: {
        Urgency: "high"
      },
      notification: {
        title,
        body,
        icon: ICON_URL,
        badge: BADGE_URL,
        requireInteraction: true,
        vibrate: [200, 100, 200, 100, 200],
        renotify: true,
        // NOTE: Chrome does not play custom sound from webpush; 'sound' helps FCM treat it high-priority
        sound: "default",
        tag: "catination-hot-lead"
      },
      fcmOptions: {
        // absolute link — relative may not work when opened from notification
        link: `https://app.catination.com/dashboard/lead-management?leadId=${leadId}`
      }
    },

    // tokens to send to
    tokens: tokensArr
  };

  try {
    // sendEachForMulticast expects message with 'tokens' property (array)
    const result = await admin.messaging().sendEachForMulticast(message);

    console.log(
      `📨 Push sent → Success: ${result.successCount}, Failed: ${result.failureCount}`
    );

    // Remove invalid tokens reported by FCM
    result.responses.forEach((r, i) => {
      if (!r.success) {
        const t = tokensArr[i];
        console.log("❌ Removing invalid token:", t, "error:", r.error?.code || r.error);
        tokens.delete(t);
      }
    });
  } catch (err) {
    console.error("🔥 FCM ERROR:", err);
  }
}

// =======================
//  CONNECT TO SSE STREAM
// =======================
async function startSSE() {
  console.log("🔌 Connecting to SSE:", SSE_URL);

  try {
    const res = await fetch(SSE_URL);

    if (!res.ok) {
      console.log("❌ SSE Error:", res.status, res.statusText);
      setTimeout(startSSE, reconnectDelay);
      reconnectDelay = Math.min(MAX_DELAY, reconnectDelay * 1.5);
      return;
    }

    console.log("🟢 SSE Connected");
    reconnectDelay = 2000;

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        console.log("⚠ SSE Disconnected. Reconnecting...");
        setTimeout(startSSE, reconnectDelay);
        reconnectDelay = Math.min(MAX_DELAY, reconnectDelay * 1.5);
        break;
      }

      buffer += decoder.decode(value);
      const events = buffer.split("\n\n");
      buffer = events.pop();

      for (const ev of events) {
        const lines = ev.split("\n").map((l) => l.trim());

        let type = null;
        let dataLine = null;

        for (const line of lines) {
          if (line.startsWith("event:")) type = line.replace("event:", "").trim();
          if (line.startsWith("data:")) dataLine = line.replace("data:", "").trim();
        }

        if (!dataLine || !dataLine.startsWith("{")) continue;

        try {
          const json = JSON.parse(dataLine);

          console.log("📩 SSE EVENT:", type, json);

          if (type === "lead") {
            console.log("🚀 LEAD RECEIVED FROM SSE");
            await handleLeadEvent(json);
          }
        } catch (e) {
          console.log("❌ Invalid JSON from SSE:", dataLine);
        }
      }
    }
  } catch (err) {
    console.error("❌ SSE Connection Error:", err);
    setTimeout(startSSE, reconnectDelay);
    reconnectDelay = Math.min(MAX_DELAY, reconnectDelay * 1.5);
  }
}

// Start SSE listener
startSSE();

// -------------------
// Test route (manual)
// -------------------
// Call http://localhost:3000/test to send a test push (useful for debugging)
app.get("/test", async (req, res) => {
  try {
    await handleLeadEvent({
      name: "Test Lead",
      phone: "9999999999",
      propertyName: "Demo Property",
      leadId: "TEST123",
      source: "ManualTest"
    });
    return res.send("Test notification sent (check devices).");
  } catch (err) {
    console.error("Test send error:", err);
    return res.status(500).send("Test failed");
  }
});

// ---------------- EXPRESS SERVER ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Push Server LIVE at http://localhost:${PORT}`);
});
