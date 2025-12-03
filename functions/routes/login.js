/* eslint-disable */
require("dotenv").config();
const express = require("express");
const jwt = require("jsonwebtoken");
const Busboy = require("busboy");
const path = require("path");
const { Timestamp } = require("firebase-admin/firestore");
const { db, bucket } = require("../config/firebase");

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

// ---------------------------------------------------------
// VERIFY ACCOUNT [internal]
// ---------------------------------------------------------
router.get("/verifyaccount", async (req, res) => {
  try {
    const horauser = req.query.horauser;
    if (!horauser)
      return res.status(400).json({ message: "'horauser' wajib diisi" });

    return res.status(200).json({ message: "Akun terverifikasi" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

// ---------------------------------------------------------
// PILIH PAKET
// ---------------------------------------------------------
router.post("/pilihpaket", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer "))
      return res.status(401).json({ message: "Token tidak valid" });

    const data = req.body;
    if (!data.idperusahaan)
      return res.status(400).json({ message: "idperusahaan wajib diisi" });

    await db
      .collection("packages")
      .doc(data.idperusahaan)
      .set(data, { merge: true });

    return res.status(200).json("Upload Bukti Bayar");
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ message: "Gagal menyimpan paket", error: e.message });
  }
});

// ---------------------------------------------------------
// UPLOAD BUKTI BAYAR
// ---------------------------------------------------------
router.put("/uploadbukti", (req, res) => {
  const busboy = Busboy({ headers: req.headers });

  const fields = {};
  let fileBuffer = null;
  let fileMime = null;
  let fileName = null;

  busboy.on("field", (fieldname, val) => {
    fields[fieldname] = val;
  });

  busboy.on("file", (fieldname, file, info) => {
    const { mimeType, filename } = info;
    fileMime = mimeType;
    fileName = filename;
    const chunks = [];

    file.on("data", (data) => chunks.push(data));
    file.on("end", () => {
      fileBuffer = Buffer.concat(chunks);
    });
  });

  busboy.on("error", (err) => {
    console.error("Busboy Error:", err);
    return res
      .status(500)
      .json({ message: "Gagal mengurai form data", error: err.message });
  });

  busboy.on("finish", async () => {
    try {
      const NamaPerusahaan = fields.NamaPerusahaan;
      const IDPerusahaan = fields.IDPerusahaan;

      if (!NamaPerusahaan)
        return res.status(400).json({ message: "NamaPerusahaan wajib diisi" });
      if (!IDPerusahaan)
        return res.status(400).json({ message: "IDPerusahaan wajib diisi" });
      if (!fileBuffer)
        return res.status(400).json({ message: "Foto wajib diupload" });
      if (!fileMime.startsWith("image/"))
        return res.status(400).json({ message: "Harus file gambar" });

      const timestamp = Date.now();
      const ext =
        path.extname(fileName || "").toLowerCase() ||
        `.${fileMime.split("/")[1]}`;
      const filePath = `bukti-bayar/${IDPerusahaan}_${timestamp}${ext}`;

      const fileStorage = bucket.file(filePath);
      await fileStorage.save(fileBuffer, {
        metadata: { contentType: fileMime },
        public: true,
      });
      const url = fileStorage.publicUrl();

      await db.collection("bukti_bayar").doc(IDPerusahaan).set(
        {
          idPerusahaan: IDPerusahaan,
          namaPerusahaan: NamaPerusahaan,
          fotoURL: url,
          filename: filePath,
          uploadedAt: Timestamp.now(),
          status: "pending",
        },
        { merge: true }
      );

      return res.status(200).json({
        message: "Bukti bayar berhasil diupload",
        fotoURL: url,
      });
    } catch (err) {
      console.error("Upload process error:", err);
      return res
        .status(500)
        .json({ message: "Gagal upload", error: err.message });
    }
  });

  busboy.end(req.rawBody);
});

// ---------------------------------------------------------
// REGISTRASI (Company Registration)
// ---------------------------------------------------------
router.post("/registrasi", async (req, res) => {
  try {
    const data = req.body;

    // 1. Validasi Input
    // Kita pisahkan field mana untuk user, mana untuk company
    const requiredFields = [
      "namaPerusahaan",
      "alamatLoc",
      "alamatEmail",
      "noTelp",
      "noWA",
    ];

    const missingFields = requiredFields.filter((field) => !data[field]);

    if (missingFields.length > 0) {
      return res.status(400).json({
        message: `Field wajib diisi: ${missingFields.join(", ")}`,
      });
    }

    // 2. Jalankan Transaction untuk konsistensi data
    // Menggunakan transaction agar User dan Company terbuat bersamaan.
    // Jika satu gagal, semua batal.
    await db.runTransaction(async (transaction) => {
      // A. Cek apakah email user sudah ada di collection 'users'
      // Kita asumsikan Email dijadikan ID User (atau bisa pakai UID dari Auth)
      const userRef = db.collection("users").doc(data.alamatEmail);
      const userDoc = await transaction.get(userRef);

      if (userDoc.exists) {
        throw new Error("EMAIL_EXISTS");
      }

      // B. Siapkan Referensi untuk Company Baru
      // Ini akan otomatis membuat ID unik untuk Company (idCompany)
      const companyRef = db.collection("companies").doc();
      const idCompany = companyRef.id;

      // C. Siapkan Data Company
      const companyData = {
        idCompany: idCompany, // Simpan ID di dalam dokumen juga agar mudah diambil
        namaPerusahaan: data.namaPerusahaan,
        alamatLoc: data.alamatLoc,
        totalLike: data.totalLike || 0,
        createdAt: Timestamp.now(),
        createdBy: data.alamatEmail, // Track siapa yang buat
      };

      // D. Siapkan Data User (ADMIN)
      const userData = {
        alamatEmail: data.alamatEmail,
        noTelp: data.noTelp,
        noWA: data.noWA,
        role: "admin", // <--- SET SEBAGAI ADMIN DISINI
        idCompany: idCompany, // <--- LINK KE COMPANY DISINI
        companyName: data.namaPerusahaan, // Opsional: cache nama PT biar ga perlu join query nanti
        createdAt: Timestamp.now(),
        status: "pending", // Status user, misal pending verifikasi email
        invited: false, // False karena dia yang register (pendiri)
        verified: false,
      };

      // E. Eksekusi Simpan Data
      transaction.set(companyRef, companyData);
      transaction.set(userRef, userData);
    });

    // 3. Response Sukses
    return res.status(200).json({
      message: "Registrasi Perusahaan & Admin Berhasil",
      info: "Silakan Login & Verifikasi email anda",
    });
  } catch (e) {
    console.error("Registrasi error:", e);

    // Handling error spesifik dari transaction
    if (e.message === "EMAIL_EXISTS") {
      return res
        .status(400)
        .json({ message: "Email sudah terdaftar sebagai user lain." });
    }

    return res.status(500).json({
      message: "Gagal melakukan registrasi",
      error: e.message,
    });
  }
});

// ---------------------------------------------------------
// REGISTER PEGAWAI (Apply Job)
// ---------------------------------------------------------
router.post("/register-employee", async (req, res) => {
  try {
    const { email, username, idCompany, noTelp } = req.body;

    // 1. Validasi Input
    // Tambahkan !noTelp agar wajib diisi
    if (!email || !idCompany || !username || !noTelp) {
      return res
        .status(400)
        .json({
          message:
            "Data tidak lengkap. Harap isi Email, Username, ID Company, dan No Telepon.",
        });
    }

    // 2. Cek Validitas Perusahaan
    const companyDoc = await db.collection("companies").doc(idCompany).get();
    if (!companyDoc.exists) {
      return res.status(404).json({ message: "ID Perusahaan tidak ditemukan" });
    }
    const companyName = companyDoc.data().namaPerusahaan;

    // 3. Cek Status User di Database
    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();

    if (userDoc.exists) {
      const data = userDoc.data();

      // Jika user sudah terdaftar sebagai pegawai aktif atau admin, tolak
      if (["admin", "staff", "employee"].includes(data.role)) {
        return res
          .status(400)
          .json({
            message: "Email ini sudah terdaftar sebagai pegawai aktif.",
          });
      }

      // Jika user statusnya 'candidate' (sedang menunggu), tolak double register
      if (data.role === "candidate") {
        return res
          .status(400)
          .json({
            message: "Pendaftaran Anda sedang menunggu konfirmasi Admin.",
          });
      }

      // Jika status 'rejected', kita BOLEHKAN dia update data (Daftar Ulang)
      // Lanjut ke bawah...
    }

    // 4. Simpan / Update Data User sebagai 'candidate'
    const userData = {
      username: username,
      alamatEmail: email,
      noTelp: noTelp, // Sekarang wajib, jadi pasti ada isinya
      idCompany: idCompany,
      companyName: companyName,
      role: "candidate", // <--- Role sementara: MENUNGGU ACC
      status: "pending_approval",
      createdAt: Timestamp.now(),
      verified: false, // Email belum verified (tunggu login OTP nanti)
      otp: null,
    };

    // Gunakan set({merge: true}) agar jika dia daftar ulang (setelah ditolak), data lama tertimpa
    await userRef.set(userData, { merge: true });

    return res.status(200).json({
      message: "Pendaftaran berhasil dikirim",
      info: "Silakan hubungi Admin perusahaan untuk konfirmasi akun Anda.",
    });
  } catch (e) {
    console.error("Reg Employee Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

// ---------------------------------------------------------
// ADMIN APPROVAL (Acc / Reject Pegawai)
// ---------------------------------------------------------
router.post("/verify-employee", async (req, res) => {
  try {
    // Input: adminEmail (yang nge-acc), targetEmail (calon pegawai), action (true/false)
    const { adminEmail, targetEmail, approved } = req.body;

    // 1. Cek Admin (Security Check)
    // Pastikan yang melakukan request adalah Admin dari perusahaan yang sama
    const adminDoc = await db.collection("users").doc(adminEmail).get();
    if (!adminDoc.exists || adminDoc.data().role !== "admin") {
      return res
        .status(403)
        .json({ message: "Hanya Admin yang boleh melakukan ini" });
    }
    const adminCompanyId = adminDoc.data().idCompany;

    // 2. Cek User Target
    const targetRef = db.collection("users").doc(targetEmail);
    const targetDoc = await targetRef.get();

    if (!targetDoc.exists) {
      return res.status(404).json({ message: "User tidak ditemukan" });
    }

    // Pastikan user target mendaftar di perusahaan yang SAMA dengan admin
    if (targetDoc.data().idCompany !== adminCompanyId) {
      return res
        .status(400)
        .json({ message: "User ini tidak mendaftar di perusahaan Anda" });
    }

    // 3. Eksekusi Approval / Rejection
    if (approved) {
      // JIKA DITERIMA
      await targetRef.update({
        role: "staff", // Ubah jadi Role Pegawai RESMI
        status: "active",
        approvedAt: Timestamp.now(),
        approvedBy: adminEmail,
      });
      return res
        .status(200)
        .json({ message: `Pegawai ${targetEmail} berhasil diterima.` });
    } else {
      // JIKA DITOLAK
      await targetRef.update({
        role: "rejected", // Role khusus indikasi penolakan
        status: "rejected",
        rejectedAt: Timestamp.now(),
        rejectedBy: adminEmail,
        // Kita TIDAK menghapus datanya, supaya user tau dia ditolak saat mencoba login
        // Tapi idCompany tetap ada, history tetap ada.
      });
      return res
        .status(200)
        .json({ message: `Pegawai ${targetEmail} telah ditolak.` });
    }
  } catch (e) {
    console.error("Verify Employee Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});
// ---------------------------------------------------------
// GET PAKET (List All Available Packages)
// ---------------------------------------------------------
router.get("/getpaket", async (req, res) => {
  try {
    const packagesSnapshot = await db.collection("packages").get();

    if (packagesSnapshot.empty) {
      return res.status(200).json([]);
    }

    const packages = packagesSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.status(200).json(packages);
  } catch (e) {
    console.error("Get paket error:", e);
    return res.status(500).json({
      message: "Gagal mengambil data paket",
      error: e.message,
    });
  }
});

module.exports = router;
