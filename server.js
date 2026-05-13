const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json());
app.use(cors());

// ===== MONGODB CONNECTION =====
mongoose.connect("mongodb://okeziedavid02_db_user:toGTkRWFMstJWmfN@ac-ngrm9os-shard-00-00.irwlliy.mongodb.net:27017,ac-ngrm9os-shard-00-01.irwlliy.mongodb.net:27017,ac-ngrm9os-shard-00-02.irwlliy.mongodb.net:27017/?ssl=true&replicaSet=atlas-kb7s28-shard-0&authSource=admin&appName=Cluster0")
  .then(() => {
    console.log("MongoDB Connected");
    seedAdmins();
  })
  .catch(err => console.log("DB Error:", err));

// ===== EMAIL SETUP =====
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "info.aquanautsystems@gmail.com",
    pass: "YOUR_APP_PASSWORD_HERE"
  }
});

// ===== PRICING =====
const PRICING = {
  "private_waterfront": { label: "Private Waterfront", pricePerBot: 350000 },
  "esg_corporation":    { label: "ESG Corporation",    pricePerBot: 2000000 },
  "government":         { label: "Government",         pricePerBot: 5000000 }
};
const BOTS_PER_FLEET = 10;
const COVERAGE_PER_BOT_M2 = 450;

// ===== SCHEMAS =====
const userSchema = new mongoose.Schema({
  name:         { type: String, required: true },
  email:        { type: String, required: true, unique: true },
  password:     { type: String, required: true },
  role:         { type: String, enum: ["admin", "customer"], default: "customer" },
  customerType: { type: String, enum: ["private_waterfront", "esg_corporation", "government"] },
  fleets:       { type: Number, default: 0 },
  totalBots:    { type: Number, default: 0 },
  amountPaid:   { type: Number, default: 0 },
  paystackRef:  { type: String },
  createdAt:    { type: Date, default: Date.now }
});

const botSchema = new mongoose.Schema({
  botId:          { type: String, required: true, unique: true },
  ownerId:        { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  ownerEmail:     String,
  status:         { type: String, enum: ["active", "inactive"], default: "inactive" },
  wasteCollected: { type: Number, default: 0 },
  location:       { lat: Number, lng: Number },
  lastUpdated:    { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);
const Bot  = mongoose.model("Bot", botSchema);

// ===== SEED ADMIN ACCOUNTS =====
async function seedAdmins() {
  const admins = [
    { name: "Okezie David",  email: "admin@aquanaut.com",              password: "AquaAdmin@2025!" },
    { name: "AquaNaut Admin",email: "info.aquanautsystems@gmail.com",  password: "AquaAdmin@2025!" }
  ];
  for (const a of admins) {
    const exists = await User.findOne({ email: a.email });
    if (!exists) {
      const hashed = await bcrypt.hash(a.password, 10);
      await User.create({ name: a.name, email: a.email, password: hashed, role: "admin" });
      console.log(`Admin seeded: ${a.email}`);
    }
  }
}

// ===== AUTH MIDDLEWARE =====
function auth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.sendStatus(401);
  try {
    req.user = jwt.verify(token, "aquanaut_secret_2025");
    next();
  } catch {
    res.sendStatus(403);
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== "admin") return res.sendStatus(403);
  next();
}

// ===== GENERATE DUMMY BOTS FOR A CUSTOMER =====
async function generateBotsForCustomer(userId, userEmail, fleetCount) {
  const totalBots = fleetCount * BOTS_PER_FLEET;
  const existingCount = await Bot.countDocuments({ ownerId: userId });
  if (existingCount >= totalBots) return;

  // Lagos waterway coordinates (slight randomisation)
  const baseLat = 6.5244, baseLng = 3.3792;

  for (let i = existingCount + 1; i <= totalBots; i++) {
    const botIndex = String(i).padStart(3, "0");
    // ~70% active, 30% inactive
    const isActive  = Math.random() < 0.7;
    const waste     = isActive ? parseFloat((Math.random() * 40 + 5).toFixed(2)) : 0;
    const latOffset = (Math.random() - 0.5) * 0.08;
    const lngOffset = (Math.random() - 0.5) * 0.08;

    await Bot.create({
      botId:          `BOT-${userId.toString().slice(-4).toUpperCase()}-${botIndex}`,
      ownerId:        userId,
      ownerEmail:     userEmail,
      status:         isActive ? "active" : "inactive",
      wasteCollected: waste,
      location:       { lat: baseLat + latOffset, lng: baseLng + lngOffset },
      lastUpdated:    new Date()
    });
  }
}

// ===== VERIFY PAYSTACK PAYMENT =====
app.post("/verify-payment", async (req, res) => {
  const { reference } = req.body;
  if (!reference) return res.status(400).json({ success: false, message: "No reference provided" });

  try {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: "Bearer sk_test_REPLACE_WITH_YOUR_SECRET_KEY" }
    });
    const data = await response.json();
    if (data.status && data.data.status === "success") {
      return res.json({ success: true, data: data.data });
    }
    return res.json({ success: false, message: "Payment not successful" });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Verification failed" });
  }
});

