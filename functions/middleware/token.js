/* eslint-disable */

// Load environment variables dari file .env
require("dotenv").config();
const { error } = require("firebase-functions/logger");
const { db } = require('../config/firebase'); // Pastikan path ini benar
const jwt = require("jsonwebtoken");

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

    // Cek User di DB
    const userDoc = await db.collection("users").doc(decoded.id).get();

    if (!userDoc.exists) {
      return res
        .status(401)
        .json({ message: "Token tidak valid. User tidak ditemukan." });
    }

    const userData = userDoc.data();

    // ----------------------------------------------------------------------
    // [BARU] LOGIC SINGLE SESSION (MENCEGAH DOUBLE LOGIN)
    // ----------------------------------------------------------------------
    // decoded.deviceId = Device ID yang tersimpan di dalam Token (dari Login)
    // userData.currentDeviceId = Device ID terakhir yang login di Database
    
    // Pengecekan:
    // 1. Pastikan di database ada currentDeviceId (untuk backward compatibility)
    // 2. Jika ada, bandingkan dengan yang di token.
    if (userData.currentDeviceId && decoded.deviceId) {
        if (userData.currentDeviceId !== decoded.deviceId) {
            // Jika BEDA, berarti ada device baru yang login setelah token ini dibuat
            return res.status(401).json({ 
                message: "Sesi kadaluarsa. Akun Anda telah login di perangkat lain.",
                forceLogout: true // Flag untuk Frontend
            });
        }
    }
    // ----------------------------------------------------------------------

    req.user = {
      email: decoded.id,
      role: userData.role,
      idCompany: userData.idCompany,
      status: userData.status,
      nama: userData.username,
      deviceId: decoded.deviceId // Opsional: simpan juga deviceId di req
    };

    next();
  } catch (e) {
    console.error("Token Error:", e);
    return res.status(403).json({ message: "Token Invalid atau Kadaluarsa", error: e.message });
  }
};

module.exports = { verifyToken };