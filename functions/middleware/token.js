/* eslint-disable */

// Load environment variables dari file .env
require("dotenv").config();
const { error } = require("firebase-functions/logger");
const { db } = require('../config/firebase');
const jwt = require("jsonwebtoken");
// const { db } = require('./firebaseConfig'); // Pastikan db diimport sesuai struktur foldermu

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ message: "Akses ditolak. Token tidak ditemukan." });
    }

    const token = authHeader.split(" ")[1];

    // AMBIL SECRET DARI .ENV
    const secretKey = process.env.JWT_SECRET;

    if (!secretKey) {
      console.error("FATAL: JWT_SECRET tidak ditemukan di .env");
      return res
        .status(500)
        .json({ message: "Konfigurasi server bermasalah." });
    }

    // Verifikasi menggunakan Secret dari .env
    const decoded = jwt.verify(token, secretKey);

    // Cek User di DB (Opsional, tapi aman)
    // Pastikan 'db' sudah terdefinisi/diimport di file ini
    const userDoc = await db.collection("users").doc(decoded.id).get();

    if (!userDoc.exists) {
      return res
        .status(401)
        .json({ message: "Token tidak valid. User tidak ditemukan." });
    }

    const userData = userDoc.data();

    req.user = {
      email: decoded.id,
      role: userData.role,
      idCompany: userData.idCompany,
      status: userData.status,
      nama: userData.username,
    };

    next();
  } catch (e) {
    console.error("Token Error:", e);
    return res.status(403).json({ message: "Token Invalid atau Kadaluarsa", error: e, token: token});
  }
};

module.exports = { verifyToken };
