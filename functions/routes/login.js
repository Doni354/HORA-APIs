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

// ---------------------------------------------------------
// LOGIN GOOGLE (Logic Baru: Role Check Dulu -> Baru Verify)
// ---------------------------------------------------------
router.post("/login-google", async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ message: "Google ID Token diperlukan." });

    // 1. Verifikasi Token Google
    let decodedToken;
    try {
      // Pastikan token bersih dari spasi
      decodedToken = await admin.auth().verifyIdToken(idToken.toString().trim());
    } catch (error) {
      return res.status(401).json({ message: "Sesi Google tidak valid." });
    }

    const email = decodedToken.email;
    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();

    // 2. Cek User Terdaftar
    if (!userDoc.exists) {
      return res.status(404).json({ message: "Akun tidak ditemukan. Silakan registrasi dulu." });
    }

    const data = userDoc.data();

    // ------------------------------------------------------------------
    // TAHAP 1: CEK STATUS & ROLE TERLEBIH DAHULU (PRIORITAS UTAMA)
    // ------------------------------------------------------------------
    
    // Cek Status Akun (Inactive/Banned)
    if (data.status === "inactive" || data.status === "banned") {
      return res.status(403).json({ message: "Akun dinonaktifkan oleh sistem." });
    }

    // Cek Role Candidate (Masih Menunggu)
    if (data.role === "candidate") {
      return res.status(403).json({ message: "Akun sedang menunggu persetujuan Admin." });
    }

    // Cek Role Rejected (Ditolak)
    if (data.role === "rejected") {
      return res.status(403).json({ message: "Lamaran Anda ditolak, silakan daftar kembali." });
    }

    // ------------------------------------------------------------------
    // TAHAP 2: CEK VERIFIKASI EMAIL (Hanya untuk Admin / Staff)
    // ------------------------------------------------------------------
    // Kode ini hanya akan dieksekusi jika user BUKAN candidate/rejected/banned
    if (data.verified === false) {
      
      // --- UPDATE: CEK COOLDOWN PENGIRIMAN EMAIL ---
      const lastSent = data.lastVerifyEmailSentAt ? data.lastVerifyEmailSentAt.toMillis() : 0;
      const now = Date.now();
      const cooldownMs = 5 * 60 * 1000; // 5 Menit (dalam milidetik)

      // Jika belum 5 menit sejak pengiriman terakhir, tolak request pengiriman baru
      if (now - lastSent < cooldownMs) {
        // Hitung sisa waktu (untuk info debug/frontend)
        const remainingSeconds = Math.ceil((cooldownMs - (now - lastSent)) / 1000);
        
        return res.status(403).json({
          message: "Akun belum diverifikasi.",
          error: "EMAIL_COOLDOWN", // Error code khusus biar FE tau
          info: `Email verifikasi sudah dikirim. Harap tunggu ${remainingSeconds} detik sebelum meminta ulang.`,
          remainingSeconds: remainingSeconds
        });
      }

      // A. Generate Token Verifikasi Baru
      const verifyToken = crypto.randomBytes(20).toString("hex"); 
      const tokenExpires = Date.now() + 3600000; // 1 Jam

      // B. Update DB (Simpan Token & Timestamp Pengiriman)
      await userRef.update({
        verifyToken: verifyToken,
        verifyTokenExpires: tokenExpires,
        lastVerifyEmailSentAt: Timestamp.now() // <--- Simpan waktu kirim
      });

      // C. Kirim Email
      const linkVerifikasi = `https://api-y4ntpb3uvq-et.a.run.app/api/Login/confirm-email?email=${email}&token=${verifyToken}`;

      await db.collection("mail").add({
        to: email,
        message: {
          subject: "Verifikasi Akun Anda",
          html: `
            <h3>Halo, ${data.username || "User"}</h3>
            <p>Selamat! Akun Anda telah disetujui. Langkah terakhir, silakan verifikasi email Anda:</p>
            <a href="${linkVerifikasi}" style="background:#007bff; color:white; padding:10px 20px; text-decoration:none; border-radius:5px;">Verifikasi Sekarang</a>
            <p>Link berlaku selama 1 jam.</p>
          `,
        },
      });

      // D. Return Error 403
      return res.status(403).json({
        message: "Akun belum diverifikasi.",
        error: "EMAIL_NOT_VERIFIED",
        info: "Email verifikasi baru saja dikirim. Silakan cek inbox/spam."
      });
    }

    // ------------------------------------------------------------------
    // TAHAP 3: LOLOS SEMUA -> GENERATE JWT
    // ------------------------------------------------------------------
    const tokenPayload = {
      id: email,
      role: data.role,
      idCompany: data.idCompany,
      status: data.status,
    };

    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: "30d" });

    // Update lastLogin
    await userRef.update({ lastLogin: Timestamp.now() });

    return res.status(200).json({
      message: "Login Berhasil",
      token: token,
      user: {
        email: email,
        role: data.role,
        nama: data.username
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
      return res.status(400).send("Link verifikasi salah atau sudah tidak valid.");
    }

    // 2. Validasi Expired
    if (data.verifyTokenExpires < Date.now()) {
      return res.status(400).send("Link verifikasi sudah kadaluarsa. Silakan login ulang untuk minta link baru.");
    }

    // 3. Sukses -> Update User jadi Verified
    // Hapus juga tokennya biar gak bisa dipake 2x
    await userRef.update({
      verified: true,
      verifyToken: admin.firestore.FieldValue.delete(),
      verifyTokenExpires: admin.firestore.FieldValue.delete()
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
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      console.log(">>> Token ditemukan di Header");
      idToken = req.headers.authorization.split('Bearer ')[1];
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
        received: { tokenExists: !!idToken, namaPerusahaan, alamatLoc }
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
            token_snippet: tokenClean.substring(0, 10) + "..." // Cek apakah tokennya kebaca
        }
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

    if (!isUnique) return res.status(500).json({ message: "Gagal generate ID Perusahaan." });

    // Transaction Firestore
    await db.runTransaction(async (transaction) => {
      const userRef = db.collection("users").doc(email);
      const userDoc = await transaction.get(userRef);

      if (userDoc.exists) throw new Error("USER_EXISTS");

      const companyRef = db.collection("companies").doc(idCompany);
      
      const companyData = {
        idCompany, namaPerusahaan, alamatLoc, totalLike: 0,
        createdAt: Timestamp.now(), createdBy: email, ownerUid: uid,
      };

      const userData = {
        uid, username, alamatEmail: email, photoURL, noTelp, noWA: noWA || noTelp,
        role: "admin", idCompany, companyName: namaPerusahaan,
        createdAt: Timestamp.now(), status: "active", verified: false, authProvider: "google"
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
        description: `User ${username} mendaftarkan perusahaan baru: ${namaPerusahaan}`
    });

    return res.status(200).json({
      message: "Registrasi Berhasil",
      data: { companyCode: idCompany, companyName: namaPerusahaan }
    });

  } catch (e) {
    console.error(">>> SERVER ERROR:", e);
    if (e.message === "USER_EXISTS") {
      return res.status(400).json({ message: "Email ini sudah terdaftar sebagai user lain." });
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
        message: "Data tidak lengkap. Harap sertakan Google Token, ID Company, dan No Telepon.",
      });
    }

    // B. VERIFIKASI TOKEN GOOGLE (CRUCIAL STEP)
    // Ini memastikan user benar-benar login, dan kita dapat data asli dari Google
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (error) {
      console.error("Token verification failed:", error);
      return res.status(401).json({ message: "Sesi Google tidak valid atau kadaluarsa." });
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
          message: "Email akun Google ini sudah terdaftar sebagai pegawai aktif.",
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
      uid: uid,             // Simpan UID firebase auth juga
      username: username,   // Dari Google
      alamatEmail: email,   // Dari Google (pasti valid)
      photoURL: photoURL,   // Dari Google
      noTelp: noTelp,       // Dari Form
      noWa: noWa || noTelp, // Dari Form (jika kosong, samakan dgn noTelp)
      idCompany: idCompany,
      companyName: companyName,
      role: "candidate",       // Tetap candidate
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
      user: { email, username, role: "candidate" } // Opsional: kembalikan data user
    });

  } catch (e) {
    console.error("Reg Employee Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});


module.exports = router;
