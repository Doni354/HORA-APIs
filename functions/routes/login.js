/* eslint-disable */
const admin = require("firebase-admin");
require("dotenv").config();
const express = require("express");
const jwt = require("jsonwebtoken");
const Busboy = require("busboy");
const path = require("path");
const { Timestamp } = require("firebase-admin/firestore");
const { db, bucket } = require("../config/firebase");
const { verifyToken } = require("../middleware/token");
const { logCompanyActivity } = require("../helper/logCompanyActivity");
const router = express.Router();

// ---------------------------------------------------------
// CONFIG FROM ENV
// ---------------------------------------------------------
// Ambil secret dari .env, kalau tidak ada, baru pakai fallback (untuk development)
const JWT_SECRET = process.env.JWT_SECRET || "RAHASIA_DAPUR_DEFAULT";
// Ambil durasi OTP dari .env (dalam detik), default 300 detik (5 menit)
const OTP_DURATION = parseInt(process.env.OTP_EXPIRE_SECONDS) || 300;

// ---------------------------------------------------------
// Utility
// ---------------------------------------------------------
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
// ---------------------------------------------------------
// SEND OTP (Request Login)
// ---------------------------------------------------------
router.put("/sendlink", async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).send("Email required");

    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).send("Email belum terdaftar.");
    }

    const userData = userDoc.data();

    // --- CEK STATUS USER ---
    // 1. Jika user sudah DITOLAK
    if (userData.role === "rejected") {
      return res
        .status(403)
        .send("Maaf, pendaftaran Anda sebelumnya telah ditolak.");
    }

    // 2. Jika user NON-AKTIF
    if (userData.status === "inactive" || userData.status === "banned") {
      return res.status(403).send("Akun Anda telah dinonaktifkan.");
    }

    // --- CEK COOLDOWN ---
    const now = Date.now();
    const prevExpire = userData.otpExpires?.toMillis?.() || 0;

    // Jika OTP masih berlaku, jangan kirim baru
    if (prevExpire > now) {
      return res
        .status(400)
        .send("Kode OTP sebelumnya masih aktif. Cek email anda.");
    }

    // --- GENERATE & KIRIM ---
    const otp = generateOTP();

    // Gunakan durasi dari variabel konfigurasi di atas
    const otpExpires = Timestamp.fromMillis(now + OTP_DURATION * 1000);

    await userRef.update({ otp, otpExpires });

    console.log(`OTP for ${email}: ${otp}`);

    // Kirim Email
    await db.collection("mail").add({
      to: email,
      message: {
        subject: "Kode Masuk Akun",
        html: `
            <h1>${otp}</h1>
            <p>Berlaku ${Math.floor(OTP_DURATION / 60)} menit.</p>
          `,
      },
    });

    return res.status(200).send("Kode OTP telah dikirim");
  } catch (e) {
    console.error("Send OTP Error:", e);
    return res.status(500).send("Gagal mengirim OTP");
  }
});

// ---------------------------------------------------------
// VERIFY OTP (Login & Token Generation)
// ---------------------------------------------------------
router.get("/verifyOTP", async (req, res) => {
  try {
    const email = req.query.email;
    const otp = req.query.otp;

    if (!email || !otp) return res.status(400).send("Email & OTP required");

    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();

    if (!userDoc.exists) return res.status(404).send("User tidak ditemukan");

    const data = userDoc.data();

    // 1. Validasi Kode & Waktu
    if (data.otp !== otp) return res.status(400).send("Kode OTP salah");
    if (data.otpExpires.toMillis() < Date.now())
      return res.status(400).send("OTP kadaluarsa");

    // 2. Bersihkan OTP
    await userRef.update({ verified: true, otp: null, otpExpires: null });

    // --- CEK ROLE SEBELUM LOGIN ---

    // KASUS A: Candidate
    if (data.role === "candidate") {
      return res.status(403).json({
        message: "Akun Menunggu Persetujuan",
        error: "PENDING_APPROVAL",
        info: "Silakan hubungi Admin perusahaan untuk konfirmasi akun Anda.",
      });
    }

    // KASUS B: Rejected
    if (data.role === "rejected") {
      return res.status(403).json({
        message: "Pendaftaran Ditolak",
        error: "REGISTRATION_REJECTED",
      });
    }

    // KASUS C: SUKSES (Admin / Staff / Employee)
    const tokenPayload = {
      id: email,
      role: data.role,
      idCompany: data.idCompany,
      status: data.status,
    };

    // Gunakan JWT_SECRET yang sudah diambil dari .env di atas
    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: "30d" });

    return res.status(200).json({
      message: "Login Berhasil",
      token: token,
      user: {
        email: email,
        role: data.role,
        idCompany: data.idCompany,
        nama: data.namaLengkap || data.username,
      },
    });
  } catch (e) {
    console.error("Verify OTP Error:", e);
    return res.status(500).send("Server Error");
  }
});

