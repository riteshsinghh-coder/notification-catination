const mongoose = require("mongoose");

const TokenSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  userId: { type: String, index: true, default: null },
  companyId: { type: String, index: true, default: null },
  role: { type: String, index: true, default: null }, // "EMPLOYEE" or "ADMIN"
  roleExperience: { type: String, index: true, default: null }, // "1" or "0"
  enabled: { type: Boolean, default: true },
  lastSeen: { type: Date, default: Date.now },
  clientInfo: { type: mongoose.Schema.Types.Mixed, default: null },
});

module.exports = mongoose.model("Token", TokenSchema);
