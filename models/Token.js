// models/Token.js
const mongoose = require("mongoose");

const TokenSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    companyId: { type: String, required: true, index: true },
    role: { type: String, default: "" }, // ADMIN / EMPLOYEE / etc
    roleExperience: { type: String, default: "0" }, // e.g. "1" to get SSE leads
    enabled: { type: Boolean, default: true },
    clientInfo: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastSeen: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Token", TokenSchema);