const crypto = require("crypto");

// ==================================================================
// 1. HELPER FUNCTIONS (OPTIMISASI)
// ==================================================================

/**
 * Validasi Status & Role User
 * Mengembalikan string error jika bermasalah, atau null jika aman.
 */
const checkUserStatus = (data) => {
  if (data.status === "inactive" || data.status === "banned") {
    return "Akun dinonaktifkan oleh sistem.";
  }
  if (data.role === "candidate") {
    return "Akun sedang menunggu persetujuan Admin.";
  }
  if (data.role === "rejected") {
    return "Lamaran Anda ditolak, silakan daftar kembali.";
  }
  return null; // OK
};

/**
 * Logic Anti-Curang Device (Strict Mode)
 * Mengembalikan object { allowed: boolean, errorData: object }
 */
const checkDeviceSecurity = async (
  db,
  userEmail,
  userData,
  incomingDeviceId
) => {
  // CEK 1: ACCOUNT LOCKING (Akun ini milik Device siapa?)
  // Jika user sudah terikat device lain, tolak.
  if (
    userData.currentDeviceId &&
    userData.currentDeviceId !== incomingDeviceId
  ) {
    return {
      allowed: false,
      errorData: {
        status: 409,
        message: "Login Gagal. Akun ini terkunci pada perangkat lain.",
        error: "DEVICE_MISMATCH",
        info: "Ganti device harus melalui persetujuan Admin (Reset Device).",
      },
    };
  }

  // CEK 2: DEVICE LOCKING (Device ini milik Siapa?)
  // Cari apakah ada user LAIN yang sedang mengunci device ini.
  const duplicateDeviceQuery = await db
    .collection("users")
    .where("currentDeviceId", "==", incomingDeviceId)
    .get();

  let deviceUsedByOther = false;
  duplicateDeviceQuery.forEach((doc) => {
    if (doc.id !== userEmail) deviceUsedByOther = true;
  });

  if (deviceUsedByOther) {
    return {
      allowed: false,
      errorData: {
        status: 409,
        message: "Login Gagal. Perangkat ini sudah terdaftar untuk akun lain.",
        error: "DEVICE_ALREADY_USED",
        info: "Satu perangkat hanya boleh digunakan oleh satu akun.",
      },
    };
  }

  return { allowed: true };
};

/**
 * Logic Verifikasi Email & Cooldown
 * Menghandle pengecekan status, cooldown, dan pengiriman email otomatis.
 */
const handleEmailVerification = async (db, userRef, userData, email) => {
  // Jika sudah verified, langsung return true
  if (userData.verified === true) {
    return { isVerified: true };
  }

  // --- LOGIC COOLDOWN ---
  const lastSent = userData.lastVerifyEmailSentAt
    ? userData.lastVerifyEmailSentAt.toMillis()
    : 0;
  const now = Date.now();
  const cooldownMs = 5 * 60 * 1000; // 5 Menit

  if (now - lastSent < cooldownMs) {
    const remainingSeconds = Math.ceil((cooldownMs - (now - lastSent)) / 1000);
    return {
      isVerified: false,
      errorData: {
        status: 403,
        message: "Akun belum diverifikasi.",
        error: "EMAIL_COOLDOWN",
        info: `Email verifikasi sudah dikirim. Harap tunggu ${remainingSeconds} detik sebelum meminta ulang.`,
        remainingSeconds: remainingSeconds,
      },
    };
  }

  // --- PROSES KIRIM EMAIL ---
  const verifyToken = crypto.randomBytes(20).toString("hex");
  const tokenExpires = Date.now() + 3600000; // 1 Jam

  // Update DB
  await userRef.update({
    verifyToken: verifyToken,
    verifyTokenExpires: tokenExpires,
    lastVerifyEmailSentAt: Timestamp.now(),
  });

  // Kirim Email (Masuk collection 'mail')
  const linkVerifikasi = `https://api-y4ntpb3uvq-et.a.run.app/api/Login/confirm-email?email=${email}&token=${verifyToken}`;

  await db.collection("mail").add({
    to: email,
    message: {
      subject: "Verifikasi Akun Anda",
      html: `
              <h3>Halo, ${userData.username || "User"}</h3>
              <p>Selamat! Akun Anda telah disetujui. Langkah terakhir, silakan verifikasi email Anda:</p>
              <a href="${linkVerifikasi}" style="background:#007bff; color:white; padding:10px 20px; text-decoration:none; border-radius:5px;">Verifikasi Sekarang</a>
              <p>Link berlaku selama 1 jam.</p>
          `,
    },
  });

  return {
    isVerified: false,
    errorData: {
      status: 403,
      message: "Akun belum diverifikasi.",
      error: "EMAIL_NOT_VERIFIED",
      info: "Email verifikasi baru saja dikirim. Silakan cek inbox/spam.",
    },
  };
};

