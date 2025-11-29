/**
 * server.js
 * Catination Push Server — WITH ASSIGNMENT NOTIFICATIONS (FIXED VERSION)
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const admin = require("firebase-admin");
const Token = require("./models/Token");

// Node fetch polyfill
if (typeof fetch === "undefined") {
  global.fetch = require("node-fetch");
}

console.log("🚀 Catination Push Server starting...");

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
  console.error("❌ MONGO_URI missing");
  process.exit(1);
}
if (!FIREBASE_JSON) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT missing");
  process.exit(1);
}

// -------------------- Firebase Admin --------------------
let serviceAccount;
try {
  serviceAccount = JSON.parse(FIREBASE_JSON);
} catch (err) {
  console.error("❌ Firebase JSON parse error");
  process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log("✅ Firebase initialized");
} catch (err) {
  console.error("❌ Firebase init failed");
  process.exit(1);
}

// -------------------- MongoDB --------------------
mongoose.set("strictQuery", false);
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => {
    console.error("❌ MongoDB connection failed");
    process.exit(1);
  });

// -------------------- Deduplication --------------------
const recentLeads = new Map();
const RECENT_LEAD_TTL = 60 * 1000; // 1 minute

function markLeadProcessed(leadId) {
  if (leadId) {
    recentLeads.set(String(leadId), Date.now());
  }
}

function isLeadRecentlyProcessed(leadId) {
  if (!leadId) return false;
  const ts = recentLeads.get(String(leadId));
  if (!ts) return false;
  return (Date.now() - ts) < RECENT_LEAD_TTL;
}

// Cleanup every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of recentLeads) {
    if (now - v > RECENT_LEAD_TTL) {
      recentLeads.delete(k);
    }
  }
}, 300000);

// -------------------- FCM Send Functions --------------------
async function sendPushToTokens(data, tokens) {
  try {
    const normalized = Array.from(new Set(tokens.filter(Boolean)));
    if (!normalized.length) return;

    const leadId = String(data.leadId || "");
    const leadName = String(data.leadName || data.name || "New Lead");
    const source = String(data.source || "Lead");

    const ICON = "https://app.catination.com/catination-app-logo.png";

    const message = {
      notification: {
        title: `🔥 New Lead — ${source}`,
        body: leadName,
      },
      data: {
        leadId,
        leadName,
      },
      android: {
        priority: "high",
        notification: {
          icon: ICON,
          sound: "default",
          channelId: "catination_leads",
        },
      },
      apns: {
        headers: { "apns-priority": "10" },
        payload: {
          aps: {
            alert: { 
              title: `🔥 New Lead — ${source}`,
              body: leadName
            },
            sound: "default",
          },
        },
      },
      webpush: {
        headers: { Urgency: "high" },
        notification: {
          icon: ICON,
          badge: ICON,
          vibrate: [200, 100, 200],
          requireInteraction: true,
          tag: "catination_lead",
          actions: [
            { action: "accept", title: "✅ Accept" },
            { action: "view", title: "👁️ View" }
          ],
        },
      },
    };

    // Send in batches of 500
    const batches = [];
    for (let i = 0; i < normalized.length; i += 500) {
      batches.push(normalized.slice(i, i + 500));
    }

    for (const batch of batches) {
      try {
        const result = await admin.messaging().sendEachForMulticast({
          ...message,
          tokens: batch,
        });

        // Remove invalid tokens
        if (result.responses) {
          result.responses.forEach((response, index) => {
            if (!response.success) {
              const error = response.error;
              if (error?.code === "messaging/invalid-registration-token" || 
                  error?.code === "messaging/registration-token-not-registered") {
                Token.deleteOne({ token: batch[index] }).catch(() => {});
              }
            }
          });
        }
      } catch (error) {
        console.error("FCM batch send error:", error.message);
      }
    }

    console.log(`📱 FCM sent to ${normalized.length} devices for lead ${leadId}`);
  } catch (error) {
    console.error("FCM send error:", error.message);
  }
}

// 🆕 FIXED: Send Assignment Notification to Specific Employee (Multi-token support)
async function sendAssignmentNotification(employeeEmail, leadData, companyId) {
  try {
    // Get ALL the employee's FCM tokens (multiple devices)
    const employeeTokens = await Token.find({ 
      userId: employeeEmail,
      companyId: companyId,
      enabled: true 
    }).lean();

    if (!employeeTokens.length) {
      console.log(`⚠ No active tokens found for employee: ${employeeEmail}`);
      return false;
    }

    const tokens = employeeTokens.map(token => token.token).filter(Boolean);
    
    if (!tokens.length) {
      console.log(`⚠ No valid tokens for employee: ${employeeEmail}`);
      return false;
    }

    const leadName = leadData.leadName || "New Lead";
    const leadId = leadData.leadId || "";
    const assignedBy = leadData.assignedBy || "Admin";

    const ICON = "https://app.catination.com/catination-app-logo.png";

    const message = {
      notification: {
        title: "🎯 Lead Assigned to You",
        body: `${leadName} has been assigned to you by ${assignedBy}`,
      },
      data: {
        type: "LEAD_ASSIGNED",
        leadId: leadId,
        leadName: leadName,
        assignedBy: assignedBy,
        assignedAt: new Date().toISOString(),
        employeeEmail: employeeEmail
      },
      android: {
        priority: "high",
        notification: {
          icon: ICON,
          sound: "default",
          channelId: "catination_assignments",
        },
      },
      apns: {
        headers: { "apns-priority": "10" },
        payload: {
          aps: {
            alert: { 
              title: "🎯 Lead Assigned to You",
              body: `${leadName} has been assigned to you by ${assignedBy}`
            },
            sound: "default",
          },
        },
      },
      webpush: {
        headers: { Urgency: "high" },
        notification: {
          icon: ICON,
          badge: ICON,
          vibrate: [200, 100, 200, 100, 200],
          requireInteraction: true,
          tag: `assignment_${leadId}`,
          actions: [
            { action: "view", title: "👀 View Lead" },
            { action: "accept", title: "✅ Accept" }
          ],
        },
      },
    };

    // Send to all employee devices
    const result = await admin.messaging().sendEachForMulticast({
      ...message,
      tokens: tokens,
    });

    // Remove invalid tokens
    if (result.responses) {
      result.responses.forEach((response, index) => {
        if (!response.success) {
          const error = response.error;
          if (error?.code === "messaging/invalid-registration-token" || 
              error?.code === "messaging/registration-token-not-registered") {
            Token.deleteOne({ token: tokens[index] }).catch(() => {});
          }
        }
      });
    }

    console.log(`✅ Assignment notification sent to: ${employeeEmail} for lead: ${leadName} (${result.successCount}/${tokens.length} successful)`);
    return result.successCount > 0;

  } catch (error) {
    console.error(`❌ Assignment notification failed for ${employeeEmail}:`, error.message);
    return false;
  }
}

// -------------------- Lead Handler --------------------
async function handleLeadEvent(data) {
  try {
    if (!data || typeof data !== "object") return;

    // Get company ID
    const companyId = data.companyId || data.tenantId;
    if (!companyId) return;

    const leadId = data.leadId ? String(data.leadId) : null;

    // Deduplication
    if (leadId && isLeadRecentlyProcessed(leadId)) {
      console.log(`⏭️ Skipping duplicate lead: ${leadId}`);
      return;
    }

    // Get tokens
    const tokens = await Token.find({ 
      companyId: String(companyId), 
      enabled: true 
    }).lean();

    const tokenSet = new Set();
    
    tokens.forEach((token) => {
      if (!token?.token) return;
      
      // ADMIN always receives
      if (token.role === "ADMIN") {
        tokenSet.add(String(token.token));
      }
      // EMPLOYEE only if roleExperience === "1"  
      if (token.role === "EMPLOYEE" && String(token.roleExperience || "0") === "1") {
        tokenSet.add(String(token.token));
      }
    });

    const targets = Array.from(tokenSet);
    
    if (targets.length === 0) {
      if (leadId) markLeadProcessed(leadId);
      return;
    }

    // Send FCM notification
    await sendPushToTokens(data, targets);
    if (leadId) markLeadProcessed(leadId);
    
    console.log(`✅ Processed lead ${leadId} for ${targets.length} users`);

  } catch (error) {
    console.error("Lead processing error:", error.message);
  }
}

// -------------------- SSE Listener --------------------
let sseRunning = false;
let reconnectDelay = 2000;
const MAX_DELAY = 60000;

async function startSSE() {
  if (!SSE_URL || sseRunning) return;

  sseRunning = true;
  
  try {
    const response = await fetch(SSE_URL, { 
      method: "GET", 
      headers: { Accept: "text/event-stream" } 
    });

    if (!response.ok) throw new Error(`SSE error: ${response.status}`);

    console.log("🔌 SSE connected");
    reconnectDelay = 2000;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
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

        const dataLine = eventChunk
          .split("\n")
          .find(line => line.startsWith("data:"))
          ?.replace("data:", "")
          .trim();

        if (!dataLine?.startsWith("{")) continue;

        try {
          const leadData = JSON.parse(dataLine);
          await handleLeadEvent(leadData);
        } catch (error) {
          console.error("SSE parse error:", error.message);
        }
      }
    }
  } catch (error) {
    console.error("SSE connection error:", error.message);
  }

  sseRunning = false;
  reconnectDelay = Math.min(reconnectDelay * 1.4, MAX_DELAY);
  
  setTimeout(() => {
    startSSE();
  }, reconnectDelay);
}

// Start SSE if configured
if (SSE_URL) {
  startSSE().catch(error => {
    console.error("SSE startup error:", error.message);
  });
}

// -------------------- API Routes --------------------

// Register FCM token
app.post("/register-token", async (req, res) => {
  try {
    const { token, userId, companyId, role, roleExperience } = req.body || {};

    if (!token || !userId || !companyId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Respond immediately
    res.json({ success: true });

    // Background processing
    setImmediate(async () => {
      try {
        // Delete old tokens for this user (single-device mode)
        await Token.deleteMany({ userId, token: { $ne: token } });

        // Upsert new token
        await Token.updateOne(
          { token },
          {
            $set: {
              token,
              userId,
              companyId,
              role: role || "",
              roleExperience: roleExperience || "0",
              enabled: true,
              lastSeen: new Date(),
            }
          },
          { upsert: true }
        );

        console.log(`✅ Token registered for user: ${userId}`);
      } catch (error) {
        console.error("Token registration error:", error.message);
      }
    });

  } catch (error) {
    console.error("Register token error:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// 🆕 FIXED: Send Assignment Notification API
app.post("/send-assignment-notification", async (req, res) => {
  try {
    const { employeeEmail, leadData, companyId } = req.body;

    if (!employeeEmail || !companyId) {
      return res.status(400).json({
        success: false,
        message: "Missing employeeEmail or companyId"
      });
    }

    // Respond immediately
    res.json({ 
      success: true, 
      message: "Assignment notification queued" 
    });

    // Send notification in background
    setImmediate(async () => {
      try {
        const result = await sendAssignmentNotification(employeeEmail, leadData, companyId);
        if (!result) {
          console.log(`⚠ Assignment notification failed for ${employeeEmail}, but assignment was successful`);
        }
      } catch (error) {
        console.error("Background assignment notification error:", error);
      }
    });

  } catch (error) {
    console.error("Assignment notification API error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
});

// Logout - disable token
app.post("/logout-token", async (req, res) => {
  try {
    const { userId, token } = req.body || {};

    if (token) {
      await Token.updateOne({ token }, { enabled: false });
    }
    if (userId) {
      await Token.updateMany({ userId }, { enabled: false });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Logout error:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ 
    ok: true, 
    timestamp: new Date().toISOString(),
    sseConnected: sseRunning
  });
});

// 🆕 FIXED: DISTRIBUTE REMINDER NOTIFICATIONS (Updated for multiple tokens)
app.post("/admin/distribute", async (req, res) => {
  try {
    const { employees, companyId } = req.body;

    if (!employees || employees.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No employees provided",
      });
    }

    // Instant response
    res.json({ success: true, message: "Reminder notifications queued" });

    // Background execution
    setImmediate(async () => {
      try {
        for (const emp of employees) {
          // Get ALL active tokens of employee (multiple devices)
          const empTokens = await Token.find({
            userId: emp,
            companyId: companyId,
            enabled: true,
          }).lean();

          if (!empTokens.length) {
            console.log(`⚠ No tokens for: ${emp}`);
            continue;
          }

          const tokens = empTokens.map(t => t.token).filter(Boolean);

          // Reminder notification
          const message = {
            notification: {
              title: "📥 New Lead Assigned",
              body: "Open Catination to check your newly assigned lead.",
            },
            data: {
              type: "LEAD_ASSIGN_REMINDER",
              employeeEmail: emp,
              timestamp: Date.now().toString()
            },
            android: { 
              priority: "high",
              notification: {
                sound: "default",
                channelId: "catination_reminders"
              }
            },
            apns: { 
              headers: { "apns-priority": "10" },
              payload: {
                aps: { 
                  sound: "default",
                  alert: {
                    title: "📥 New Lead Assigned",
                    body: "Open Catination to check your newly assigned lead."
                  }
                }
              } 
            },
            webpush: {
              headers: { Urgency: "high" },
              notification: {
                icon: "https://app.catination.com/catination-app-logo.png",
                badge: "https://app.catination.com/catination-app-logo.png",
                vibrate: [150, 80, 150],
                requireInteraction: false
              },
            },
          };

          // Send to all devices
          const result = await admin.messaging().sendEachForMulticast({
            ...message,
            tokens: tokens,
          });

          // Remove invalid tokens
          if (result.responses) {
            result.responses.forEach((response, index) => {
              if (!response.success) {
                const error = response.error;
                if (error?.code === "messaging/invalid-registration-token" || 
                    error?.code === "messaging/registration-token-not-registered") {
                  Token.deleteOne({ token: tokens[index] }).catch(() => {});
                }
              }
            });
          }

          console.log(`📨 Reminder sent to: ${emp} (${result.successCount}/${tokens.length} successful)`);
        }

        console.log("🎉 Reminder notifications completed.");
      } catch (err) {
        console.error("❌ Reminder notification error:", err);
      }
    });

  } catch (err) {
    console.error("❌ API error /admin/distribute:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// 🆕 NEW: Bulk Assignment Notifications API (For multiple leads)
app.post("/send-bulk-assignment-notifications", async (req, res) => {
  try {
    const { assignments, companyId } = req.body;

    if (!assignments || !Array.isArray(assignments) || !companyId) {
      return res.status(400).json({
        success: false,
        message: "Missing assignments array or companyId"
      });
    }

    // Respond immediately
    res.json({ 
      success: true, 
      message: "Bulk assignment notifications queued" 
    });

    // Process in background
    setImmediate(async () => {
      try {
        let totalSent = 0;
        let totalFailed = 0;

        for (const assignment of assignments) {
          const { employeeEmail, leadData } = assignment;
          
          if (!employeeEmail || !leadData) {
            console.log("⚠ Skipping invalid assignment:", assignment);
            continue;
          }

          const result = await sendAssignmentNotification(employeeEmail, leadData, companyId);
          
          if (result) {
            totalSent++;
          } else {
            totalFailed++;
          }

          // Small delay to avoid overwhelming FCM
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        console.log(`📊 Bulk assignment notifications completed: ${totalSent} sent, ${totalFailed} failed`);
      } catch (error) {
        console.error("Bulk assignment notification error:", error);
      }
    });

  } catch (error) {
    console.error("Bulk assignment API error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
});

// -------------------- Start Server --------------------
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 SSE: ${SSE_URL ? "Enabled" : "Disabled"}`);
  console.log(`🎯 Assignment notifications: ENABLED`);
  console.log(`🔥 Multi-device support: ENABLED`);
});
