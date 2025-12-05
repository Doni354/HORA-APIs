/* eslint-disable */
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2/options");
const express = require("express");
const cors = require("cors");

const loginRoutes = require("./routes/login");
const absensiRoutes = require("./routes/absensi");
const profileRoutes = require("./routes/profile");
const companyRoutes = require("./routes/company");

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
// Express App
// ---------------------------------------------------------
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());
app.options("*", cors());

app.use("/api/login", loginRoutes);
app.use("/api/absensi", absensiRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/company", companyRoutes);
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