// ==================================================================
// 2. MAIN ROUTE (BERSIH & TERBACA)
// ==================================================================
router.post("/login-google", async (req, res) => {
  try {
    const { idToken, deviceId, deviceInfo } = req.body;

    // --- A. Validasi Input ---
    if (!idToken)
      return res.status(400).json({ message: "Google ID Token diperlukan." });
    if (!deviceId)
      return res
        .status(400)
        .json({ message: "Device ID diperlukan untuk keamanan." });

    // --- B. Verifikasi Token Google ---
    let decodedToken;
    try {
      decodedToken = await admin
        .auth()
        .verifyIdToken(idToken.toString().trim());
    } catch (error) {
      return res.status(401).json({ message: "Sesi Google tidak valid." });
    }

    const email = decodedToken.email;
    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();

    // --- C. Cek User Exists ---
    if (!userDoc.exists) {
      return res
        .status(404)
        .json({ message: "Akun tidak ditemukan. Silakan registrasi dulu." });
    }

    const data = userDoc.data();

    // --- D. Cek Status & Role (Panggil Helper) ---
    const statusError = checkUserStatus(data);
    if (statusError) {
      return res.status(403).json({ message: statusError });
    }

    // --- E. Cek Keamanan Device (Panggil Helper Anti-Curang) ---
    const deviceCheck = await checkDeviceSecurity(db, email, data, deviceId);
    if (!deviceCheck.allowed) {
      const { status, ...errJson } = deviceCheck.errorData;
      return res.status(status).json(errJson);
    }

    // --- F. Cek Verifikasi Email (Panggil Helper Email) ---
    const emailCheck = await handleEmailVerification(db, userRef, data, email);
    if (!emailCheck.isVerified) {
      const { status, ...errJson } = emailCheck.errorData;
      return res.status(status).json(errJson);
    }

    // ==============================================================
    // SUKSES: Update DB & Generate Token
    // ==============================================================

    // Update data login terakhir & kunci device
    await userRef.update({
      lastLogin: Timestamp.now(),
      currentDeviceId: deviceId,
      deviceInfo: deviceInfo || "Unknown",
    });

    const tokenPayload = {
      id: email,
      role: data.role,
      idCompany: data.idCompany,
      status: data.status,
      deviceId: deviceId, // Token terikat ke device ini
    };

    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });

    return res.status(200).json({
      message: "Login Berhasil",
      token: token,
      user: {
        email: email,
        role: data.role,
        nama: data.username,
      },
    });
  } catch (e) {
    console.error("Login Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

// ---------------------------------------------------------
// CONFIRM EMAIL (Link Click Handler)
// ---------------------------------------------------------
router.get("/confirm-email", async (req, res) => {
  try {
    const { email, token } = req.query;

    if (!email || !token) {
      return res.status(400).send("Link tidak valid (data kurang).");
    }

    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).send("User tidak ditemukan.");
    }

    const data = userDoc.data();

    // 1. Validasi Token
    if (data.verifyToken !== token) {
      return res
        .status(400)
        .send("Link verifikasi salah atau sudah tidak valid.");
    }

    // 2. Validasi Expired
    if (data.verifyTokenExpires < Date.now()) {
      return res
        .status(400)
        .send(
          "Link verifikasi sudah kadaluarsa. Silakan login ulang untuk minta link baru."
        );
    }

    // 3. Sukses -> Update User jadi Verified
    // Hapus juga tokennya biar gak bisa dipake 2x
    await userRef.update({
      verified: true,
      verifyToken: admin.firestore.FieldValue.delete(),
      verifyTokenExpires: admin.firestore.FieldValue.delete(),
    });

    // 4. Tampilkan Halaman HTML sederhana
    res.send(`
      <html>
        <body style="text-align:center; padding-top:50px; font-family:sans-serif;">
          <h1 style="color:green;">Verifikasi Berhasil!</h1>
          <p>Akun Anda (${email}) sudah aktif.</p>
          <p>Silakan kembali ke aplikasi untuk Login.</p>
        </body>
      </html>
    `);
  } catch (e) {
    console.error("Confirm Email Error:", e);
    res.status(500).send("Terjadi kesalahan server.");
  }
});

