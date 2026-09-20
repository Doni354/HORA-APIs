/* eslint-disable */

// Load environment variables dari file .env
require("dotenv").config();
const { error } = require("firebase-functions/logger");
const { admin, db } = require("../config/firebase"); // Pastikan path ini benar
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

    let decoded = null;
    let authType = null; // "jwt" | "firebase"

    // 1. Coba verifikasi dengan custom JWT Vorce Backend
    const secretKey = process.env.JWT_SECRET;
    if (secretKey) {
      try {
        const decodedJwt = jwt.verify(token, secretKey);
        decoded = {
          id: decodedJwt.id,
          email: decodedJwt.id,
          role: decodedJwt.role,
          idCompany: decodedJwt.idCompany,
          status: decodedJwt.status,
          deviceId: decodedJwt.deviceId,
          fcmTokens: decodedJwt.fcmTokens,
          uid: decodedJwt.uid || decodedJwt.id,
        };
        authType = "jwt";
      } catch (jwtErr) {
        // Token mungkin merupakan Firebase ID Token (Google Auth dari mobile app)
      }
    }

    // 2. Jika bukan/gagal JWT backend, coba verifikasi dengan Firebase Auth (Google ID Token)
    if (!decoded) {
      try {
        const decodedFirebase = await admin.auth().verifyIdToken(token);
        decoded = {
          id: decodedFirebase.email,
          email: decodedFirebase.email,
          uid: decodedFirebase.uid,
          nama: decodedFirebase.name,
          picture: decodedFirebase.picture,
          authProvider: decodedFirebase.firebase?.sign_in_provider || "google",
        };
        authType = "firebase";
      } catch (fbErr) {
        return res
          .status(403)
          .json({ message: "Token Invalid atau Kadaluarsa", error: fbErr.message });
      }
    }

    const userEmail = decoded.id || decoded.email;
    if (!userEmail) {
      return res
        .status(401)
        .json({ message: "Token tidak memiliki identitas email yang valid." });
    }

    // 3. Cek User di Firestore
    const userRef = db.collection("users").doc(userEmail);
    let userDoc = await userRef.get();
    let userData = userDoc.exists ? userDoc.data() : null;

    // 4. Auto-provisioning User Dokumen untuk Akun Personal / Kandidat:
    // Jika user sudah login via Firebase Auth (Google) tetapi belum terdaftar di perusahaan manapun,
    // inisialisasi dokumen users/{email} secara mandiri agar personal storage dapat langsung dipakai.
    if (!userData) {
      const defaultUserData = {
        uid: decoded.uid || userEmail,
        username: decoded.nama || userEmail.split("@")[0],
        alamatEmail: userEmail,
        photoURL: decoded.picture || "",
        role: "user",
        status: "active",
        idCompany: null,
        usedStorage: 0,
        max_storage: 104857600, // 100MB Default Personal Storage
        createdAt: admin.firestore.Timestamp.now(),
        verified: true,
        authProvider: decoded.authProvider || "google",
      };

      await userRef.set(defaultUserData, { merge: true });
      userData = defaultUserData;
    }

    // ----------------------------------------------------------------------
    // [UPDATED] LOGIC SINGLE SESSION (VIA COMPANY DEVICE BINDINGS)
    // ----------------------------------------------------------------------
    // Device lock hanya berlaku bagi akun yang terikat ke company dan mengirim deviceId.
    // Kandidat atau akun personal (idCompany: null) bebas dari pembatasan ini.
    if (userData.idCompany && decoded.deviceId) {
      const companyDoc = await db
        .collection("companies")
        .doc(userData.idCompany)
        .get();
      if (companyDoc.exists) {
        const companyData = companyDoc.data();
        if (companyData.deviceLockEnabled) {
          const safeEmail = userEmail.replace(/\./g, "_");
          const boundDevice = (companyData.deviceBindings || {})[safeEmail];
          if (boundDevice && boundDevice !== decoded.deviceId) {
            return res.status(401).json({
              message:
                "Sesi kadaluarsa. Akun Anda telah login di perangkat lain.",
              forceLogout: true,
            });
          }
        }
      }
    }
    // ----------------------------------------------------------------------

    req.user = {
      email: userEmail,
      uid: userData.uid || decoded.uid || userEmail,
      role: userData.role || "user",
      idCompany: userData.idCompany || null,
      status: userData.status || "active",
      nama: userData.username || decoded.nama || userEmail.split("@")[0],
      deviceId: decoded.deviceId || null,
      fcmToken: decoded.fcmTokens || null,
      authType: authType,
    };

    next();
  } catch (e) {
    console.error("Token Error:", e);
    return res
      .status(403)
      .json({ message: "Token Invalid atau Kadaluarsa", error: e.message });
  }
};

module.exports = { verifyToken };
