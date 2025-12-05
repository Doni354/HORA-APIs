/* eslint-disable */
require("dotenv").config();
const express = require("express");
const { Timestamp } = require("firebase-admin/firestore");
const { db, bucket } = require("../config/firebase");
const { verifyToken } = require("../middleware/token");
const { logCompanyActivity } = require("../helper/logCompanyActivity");
const { auth } = require("firebase-admin");
const router = express.Router();

// ---------------------------------------------------------
// ADMIN APPROVAL (Dengan Notifikasi Email + Activity Log)
// ---------------------------------------------------------
router.post("/verify-employee", verifyToken, async (req, res) => {
  try {
    const { targetEmail, approved } = req.body;
    const admin = req.user; // Dari Token (berisi: email, role, idCompany, nama)

    // 1. Cek Admin
    if (admin.role !== "admin") {
      return res
        .status(403)
        .json({ message: "Hanya Admin yang boleh melakukan ini" });
    }

    // 2. Cek Target User
    const targetRef = db.collection("users").doc(targetEmail);
    const targetDoc = await targetRef.get();

    if (!targetDoc.exists) {
      return res.status(404).json({ message: "User tidak ditemukan" });
    }

    const targetData = targetDoc.data();

    // 3. Validasi Perusahaan Sama
    if (targetData.idCompany !== admin.idCompany) {
      return res
        .status(400)
        .json({ message: "User ini tidak mendaftar di perusahaan Anda" });
    }

    // 4. Pastikan statusnya Candidate
    if (targetData.role !== "candidate") {
      return res
        .status(400)
        .json({ message: "User ini bukan kandidat pelamar." });
    }

    // 5. EKSEKUSI APPROVAL / REJECTION
    if (approved) {
      // --- KASUS: DITERIMA ---

      // A. Update DB User
      await targetRef.update({
        role: "staff",
        status: "active",
        approvedAt: Timestamp.now(),
        approvedBy: admin.email,
      });

      // B. KIRIM LOG AKTIFITAS (Company Level)
      // "Admin A menerima pegawai B"
      await logCompanyActivity(admin.idCompany, {
        actorEmail: admin.email,
        actorName: admin.nama, // Pastikan di middleware token kamu menyimpan 'nama'
        target: targetEmail,
        action: "APPROVE_EMPLOYEE",
        description: `Admin ${admin.nama} menerima pegawai baru: ${targetData.username}`,
      });

      // C. KIRIM EMAIL: DITERIMA
      await db.collection("mail").add({
        to: targetEmail,
        message: {
          subject: `Selamat! Anda Diterima di ${
            admin.companyName || "Perusahaan"
          }`,
          html: `
              <h3>Halo, ${targetData.username}</h3>
              <p>Selamat! Lamaran Anda untuk bergabung dengan <b>${
                targetData.companyName || "Perusahaan Kami"
              }</b> telah <b>DISETUJUI</b>.</p>
              <p>Sekarang status akun Anda adalah <b>Karyawan (Staff)</b>.</p>
              <p>Silakan login kembali ke aplikasi.</p>
              <br>
              <p>Salam,<br>Admin HR</p>
            `,
        },
      });

      return res
        .status(200)
        .json({ message: `Pegawai ${targetEmail} berhasil diterima.` });
    } else {
      // --- KASUS: DITOLAK ---

      // A. Update DB User
      await targetRef.update({
        role: "rejected",
        status: "rejected",
        rejectedAt: Timestamp.now(),
        rejectedBy: admin.email,
      });

      // B. KIRIM LOG AKTIFITAS (Company Level)
      // "Admin A menolak pegawai B"
      await logCompanyActivity(admin.idCompany, {
        actorEmail: admin.email,
        actorName: admin.nama,
        target: targetEmail,
        action: "REJECT_EMPLOYEE",
        description: `Admin ${admin.nama} menolak lamaran dari: ${targetData.username}`,
      });

      // C. KIRIM EMAIL: DITOLAK
      await db.collection("mail").add({
        to: targetEmail,
        message: {
          subject: `Update Status Lamaran`,
          html: `
              <h3>Halo, ${targetData.username}</h3>
              <p>Mohon maaf, saat ini kami belum bisa menerima lamaran Anda (Status: <b>Ditolak</b>).</p>
              <p>Tetap semangat.</p>
              <br>
              <p>Salam,<br>Tim HR</p>
            `,
        },
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
// 1. FIRE EMPLOYEE (Pecat Pegawai / Keluarkan)
// ---------------------------------------------------------
router.post("/fire-employee", verifyToken, async (req, res) => {
  try {
    const { targetEmail, reason } = req.body;
    const actor = req.user; // Admin yang melakukan aksi

    // Validasi Input
    if (!targetEmail || !reason) {
      return res
        .status(400)
        .json({ message: "Email target dan alasan pemecatan wajib diisi." });
    }

    // 1. Cek Permission Actor
    if (actor.role !== "admin") {
      return res
        .status(403)
        .json({ message: "Hanya Admin yang berhak mengeluarkan pegawai." });
    }

    // 2. Ambil Data Target
    const targetRef = db.collection("users").doc(targetEmail);
    const targetDoc = await targetRef.get();

    if (!targetDoc.exists) {
      return res.status(404).json({ message: "Pegawai tidak ditemukan." });
    }

    const targetData = targetDoc.data();

    // 3. Validasi Perusahaan (Harus satu kantor)
    if (targetData.idCompany !== actor.idCompany) {
      return res
        .status(400)
        .json({ message: "Pegawai ini bukan dari perusahaan Anda." });
    }

    // 4. PROTEKSI OWNER (Mekanisme Jabatan)
    // Kita harus ambil data Company dulu untuk tau siapa OWNER aslinya
    const companyDoc = await db
      .collection("companies")
      .doc(actor.idCompany)
      .get();
    const companyData = companyDoc.data();

    // Jika target adalah Owner, Admin biasa TIDAK BOLEH memecatnya
    if (targetData.uid === companyData.ownerUid) {
      return res
        .status(403)
        .json({
          message:
            "TINDAKAN ILEGAL: Anda tidak bisa memecat Pemilik Perusahaan (Owner).",
        });
    }

    // 5. Eksekusi Pemecatan
    await targetRef.update({
      role: "rejected", // Role kita ubah ke rejected (biar sama kayak user ditolak)
      status: "fired", // Status spesifik 'fired' biar tau ini dipecat, bukan ditolak pas daftar
      firedAt: Timestamp.now(),
      firedBy: actor.email,
      firedReason: reason, // Simpan alasan di DB juga buat arsip
      idCompany: null, // Opsional: Lepas ikatan perusahaan (atau biarkan biar ada history)
    });

    // 6. LOG AKTIVITAS (Company Level)
    await logCompanyActivity(actor.idCompany, {
      actorEmail: actor.email,
      actorName: actor.nama,
      target: targetEmail,
      action: "FIRE_EMPLOYEE",
      description: `Admin ${actor.nama} mengeluarkan ${targetData.username}. Alasan: ${reason}`,
    });

    // 7. KIRIM EMAIL (Wajib ada alasan)
    await db.collection("mail").add({
      to: targetEmail,
      message: {
        subject: `Pemberitahuan Penghentian Kerja - ${companyData.namaPerusahaan}`,
        html: `
            <h3>Halo, ${targetData.username}</h3>
            <p>Melalui email ini, kami menginformasikan bahwa akses kerja Anda di <b>${companyData.namaPerusahaan}</b> telah <b>DICABUT</b>.</p>
            
            <div style="background-color: #f8d7da; padding: 15px; border-radius: 5px; color: #721c24;">
              <strong>Alasan Pengeluaran:</strong><br>
              "${reason}"
            </div>
  
            <p>Jika Anda merasa ini adalah kesalahan, silakan hubungi manajemen perusahaan.</p>
            <p>Terima kasih atas kontribusi Anda selama ini.</p>
          `,
      },
    });

    return res
      .status(200)
      .json({ message: `Pegawai ${targetEmail} berhasil dikeluarkan.` });
  } catch (e) {
    console.error("Fire Employee Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

// ---------------------------------------------------------
// 2. MANAGE ROLE (Promote / Demote)
// ---------------------------------------------------------
router.post("/update-role", verifyToken, async (req, res) => {
  try {
    // action: "promote" (jadi Admin) atau "demote" (jadi Staff)
    const { targetEmail, action } = req.body;
    const actor = req.user;

    // Validasi Input
    if (!["promote", "demote"].includes(action)) {
      return res
        .status(400)
        .json({ message: "Action harus 'promote' atau 'demote'." });
    }

    // 1. Cek Permission Actor (Harus Admin)
    if (actor.role !== "admin") {
      return res
        .status(403)
        .json({ message: "Hanya Admin yang boleh mengubah jabatan." });
    }

    // 2. Ambil Data Target & Company
    const targetRef = db.collection("users").doc(targetEmail);
    const targetDoc = await targetRef.get();

    // Kita butuh data company untuk cek siapa Ownernya
    const companyDoc = await db
      .collection("companies")
      .doc(actor.idCompany)
      .get();
    const companyData = companyDoc.data();

    if (!targetDoc.exists)
      return res.status(404).json({ message: "User tidak ditemukan." });

    const targetData = targetDoc.data();

    // Validasi satu kantor
    if (targetData.idCompany !== actor.idCompany) {
      return res.status(400).json({ message: "User ini beda perusahaan." });
    }

    // 3. LOGIKA MEKANISME JABATAN (The Logic)
    let newRole = "";
    let logDescription = "";
    let notifMessage = "";

    if (action === "promote") {
      // --- KASUS: STAFF -> ADMIN ---
      if (targetData.role === "admin") {
        return res
          .status(400)
          .json({ message: "User ini sudah menjadi Admin." });
      }

      newRole = "admin";
      logDescription = `Admin ${actor.nama} menaikkan jabatan ${targetData.username} menjadi ADMIN.`;
      notifMessage = `Selamat! Anda telah diangkat menjadi ADMIN oleh ${actor.nama}.`;
    } else {
      // --- KASUS: ADMIN -> STAFF (Demote) ---

      // PROTEKSI OWNER: Owner tidak bisa didowngrade oleh siapapun!
      if (targetData.uid === companyData.ownerUid) {
        return res.status(403).json({
          message:
            "DILARANG: Anda tidak bisa menurunkan jabatan Pemilik Perusahaan (Owner).",
        });
      }

      if (targetData.role === "staff") {
        return res
          .status(400)
          .json({ message: "User ini sudah berstatus Staff." });
      }

      newRole = "staff";
      logDescription = `Admin ${actor.nama} menurunkan jabatan ${targetData.username} menjadi STAFF.`;
      notifMessage = `Status Admin Anda telah dicabut. Anda sekarang kembali menjadi STAFF.`;
    }

    // 4. Eksekusi Update
    await targetRef.update({ role: newRole });

    // 5. LOG AKTIVITAS COMPANY
    await logCompanyActivity(actor.idCompany, {
      actorEmail: actor.email,
      actorName: actor.nama,
      target: targetEmail,
      action: action === "promote" ? "PROMOTE_ADMIN" : "DEMOTE_STAFF",
      description: logDescription,
    });

    // 6. KIRIM NOTIFIKASI IN-APP (Tanpa Email)
    // Kita simpan di sub-collection 'notifications' milik user target
    // Nanti di Flutter tinggal listen stream ke collection ini
    await db
      .collection("users")
      .doc(targetEmail)
      .collection("notifications")
      .add({
        title: action === "promote" ? "Kenaikan Jabatan" : "Perubahan Peran",
        body: notifMessage,
        type: "role_change",
        isRead: false,
        createdAt: Timestamp.now(),
      });

    return res.status(200).json({
      message: "Perubahan jabatan berhasil.",
      data: { target: targetEmail, newRole: newRole },
    });
  } catch (e) {
    console.error("Update Role Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

// ---------------------------------------------------------
// GET ACTIVITY LOGS (Company Level)
// ---------------------------------------------------------
// Endpoint: GET /api/logs
// Headers: Authorization: Bearer <token_jwt_admin>
router.get("/log-activity", verifyToken, async (req, res) => {
  try {
    const user = req.user; // Data user dari Token Middleware

    // 1. Validasi: Pastikan user terikat perusahaan
    if (!user.idCompany) {
      return res
        .status(400)
        .json({ message: "User tidak terikat dengan perusahaan manapun." });
    }

    // 2. Validasi Role: Hanya Admin yang boleh lihat log (Opsional, sesuaikan kebutuhan)
    if (user.role !== "admin") {
      return res.status(403).json({
        message: "Akses ditolak. Hanya Admin yang boleh melihat Log Aktivitas.",
      });
    }

    // 3. Ambil Data Log dari Firestore
    // Path: companies/{idCompany}/logs
    const logsRef = db
      .collection("companies")
      .doc(user.idCompany)
      .collection("logs");

    // Kita urutkan berdasarkan waktu terbaru (descending)
    // Limit 50 atau 100 biar query gak berat kalau log udah ribuan
    const snapshot = await logsRef
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();

    if (snapshot.empty) {
      return res.status(200).json({
        message: "Belum ada aktivitas tercatat.",
        data: [],
      });
    }

    // 4. Formatting Data
    const logs = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      logs.push({
        id: doc.id,
        actorName: data.actorName,
        actorEmail: data.actorEmail,
        action: data.action,
        description: data.description,
        target: data.target,
        // Konversi Timestamp Firestore ke format Date yang mudah dibaca Frontend
        createdAt: data.createdAt ? data.createdAt.toDate() : null,
      });
    });

    return res.status(200).json({
      message: "Berhasil mengambil data log aktivitas.",
      data: logs,
    });
  } catch (error) {
    console.error("Get Logs Error:", error);
    return res
      .status(500)
      .json({ message: "Server Error saat mengambil log." });
  }
});

// ---------------------------------------------------------
// GET LIST PEGAWAI (Filter by Company)
// ---------------------------------------------------------
// Endpoint: GET /api/employee/list
// Headers: Authorization: Bearer <token>
router.get("/list", verifyToken, async (req, res) => {
  try {
    // Ambil data user dari Token (hasil middleware)
    const myCompanyId = req.user.idCompany;
    const myEmail = req.user.email;

    // 1. Validasi: User harus punya Company
    if (!myCompanyId) {
      return res.status(400).json({
        message: "Akun Anda tidak terikat dengan perusahaan manapun.",
      });
    }

    // 2. Query Firestore
    // Mengambil semua user yang idCompany-nya sama
    // Diurutkan dari yang paling baru daftar (descending)
    const snapshot = await db
      .collection("users")
      .where("idCompany", "==", myCompanyId)
      .orderBy("createdAt", "desc")
      .get();

    // 3. Handle jika kosong
    if (snapshot.empty) {
      return res.status(200).json({
        message: "Belum ada pegawai lain di perusahaan ini.",
        data: [],
      });
    }

    // 4. Mapping Data (Membersihkan output untuk Frontend)
    const allUsers = [];

    snapshot.forEach((doc) => {
      const data = doc.data();

      allUsers.push({
        email: doc.id, // Karena kita pakai email sebagai Doc ID
        username: data.username || "Tanpa Nama",
        // Handle inkonsistensi penulisan (kadang photoURL, kadang photoUrl)
        photoURL: data.photoURL || data.photoUrl || "",
        noTelp: data.noTelp || "-",
        noWA: data.noWA || "-",
        role: data.role, // admin, staff, candidate, rejected
        status: data.status, // active, banned, etc

        // Konversi Timestamp Firestore ke Date JS biar frontend enak
        joinedAt: data.createdAt ? data.createdAt.toDate() : null,

        // Penanda khusus buat UI (misal: "Ini Saya" dikasih warna beda)
        isMe: doc.id === myEmail,
      });
    });

    return res.status(200).json({
      message: "Data pegawai berhasil diambil",
      requestor: myEmail,
      total: allUsers.length,
      data: allUsers,
    });
  } catch (e) {
    console.error("Get Employees Error:", e);

    // NOTE: Error ini sering terjadi kalau belum bikin Index di Firestore
    if (e.code === 9 || e.message.includes("requires an index")) {
      return res.status(500).json({
        message:
          "Server Error: Index Firestore belum dibuat. Cek console log server untuk link pembuatannya.",
      });
    }

    return res.status(500).json({ message: "Server Error" });
  }
});

module.exports = router;