// Helper Function: Membuat kode acak
// Kita hindari huruf 'I', 'O' dan angka '0', '1' agar tidak membingungkan user
function generateCompanyCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result; // Contoh output: "K9X2M4" atau "TR5W22"
}

// ---------------------------------------------------------
// REGISTRASI PERUSAHAAN (Via Google Sign-In) + Activity Log
// ---------------------------------------------------------
router.post("/registrasi", async (req, res) => {
  // LOG PERTAMA: Membuktikan request masuk ke kode ini
  console.log(">>> [START] Request Registrasi Masuk!");

  try {
    let idToken = "";

    // CARA 1: Cek Authorization Header (Standar API - Recommended)
    // Format: "Bearer eyJhbGci..."
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer ")
    ) {
      console.log(">>> Token ditemukan di Header");
      idToken = req.headers.authorization.split("Bearer ")[1];
    }
    // CARA 2: Cek Body (Backup)
    else if (req.body.idToken) {
      console.log(">>> Token ditemukan di Body");
      idToken = req.body.idToken;
    }

    // Validasi Kelengkapan Data Lainnya
    const { namaPerusahaan, alamatLoc, noTelp, noWA } = req.body;

    if (!idToken || !namaPerusahaan || !alamatLoc || !noTelp) {
      console.log(">>> GAGAL: Data tidak lengkap");
      return res.status(400).json({
        message: "Data tidak lengkap. Token atau field lain kosong.",
        received: { tokenExists: !!idToken, namaPerusahaan, alamatLoc },
      });
    }

    // Bersihkan token
    const tokenClean = idToken.toString().trim();

    // Verifikasi ke Firebase
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(tokenClean);
      console.log(">>> SUKSES: Token Valid untuk email:", decodedToken.email);
    } catch (error) {
      console.error(">>> GAGAL VERIFIKASI:", error);
      // PENTING: Return error detail biar kita tau salahnya dimana
      return res.status(401).json({
        message: "TOKEN DITOLAK FIREBASE",
        debug_info: {
          error_code: error.code,
          error_message: error.message,
          token_snippet: tokenClean.substring(0, 10) + "...", // Cek apakah tokennya kebaca
        },
      });
    }

    // --- MULAI LOGIKA BISNIS ---
    const email = decodedToken.email;
    const uid = decodedToken.uid;
    const username = decodedToken.name || email.split("@")[0];
    const photoURL = decodedToken.picture || "";

    // Generate ID Company
    let idCompany = "";
    let isUnique = false;
    let attempt = 0;

    while (!isUnique && attempt < 5) {
      const randomCode = generateCompanyCode(5);
      idCompany = `C${randomCode}`;
      const checkDoc = await db.collection("companies").doc(idCompany).get();
      if (!checkDoc.exists) isUnique = true;
      attempt++;
    }

    if (!isUnique)
      return res.status(500).json({ message: "Gagal generate ID Perusahaan." });

    // Transaction Firestore
    await db.runTransaction(async (transaction) => {
      const userRef = db.collection("users").doc(email);
      const userDoc = await transaction.get(userRef);

      if (userDoc.exists) throw new Error("USER_EXISTS");

      const companyRef = db.collection("companies").doc(idCompany);

      const companyData = {
        idCompany,
        namaPerusahaan,
        alamatLoc,
        totalLike: 0,
        createdAt: Timestamp.now(),
        createdBy: email,
        ownerUid: uid,
      };

      const userData = {
        uid,
        username,
        alamatEmail: email,
        photoURL,
        noTelp,
        noWA: noWA || noTelp,
        role: "admin",
        idCompany,
        companyName: namaPerusahaan,
        createdAt: Timestamp.now(),
        status: "active",
        verified: false,
        authProvider: "google",
      };

      transaction.set(companyRef, companyData);
      transaction.set(userRef, userData);
    });

    // --- TAMBAHAN: LOG AKTIFITAS COMPANY ---
    // Karena ini adalah "Event Pertama" dari perusahaan (Pendaftaran),
    // Kita catat bahwa Admin ini yang mendirikannya.
    await logCompanyActivity(idCompany, {
      actorEmail: email,
      actorName: username,
      target: idCompany,
      action: "REGISTER_COMPANY",
      description: `User ${username} mendaftarkan perusahaan baru: ${namaPerusahaan}`,
    });

    return res.status(200).json({
      message: "Registrasi Berhasil",
      data: { companyCode: idCompany, companyName: namaPerusahaan },
    });
  } catch (e) {
    console.error(">>> SERVER ERROR:", e);
    if (e.message === "USER_EXISTS") {
      return res
        .status(400)
        .json({ message: "Email ini sudah terdaftar sebagai user lain." });
    }
    return res.status(500).json({
      message: "Server Error",
      error: e.message,
    });
  }
});