// ===== REGISTER CUSTOMER =====
app.post("/register", async (req, res) => {
  try {
    const { name, email, password, customerType, fleets, paystackRef } = req.body;

    if (!name || !email || !password || !customerType || !fleets) {
      return res.status(400).json({ success: false, message: "All fields required" });
    }

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ success: false, message: "Email already registered" });

    const pricing     = PRICING[customerType];
    const totalBots   = fleets * BOTS_PER_FLEET;
    const amountPaid  = totalBots * pricing.pricePerBot;
    const hashed      = await bcrypt.hash(password, 10);

    const user = await User.create({
      name, email,
      password:     hashed,
      role:         "customer",
      customerType,
      fleets:       Number(fleets),
      totalBots,
      amountPaid,
      paystackRef:  paystackRef || null
    });

    await generateBotsForCustomer(user._id, email, Number(fleets));

    // Email notification
    try {
      await transporter.sendMail({
        from: '"AquaNaut Systems" <info.aquanautsystems@gmail.com>',
        to:   "info.aquanautsystems@gmail.com",
        subject: "🌊 New Customer Registration — AquaNaut",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#001219;color:white;border-radius:15px;overflow:hidden;">
            <div style="background:#0a9396;padding:30px;text-align:center;">
              <h1 style="margin:0;font-size:1.8rem;">⚓ AquaNaut Systems</h1>
              <p style="margin:5px 0 0;opacity:0.85;">New Customer Registration</p>
            </div>
            <div style="padding:35px;">
              <table style="width:100%;border-collapse:collapse;">
                <tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
                  <td style="padding:12px 0;color:rgba(255,255,255,0.5);width:40%;">Name</td>
                  <td style="padding:12px 0;font-weight:bold;">${name}</td>
                </tr>
                <tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
                  <td style="padding:12px 0;color:rgba(255,255,255,0.5);">Email</td>
                  <td style="padding:12px 0;font-weight:bold;">${email}</td>
                </tr>
                <tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
                  <td style="padding:12px 0;color:rgba(255,255,255,0.5);">Customer Type</td>
                  <td style="padding:12px 0;font-weight:bold;">${pricing.label}</td>
                </tr>
                <tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
                  <td style="padding:12px 0;color:rgba(255,255,255,0.5);">Fleets Purchased</td>
                  <td style="padding:12px 0;font-weight:bold;">${fleets} fleet(s) — ${totalBots} bots</td>
                </tr>
                <tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
                  <td style="padding:12px 0;color:rgba(255,255,255,0.5);">Total Amount</td>
                  <td style="padding:12px 0;font-weight:bold;color:#0a9396;">₦${amountPaid.toLocaleString()}</td>
                </tr>
                <tr>
                  <td style="padding:12px 0;color:rgba(255,255,255,0.5);">Paystack Ref</td>
                  <td style="padding:12px 0;">${paystackRef || "N/A"}</td>
                </tr>
              </table>
            </div>
          </div>
        `
      });
    } catch (mailErr) {
      console.log("Email error (non-fatal):", mailErr.message);
    }

    res.json({ success: true, message: "Account created" });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ success: false, message: "Registration failed" });
  }
});

// ===== LOGIN (ADMIN + CUSTOMER) =====
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.json({ success: false, message: "Invalid credentials" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.json({ success: false, message: "Invalid credentials" });

    const token = jwt.sign(
      { id: user._id, role: user.role, email: user.email, name: user.name },
      "aquanaut_secret_2025"
    );

    res.json({
      success: true,
      token,
      role: user.role,
      name: user.name
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Login failed" });
  }
});

// ===== CUSTOMER DASHBOARD DATA =====
app.get("/my-dashboard", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== "customer") return res.sendStatus(403);

    const bots        = await Bot.find({ ownerId: user._id });
    const activeBots  = bots.filter(b => b.status === "active").length;
    const totalWaste  = bots.reduce((sum, b) => sum + b.wasteCollected, 0);

    res.json({
      name:          user.name,
      customerType:  user.customerType,
      fleets:        user.fleets,
      totalBots:     user.totalBots,
      activeBots,
      inactiveBots:  user.totalBots - activeBots,
      totalWaste:    parseFloat(totalWaste.toFixed(2)),
      coverageM2:    user.totalBots * COVERAGE_PER_BOT_M2,
      bots:          bots.map(b => ({
        botId:          b.botId,
        status:         b.status,
        wasteCollected: b.wasteCollected,
        location:       b.location
      }))
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load dashboard" });
  }
});

// ===== ADMIN DASHBOARD DATA =====
app.get("/admin-dashboard", auth, adminOnly, async (req, res) => {
  try {
    const customers   = await User.find({ role: "customer" });
    const allBots     = await Bot.find();
    const activeBots  = allBots.filter(b => b.status === "active").length;
    const totalWaste  = allBots.reduce((sum, b) => sum + b.wasteCollected, 0);
    const totalRevenue = customers.reduce((sum, c) => sum + c.amountPaid, 0);

    const customerSummary = customers.map(c => ({
      name:         c.name,
      email:        c.email,
      customerType: c.customerType,
      fleets:       c.fleets,
      totalBots:    c.totalBots,
      amountPaid:   c.amountPaid,
      createdAt:    c.createdAt
    }));

    res.json({
      totalCustomers: customers.length,
      totalBots:      allBots.length,
      activeBots,
      inactiveBots:   allBots.length - activeBots,
      totalWaste:     parseFloat(totalWaste.toFixed(2)),
      totalRevenue,
      customers:      customerSummary,
      bots:           allBots
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load admin dashboard" });
  }
});

// ===== LEGACY BOT DATA ROUTE (kept for ESP32 future use) =====
app.post("/bot-data", async (req, res) => {
  const { botId, waste, lat, lng } = req.body;
  const bot = await Bot.findOne({ botId });
  if (!bot) return res.status(404).send("Bot not found");
  bot.location       = { lat, lng };
  bot.wasteCollected += waste;
  bot.lastUpdated    = new Date();
  await bot.save();
  res.send("Bot data stored");
});

app.listen(5000, () => console.log("Server running on port 5000"));