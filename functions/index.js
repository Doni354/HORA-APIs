/* eslint-disable */
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2/options");
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const { Timestamp } = require("firebase-admin/firestore");
const Busboy = require("busboy");
const path = require("path");

const { admin } = require("./config/firebase");

const loginRoutes = require("./routes/login");
const absensiRoutes = require("./routes/absensi");

// ---------------------------------------------------------
// Cloud Functions Global Config
// ---------------------------------------------------------
setGlobalOptions({
  region: "asia-southeast2",
  memory: "256MiB",
  consumeRawBody: true,
  timeoutSeconds: 60,
});

// ---------------------------------------------------------
// ENV / Config
// ---------------------------------------------------------
const JWT_SECRET = "SECRET_TEMP";
const OTP_EXPIRE = 300; // Updated OTP_EXPIRE to 300 seconds (5 minutes)

// ---------------------------------------------------------
// Utility
// ---------------------------------------------------------
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ---------------------------------------------------------
// Express App
// ---------------------------------------------------------
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());
app.options("*", cors());

app.use("/api/login", loginRoutes);
app.use("/api/absensi", absensiRoutes);

// ---------------------------------------------------------
// TEST
// ---------------------------------------------------------
app.get("/test", (req, res) => {
  console.log(
    "[v0] Test endpoint called - method:",
    req.method,
    "origin:",
    req.headers.origin
  );
  res
    .status(200)
    .header("Access-Control-Allow-Origin", "*")
    .header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    .header("Access-Control-Allow-Headers", "Content-Type, Authorization")
    .send("Function is working!");
});

// ---------------------------------------------------------
// EXPORT SINGLE FUNCTION (Gen2)
// ---------------------------------------------------------
exports.api = onRequest(app);