// ---------------------------------------------------------
// REGISTER PEGAWAI (Via Google Sign-In)
// ---------------------------------------------------------
router.post("/register-employee", async (req, res) => {
  try {
    // 1. Ambil data Form & Token dari Body
    // Kita TIDAK butuh 'email' atau 'username' dari body, karena itu diambil dari Google Token
    const { idToken, idCompany, noTelp, noWa } = req.body;

    // A. Validasi Input Dasar
    if (!idToken || !idCompany || !noTelp) {
      return res.status(400).json({
        message:
          "Data tidak lengkap. Harap sertakan Google Token, ID Company, dan No Telepon.",
      });
    }

    // B. VERIFIKASI TOKEN GOOGLE (CRUCIAL STEP)
    // Ini memastikan user benar-benar login, dan kita dapat data asli dari Google
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (error) {
      console.error("Token verification failed:", error);
      return res
        .status(401)
        .json({ message: "Sesi Google tidak valid atau kadaluarsa." });
    }

    // Ambil data user dari hasil decode token
    const email = decodedToken.email;
    const username = decodedToken.name || email.split("@")[0]; // Pakai nama google, atau potong email jika kosong
    const photoURL = decodedToken.picture || ""; // Ambil foto profil Google
    const uid = decodedToken.uid; // UID dari Firebase Auth

    // 2. Cek Validitas Perusahaan (Sama seperti kodemu sebelumnya)
    const companyDoc = await db.collection("companies").doc(idCompany).get();
    if (!companyDoc.exists) {
      return res.status(404).json({ message: "ID Perusahaan tidak ditemukan" });
    }
    const companyName = companyDoc.data().namaPerusahaan;

    // 3. Cek Status User di Database (Firestore)
    const userRef = db.collection("users").doc(email); // Bisa pakai doc(uid) atau doc(email) tergantung strukturmu
    const userDoc = await userRef.get();

    if (userDoc.exists) {
      const data = userDoc.data();

      // Jika user sudah terdaftar sebagai pegawai aktif atau admin, tolak
      if (["admin", "staff", "employee"].includes(data.role)) {
        return res.status(400).json({
          message:
            "Email akun Google ini sudah terdaftar sebagai pegawai aktif.",
        });
      }

      // Jika user statusnya 'candidate' (sedang menunggu), tolak double register
      if (data.role === "candidate") {
        return res.status(400).json({
          message: "Pendaftaran Anda sedang menunggu konfirmasi Admin.",
        });
      }
    }

    // 4. Simpan / Update Data User
    const userData = {
      uid: uid, // Simpan UID firebase auth juga
      username: username, // Dari Google
      alamatEmail: email, // Dari Google (pasti valid)
      photoURL: photoURL, // Dari Google
      noTelp: noTelp, // Dari Form
      noWa: noWa || noTelp, // Dari Form (jika kosong, samakan dgn noTelp)
      idCompany: idCompany,
      companyName: companyName,
      role: "candidate", // Tetap candidate
      status: "pending_approval",
      createdAt: Timestamp.now(),

      // Karena login pakai Google, email otomatis verified.
      // Tapi 'verified' di sini mungkin maksudmu 'verified by company admin'.
      // Jadi biarkan false atau sesuaikan logika aplikasimu.
      verified: false, // Saran: True karena email google pasti asli. Tinggal approval admin company.
      authProvider: "google", // Penanda login pakai google
    };

    // Gunakan set({merge: true})
    await userRef.set(userData, { merge: true });

    return res.status(200).json({
      message: "Pendaftaran berhasil dikirim",
      info: "Silakan hubungi Admin perusahaan untuk konfirmasi akun Anda.",
      user: { email, username, role: "candidate" }, // Opsional: kembalikan data user
    });
  } catch (e) {
    console.error("Reg Employee Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

// ==================================================================
// 3. ROUTE: REQUEST RESET DEVICE (USER -> EMAIL ADMIN)
// ==================================================================
router.post("/request-reset-device", async (req, res) => {
  try {
    const { idToken, reason } = req.body;

    if (!idToken)
      return res.status(400).json({ message: "Google ID Token diperlukan." });
    if (!reason)
      return res.status(400).json({ message: "Alasan reset wajib diisi." });

    // A. Verifikasi Identitas User (via Google Token)
    let decodedToken;
    try {
      decodedToken = await admin
        .auth()
        .verifyIdToken(idToken.toString().trim());
    } catch (error) {
      return res.status(401).json({ message: "Sesi Google tidak valid." });
    }

    const email = decodedToken.email;
    const userDoc = await db.collection("users").doc(email).get();

    if (!userDoc.exists)
      return res.status(404).json({ message: "User tidak ditemukan." });

    const userData = userDoc.data();
    const idCompany = userData.idCompany;

    if (!idCompany)
      return res
        .status(400)
        .json({ message: "User tidak terdaftar di perusahaan." });

    // B. Cari Email Admin
    const companyDoc = await db.collection("companies").doc(idCompany).get();
    if (!companyDoc.exists)
      return res.status(404).json({ message: "Perusahaan tidak ditemukan." });
    const adminEmail = companyDoc.data().createdBy;

    if (!adminEmail)
      return res
        .status(500)
        .json({ message: "Email admin perusahaan tidak ditemukan." });

    // C. Generate Token Khusus untuk Link Reset (Berlaku 3 Hari)
    // Token ini berisi 'action' khusus agar tidak bisa dipakai login biasa
    const resetActionToken = jwt.sign(
      {
        action: "RESET_DEVICE_CONFIRMATION", // Marker khusus
        targetUserEmail: email, // Siapa yang mau direset
        companyId: idCompany, // Security tambahan
      },
      process.env.JWT_SECRET,
      { expiresIn: "3d" }
    );

    // Link yang akan diklik Admin (GET Request)
    // GANTI BASE URL SESUAI URL PROJECT FIREBASE FUNCTION KAMU
    const baseUrl = "https://api-y4ntpb3uvq-et.a.run.app/";
    const resetLink = `${baseUrl}/api/Login/admin/confirm-reset-device?token=${resetActionToken}`;

    // D. Kirim Email ke Admin
    await db.collection("mail").add({
      to: adminEmail,
      message: {
        subject: `ACTION REQUIRED: Reset Device Request - ${userData.username}`,
        html: `
                  <div style="font-family: sans-serif; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
                      <h2 style="color: #d32f2f;">Permohonan Reset Perangkat</h2>
                      <p>Halo Admin,</p>
                      <p>Pegawai Anda <b>${
                        userData.username
                      }</b> (${email}) meminta izin untuk login menggunakan perangkat baru.</p>
                      
                      <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
                          <strong>Alasan:</strong><br>
                          "${reason}"
                          <br><br>
                          <strong>Perangkat Lama:</strong><br>
                          ${userData.deviceInfo || "Unknown Device"}
                      </div>

                      <p>Jika Anda menyetujui, silakan klik tombol di bawah ini. Device lama akan dihapus dari sistem, dan user dapat login di device baru.</p>

                      <a href="${resetLink}" style="background-color: #d32f2f; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
                          SETUJUI & RESET DEVICE
                      </a>

                      <p style="margin-top: 20px; font-size: 12px; color: #666;">
                          Link ini aman dan hanya berlaku selama 3 hari. Jangan bagikan email ini ke orang lain.
                      </p>
                  </div>
              `,
      },
    });

    // --- LOG ACTIVITY: REQUEST ---
    await logCompanyActivity(idCompany, {
      actorEmail: email,
      actorName: userData.username,
      target: "Admin",
      action: "REQUEST_RESET_DEVICE",
      description: `User requesting device reset. Reason: ${reason}`,
    });

    return res.status(200).json({
      message: "Permohonan terkirim ke Admin.",
      info: "Silakan tunggu persetujuan Admin via Email.",
    });
  } catch (e) {
    console.error("Request Reset Error:", e);
    return res.status(500).json({ message: "Gagal mengirim permohonan." });
  }
});

// ==================================================================
// 4. ROUTE: CONFIRM RESET DEVICE (LINK DARI EMAIL)
// ==================================================================
// Ini endpoint GET karena diklik dari email (browser link)
router.get("/admin/confirm-reset-device", async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).send("<h1>Error: Token tidak ditemukan.</h1>");
    }

    // 1. Verifikasi Token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res
        .status(403)
        .send("<h1>Error: Link kadaluarsa atau tidak valid.</h1>");
    }

    // 2. Cek apakah ini benar token reset device
    if (decoded.action !== "RESET_DEVICE_CONFIRMATION") {
      return res
        .status(403)
        .send("<h1>Error: Token tidak valid untuk aksi ini.</h1>");
    }

    const { targetUserEmail, companyId } = decoded;

    // 3. Eksekusi Reset di Database
    const targetUserRef = db.collection("users").doc(targetUserEmail);
    const docSnap = await targetUserRef.get();

    if (!docSnap.exists) {
      return res
        .status(404)
        .send("<h1>Error: User sudah tidak terdaftar.</h1>");
    }

    await targetUserRef.update({
      currentDeviceId: null,
      // deviceInfo: admin.firestore.FieldValue.delete(), // Opsional
      lastResetBy: "EmailConfirmation",
      lastResetAt: Timestamp.now(),
    });

    // --- LOG ACTIVITY: APPROVED ---
    // Kita coba cari email admin dari company doc (agar log lebih rapi),
    // tapi kalau gagal kita set default.
    let adminEmailForLog = "system";
    let adminNameForLog = "Admin (via Email)";

    try {
      if (companyId) {
        const compSnap = await db.collection("companies").doc(companyId).get();
        if (compSnap.exists) {
          adminEmailForLog = compSnap.data().createdBy || "system";
        }
      }
    } catch (err) {
      console.error("Log fetch error:", err);
    }

    await logCompanyActivity(companyId, {
      actorEmail: adminEmailForLog,
      actorName: adminNameForLog,
      target: targetUserEmail,
      action: "RESET_DEVICE_APPROVED",
      description: `Device binding reset confirmed via email link for user ${targetUserEmail}.`,
    });

    // 4. Tampilkan Halaman Sukses Sederhana
    const successHtml = `
          <!DOCTYPE html>
          <html>
          <head>
              <title>Reset Berhasil</title>
              <style>
                  body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #f0f2f5; margin: 0; }
                  .card { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
                  h1 { color: #2e7d32; }
                  p { color: #555; line-height: 1.6; }
                  .icon { font-size: 60px; margin-bottom: 20px; }
              </style>
          </head>
          <body>
              <div class="card">
                  <div class="icon">✅</div>
                  <h1>Reset Berhasil!</h1>
                  <p>Binding perangkat untuk user <b>${targetUserEmail}</b> telah dihapus.</p>
                  <p>User sekarang dapat login menggunakan perangkat baru mereka.</p>
                  <br>
                  <small>Anda dapat menutup halaman ini.</small>
              </div>
          </body>
          </html>
      `;

    res.status(200).send(successHtml);
  } catch (e) {
    console.error("Confirm Reset Error:", e);
    res.status(500).send("<h1>Terjadi kesalahan server.</h1>");
  }
});
module.exports = router;
