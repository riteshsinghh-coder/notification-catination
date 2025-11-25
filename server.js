// =======================
//  SERVER.JS — FINAL ZOMATO POPUP VERSION
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

// --------- CORS ----------
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:3000",
      "https://app.catination.com",
      "https://catination.com",
      "https://notification-catination.onrender.com"
    ],
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
let tokens = new Set();

app.post("/register-token", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token required" });

  tokens.add(token);
  console.log("✅ Token registered:", token);
  console.log("👉 Total tokens:", tokens.size);

  res.json({ success: true });
});

app.post("/remove-token", (req, res) => {
  const { token } = req.body;
  if (token) {
    tokens.delete(token);
    console.log("❌ Token removed:", token);
  }
  res.json({ success: true });
});

app.get("/tokens", (req, res) => {
  res.json({ tokens: Array.from(tokens) });
});

// ----------------------------------------------------
// SSE URL — LEADS STREAM
// ----------------------------------------------------
const SSE_URL =
  "https://api.catination.com/service/notifications/stream?tenantId=29ABCDE1234F2Z5&streamKey=HelloAryan";

let reconnectDelay = 2000;
const MAX_DELAY = 60000;

// ======================================================
//  SEND HIGH PRIORITY ZOMATO STYLE PUSH NOTIFICATION
// ======================================================
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

  const ICON_URL = "https://app.catination.com/catination-app-logo.png";
  const BADGE_URL = ICON_URL;

  const title = `🔥 New Hot Lead (${source})`;
  const body = `${leadName} — ${phone} — ${property}`;

  // FINAL FIXED MESSAGE
  const message = {
    notification: {
      title,
      body
    },

    data: {
      leadId,
      name: leadName,
      phone,
      property
    },

    // ANDROID (ignored by Chrome, safe but not required)
    android: {
      priority: "high",
      notification: {
        channelId: "catination_high_priority",
        sound: "default",
        vibrateTimingsMillis: [200, 100, 200, 100, 200]
      }
    },

    // WEB PUSH — THE IMPORTANT PART
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
        renotify: true,
        vibrate: [200, 100, 200, 100, 200],
        tag: "catination_high_priority",  // FIXED
        sound: "default"
      },
      fcmOptions: {
        link: `https://app.catination.com/dashboard/lead-management?leadId=${leadId}`
      }
    },

    tokens: tokensArr
  };

  try {
    const result = await admin.messaging().sendEachForMulticast(message);

    console.log(
      `📨 Push sent → Success: ${result.successCount}, Failed: ${result.failureCount}`
    );

    result.responses.forEach((r, i) => {
      if (!r.success) {
        const t = tokensArr[i];
        console.log("❌ Removing invalid token:", t);
        tokens.delete(t);
      }
    });
  } catch (err) {
    console.error("🔥 FCM ERROR:", err);
  }
}

// ======================================================
//  CONNECT TO SSE
// ======================================================
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

// Start SSE
startSSE();

// ---------------- EXPRESS SERVER ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Push Server LIVE at http://localhost:${PORT}`);
});
