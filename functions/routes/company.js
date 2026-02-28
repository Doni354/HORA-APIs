/* eslint-disable */
const admin = require("firebase-admin");
require("dotenv").config();
const express = require("express");
const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const { db, bucket } = require("../config/firebase");
const { verifyToken } = require("../middleware/token");
const { logCompanyActivity } = require("../helper/logCompanyActivity");
const EmailTemplates = require("../helper/emailHelper");
const { auth } = require("firebase-admin");
const router = express.Router();
const crypto = require("crypto");

/**
 * HELPER: Pengecekan Kuota Karyawan (Admin + Staff)
 * Digunakan di: verify-employee & accept-invite
 */
async function checkCompanyQuota(idCompany) {
  const companyDoc = await db.collection("companies").doc(idCompany).get();
  if (!companyDoc.exists) return { allowed: false, message: "Perusahaan tidak ditemukan" };
  
  const companyData = companyDoc.data();
  // Default limit 10 jika field maxKaryawan belum ada di DB
  const maxQuota = companyData.maxKaryawan || 10; 

  const employeesSnapshot = await db.collection("users")
    .where("idCompany", "==", idCompany)
    .where("role", "in", ["admin", "staff"])
    .get();

  const currentCount = employeesSnapshot.size;

  if (currentCount >= maxQuota) {
    return { 
      allowed: false, 
      message: `Kuota karyawan penuh. Batas maksimal perusahaan Anda adalah ${maxQuota} orang. Silakan hubungi pusat untuk upgrade.` 
    };
  }

  return { allowed: true };
}

// ---------------------------------------------------------
// 2. ADMIN APPROVAL (Dengan Cek Quota + Notifikasi Email Detail)
// ---------------------------------------------------------
router.post("/verify-employee", verifyToken, async (req, res) => {
  try {
    const { targetEmail, approved } = req.body;
    const adminData = req.user; // Rename biar ga bentrok sama 'admin' firebase

    // 1. Cek Admin
    if (adminData.role !== "admin") {
      return res.status(403).json({ message: "Hanya Admin yang boleh melakukan ini" });
    }

    // 2. Cek Target User
    const targetRef = db.collection("users").doc(targetEmail);
    const targetDoc = await targetRef.get();

    if (!targetDoc.exists) return res.status(404).json({ message: "User tidak ditemukan" });

    const targetData = targetDoc.data();

    // 3. Validasi Perusahaan Sama
    if (targetData.idCompany !== adminData.idCompany) {
      return res.status(400).json({ message: "User ini tidak mendaftar di perusahaan Anda" });
    }

    // 4. Pastikan statusnya Candidate
    if (targetData.role !== "candidate") {
      return res.status(400).json({ message: "User ini bukan kandidat pelamar." });
    }

    if (approved) {
      // --- PENGECEKAN KUOTA SEBELUM APPROVE ---
      const quotaCheck = await checkCompanyQuota(adminData.idCompany);
      if (!quotaCheck.allowed) {
        return res.status(400).json({ message: quotaCheck.message });
      }

      // A. Update DB User
      await targetRef.update({
        role: "staff",
        status: "active",
        approvedAt: Timestamp.now(),
        approvedBy: adminData.email,
      });

      // B. Log Aktivitas
      await logCompanyActivity(adminData.idCompany, {
        actorEmail: adminData.email,
        actorName: adminData.nama,
        target: targetEmail,
        action: "APPROVE_EMPLOYEE",
        description: `Admin ${adminData.nama} menerima pegawai baru: ${targetData.username}`,
      });

      // C. Kirim Email DITERIMA (via EmailHelper)
      await EmailTemplates.send(targetEmail, "employee_approved", {
        username: targetData.username,
        companyName: targetData.companyName || adminData.companyName || "Perusahaan",
      });

      return res.status(200).json({ message: `Pegawai ${targetEmail} berhasil diterima.` });

    } else {
      // --- KASUS: DITOLAK ---
      
      // A. Update DB User
      await targetRef.update({
        role: "rejected",
        status: "rejected",
        rejectedAt: Timestamp.now(),
        rejectedBy: adminData.email,
      });

      // B. Log Aktivitas
      await logCompanyActivity(adminData.idCompany, {
        actorEmail: adminData.email,
        actorName: adminData.nama,
        target: targetEmail,
        action: "REJECT_EMPLOYEE",
        description: `Admin ${adminData.nama} menolak lamaran dari: ${targetData.username}`,
      });

      // C. Kirim Email DITOLAK (via EmailHelper)
      await EmailTemplates.send(targetEmail, "employee_rejected", {
        username: targetData.username,
      });

      return res.status(200).json({ message: `Pegawai ${targetEmail} telah ditolak.` });
    }
  } catch (e) {
    console.error("Verify Employee Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});


// ---------------------------------------------------------
// 4. FIRE EMPLOYEE (Lengkap dengan Proteksi Owner & Email)
// ---------------------------------------------------------
router.post("/fire-employee", verifyToken, async (req, res) => {
  try {
    const { targetEmail, reason } = req.body;
    const actor = req.user;

    if (!targetEmail) return res.status(400).json({ message: "Email target wajib diisi." });

    const finalReason = reason && reason.trim() !== "" ? reason : "Tidak ada alasan yang diberikan";

    if (actor.role !== "admin") return res.status(403).json({ message: "Hanya Admin yang berhak mengeluarkan pegawai." });

    const targetRef = db.collection("users").doc(targetEmail);
    const targetDoc = await targetRef.get();

    if (!targetDoc.exists) return res.status(404).json({ message: "Pegawai tidak ditemukan." });

    const targetData = targetDoc.data();

    if (targetData.idCompany !== actor.idCompany) return res.status(400).json({ message: "Pegawai ini bukan dari perusahaan Anda." });

    // --- PROTEKSI OWNER ---
    const companyDoc = await db.collection("companies").doc(actor.idCompany).get();
    const companyData = companyDoc.data();

    if (targetData.uid === companyData.ownerUid) {
      return res.status(403).json({ message: "TINDAKAN ILEGAL: Anda tidak bisa memecat Pemilik Perusahaan (Owner)." });
    }

    // Eksekusi Pemecatan
    await targetRef.update({
      role: "rejected",
      status: "fired",
      firedAt: Timestamp.now(),
      firedBy: actor.email,
      firedReason: finalReason,
      idCompany: null, // PENTING: Lepas ID Company biar kuota nambah
    });

    await logCompanyActivity(actor.idCompany, {
      actorEmail: actor.email,
      actorName: actor.nama,
      target: targetEmail,
      action: "FIRE_EMPLOYEE",
      description: `Admin ${actor.nama} mengeluarkan ${targetData.username}. Alasan: ${finalReason}`,
    });

    // Kirim Email Pemberitahuan (via EmailHelper)
    await EmailTemplates.send(targetEmail, "employee_fired", {
      username: targetData.username,
      companyName: companyData.namaPerusahaan,
      reason: finalReason,
    });

    return res.status(200).json({ message: `Pegawai ${targetEmail} berhasil dikeluarkan.` });
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
// POST ACTIVITY LOG (Create New Log)
// ---------------------------------------------------------
// Endpoint: POST /api/log-activity
// Headers: Authorization: Bearer <token_jwt>
// Body (JSON):
// {
//   "action": "UPDATE_PROFILE",
//   "description": "User mengubah data nomor telepon",
//   "target": "Profile Page" (Opsional)
// }
// ---------------------------------------------------------
// POST ACTIVITY LOG (With Fetch User Data)
// ---------------------------------------------------------
router.post("/log-activity", verifyToken, async (req, res) => {
  try {
    const tokenData = req.user; // Ini hasil dari verifyToken

    // --- DEBUGGING (Opsional) ---
    // console.log("User dari Token:", tokenData);
    // ----------------------------

    const { action, description, target } = req.body;

    // 1. Validasi Body
    if (!action || !description) {
      return res.status(400).json({ message: "Action dan Description wajib diisi." });
    }

    // 2. Validasi Token Data
    // PERBAIKAN: Cek 'email', bukan 'id'
    if (!tokenData || !tokenData.email) {
        return res.status(400).json({ message: "Token invalid: Email user tidak ditemukan." });
    }

    if (!tokenData.idCompany) {
        return res.status(400).json({ message: "User tidak terikat dengan perusahaan." });
    }

    // 3. Ambil Data User Lengkap (termasuk UID)
    // PERBAIKAN: Gunakan 'tokenData.email' sebagai Document ID
    const userDocRef = db.collection("users").doc(tokenData.email);
    const userSnapshot = await userDocRef.get();

    // Default data jaga-jaga kalau DB read gagal (fallback ke data token)
    let userData = {
        username: tokenData.nama || "Unknown",
        uid: tokenData.email, // Fallback uid pake email dulu
        alamatEmail: tokenData.email
    };

    if (userSnapshot.exists) {
       userData = userSnapshot.data();
    }

    // 4. Siapkan Object Log
    const newLog = {
      actorName: userData.username || userData.nama || tokenData.nama, 
      actorEmail: userData.alamatEmail || tokenData.email,
      actorId: userData.uid || tokenData.email, // UID asli dari DB Users
      role: tokenData.role,
      
      action: action,
      description: description,
      target: target || "-",
      createdAt: FieldValue.serverTimestamp(),
    };

    // 5. Simpan Log
    await db
      .collection("companies")
      .doc(tokenData.idCompany)
      .collection("logs")
      .add(newLog);

    return res.status(201).json({
      message: "Log aktivitas berhasil dicatat.",
      data: {
        ...newLog,
        createdAt: new Date().toISOString() 
      }
    });

  } catch (error) {
    console.error("Post Log Error:", error);
    return res.status(500).json({ message: "Server Error saat mencatat log." });
  }
});

// ---------------------------------------------------------
// 5. GET LIST PEGAWAI (Dengan info Max Quota & Storage Fix)
// ---------------------------------------------------------
router.get("/list", verifyToken, async (req, res) => {
  try {
    const myCompanyId = req.user.idCompany;
    const myEmail = req.user.email;

    if (!myCompanyId) {
      return res.status(400).json({ message: "Akun Anda tidak terikat dengan perusahaan manapun." });
    }

    const snapshot = await db.collection("users")
      .where("idCompany", "==", myCompanyId)
      .orderBy("createdAt", "desc")
      .get();

    // --- AMBIL INFO KUOTA & STORAGE UNTUK FRONTEND ---
    // PENTING: Deklarasi variable DI LUAR if, supaya scope-nya global di fungsi ini
    let maxKaryawan = 10;
    let maxStorage = 0;
    let usedStorage = 0;

    const companyDoc = await db.collection("companies").doc(myCompanyId).get();
    
    if (companyDoc.exists) {
        const cData = companyDoc.data();
        // Gunakan operator || untuk handling data lama yang kosong (undefined)
        maxKaryawan = cData.maxKaryawan || 10;
        maxStorage = cData.maxStorage || 0;
        usedStorage = cData.usedStorage || 0;
    }

    // Handle jika list pegawai kosong
    if (snapshot.empty) {
      return res.status(200).json({
        message: "Belum ada pegawai lain.",
        maxQuota: maxKaryawan,
        storage: {
            used: usedStorage,
            max: maxStorage,
            // LOGIC FIX: Hapus "&& maxStorage > 0" agar jika 0/0 dianggap penuh (true)
            isFull: usedStorage >= maxStorage 
        },
        data: [],
      });
    }

    const allUsers = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      allUsers.push({
        email: doc.id, 
        username: data.username || "Tanpa Nama",
        photoURL: data.photoURL || data.photoUrl || "",
        noTelp: data.noTelp || "-",
        noWA: data.noWA || "-",
        role: data.role, 
        status: data.status, 
        joinedAt: data.createdAt ? data.createdAt.toDate() : null,
        isMe: doc.id === myEmail,
      });
    });

    return res.status(200).json({
      message: "Data pegawai berhasil diambil",
      requestor: myEmail,
      total: allUsers.length,
      maxQuota: maxKaryawan,
      storage: {
        used: usedStorage,
        max: maxStorage,
        // LOGIC FIX: Hapus "&& maxStorage > 0"
        isFull: usedStorage >= maxStorage
      },
      data: allUsers,
    });
  } catch (e) {
    console.error("Get Employees Error:", e);
    
    // Handle error index firestore jika belum dibuat
    if (e.code === 9 || e.message.includes("requires an index")) {
        return res.status(500).json({
          message: "Server Error: Index Firestore belum dibuat. Cek console log server.",
        });
      }

    return res.status(500).json({ message: "Server Error" });
  }
});


// ---------------------------------------------------------
// 1. KIRIM UNDANGAN (Admin Input Email -> Kirim Link)
// ---------------------------------------------------------
router.post("/send-invite", verifyToken, async (req, res) => {
    try {
      const { targetEmail } = req.body;
      const adminData = req.user; // Dari Token
  
      // A. Validasi
      if (!targetEmail) return res.status(400).json({ message: "Email wajib diisi." });
      if (adminData.role !== "admin") return res.status(403).json({ message: "Hanya Admin bisa mengundang." });
  
      // --- FIX: AMBIL DATA PERUSAHAAN DARI DB ---
      // Karena di token tidak ada nama perusahaan
      const companyDoc = await db.collection("companies").doc(adminData.idCompany).get();
      let companyName = "Perusahaan";
      
      if (companyDoc.exists) {
          companyName = companyDoc.data().namaPerusahaan;
      } else {
          return res.status(404).json({ message: "Data perusahaan tidak ditemukan." });
      }
  
      // B. Cek apakah user sudah terdaftar di sistem?
      const userDoc = await db.collection("users").doc(targetEmail).get();
      if (userDoc.exists) {
        const data = userDoc.data();
        // UPDATE: Hanya tolak jika user AKTIF atau PENDING.
        // Jika user statusnya 'rejected' (pernah ditolak/dipecat), BOLEH di-invite lagi.
        if (data.role !== "rejected" && data.status !== "fired") {
          return res.status(400).json({ 
              message: "Email ini sudah terdaftar aktif atau sedang menunggu persetujuan.",
              currentStatus: data.status 
          });
        }
      }
  
      // C. Generate Token Undangan Unik
      const inviteCode = crypto.randomBytes(16).toString("hex"); 
      
      // D. Simpan Data Invitation (Temporary)
      await db.collection("invitations").doc(inviteCode).set({
        email: targetEmail,
        idCompany: adminData.idCompany,
        companyName: companyName, // <--- Pakai variabel yang baru diambil dari DB
        role: "staff", 
        invitedBy: adminData.email,
        createdAt: Timestamp.now(),
        expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000) // 24 Jam
      });
  
      // E. Log Aktivitas
      await logCompanyActivity(adminData.idCompany, {
        actorEmail: adminData.email,
        actorName: adminData.nama || "Admin",
        target: targetEmail,
        action: "SEND_INVITE",
        description: `Admin ${adminData.nama || "Admin"} mengirim undangan ke ${targetEmail}`,
      });
  
      // F. Kirim Email (via EmailHelper)
      const inviteLink = `https://hora-7394b.web.app/join/?code=${inviteCode}`;
      
      await EmailTemplates.send(targetEmail, "invite", {
        companyName: companyName,
        inviterName: adminData.nama || "Admin",
        targetEmail: targetEmail,
        link: inviteLink,
      });
  
      return res.status(200).json({ message: `Undangan berhasil dikirim ke ${targetEmail}` });
  
    } catch (e) {
      console.error("Send Invite Error:", e);
      return res.status(500).json({ message: "Server Error" });
    }
});

// ---------------------------------------------------------
// 3. ACCEPT INVITE (Dengan Cek Quota)
// ---------------------------------------------------------
router.post("/accept-invite", async (req, res) => {
  try {
    const { idToken, inviteCode, noTelp, noWA } = req.body;

    if (!idToken || !inviteCode || !noTelp) {
      return res.status(400).json({ message: "Data tidak lengkap." });
    }

    const inviteRef = db.collection("invitations").doc(inviteCode);
    const inviteDoc = await inviteRef.get();
    if (!inviteDoc.exists) return res.status(404).json({ message: "Kode undangan tidak valid." });

    const inviteData = inviteDoc.data();

    // --- PENGECEKAN KUOTA SEBELUM JOIN ---
    const quotaCheck = await checkCompanyQuota(inviteData.idCompany);
    if (!quotaCheck.allowed) {
      return res.status(400).json({ message: quotaCheck.message });
    }

    if (inviteData.expiresAt.toMillis() < Date.now()) {
      return res.status(400).json({ message: "Kode undangan sudah kadaluarsa." });
    }

    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken.toString().trim());
    } catch (error) {
      return res.status(401).json({ message: "Sesi Google tidak valid." });
    }

    const email = decodedToken.email;
    const uid = decodedToken.uid;
    const username = decodedToken.name || email.split("@")[0];
    const photoURL = decodedToken.picture || "";

    if (email !== inviteData.email) {
      return res.status(403).json({ message: `Undangan khusus untuk email ${inviteData.email}` });
    }

    // Cek User Existing (Allow re-join if rejected/fired)
    const userRef = db.collection("users").doc(email);
    const userCheck = await userRef.get();
    
    if (userCheck.exists) {
        const data = userCheck.data();
        if (data.role !== "rejected" && data.status !== "fired") {
            await inviteRef.delete(); 
            return res.status(400).json({ message: "Akun Anda sudah terdaftar aktif. Silakan login." });
        }
    }

    const newUser = {
      uid: uid,
      username: username,
      alamatEmail: email, 
      photoURL: photoURL,
      authProvider: "google",
      noTelp: noTelp,
      noWA: noWA || noTelp, 
      idCompany: inviteData.idCompany,
      companyName: inviteData.companyName,
      role: inviteData.role, 
      status: "active", 
      verified: false, 
      createdAt: Timestamp.now(),
      lastLogin: Timestamp.now()
    };

    await userRef.set(newUser);
    await inviteRef.delete();

    await logCompanyActivity(inviteData.idCompany, {
        actorEmail: email,
        actorName: username,
        target: inviteData.idCompany,
        action: "JOIN_VIA_INVITE",
        description: `Pegawai ${username} resmi bergabung via undangan.`
    });

    return res.status(200).json({ 
      message: "Registrasi Berhasil! Selamat bergabung.",
      user: { email, role: "staff", company: inviteData.companyName }
    });

  } catch (e) {
    console.error("Accept Invite Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

  // ---------------------------------------------------------
// 1. GET INFO PERUSAHAAN (Public - Tanpa Token)
// ---------------------------------------------------------
// Gunanya biar pas user buka link, muncul "Anda akan melamar ke PT Maju Mundur"
// Bukan cuma ID acak doang.
router.get("/apply-company/:idCompany", async (req, res) => {
    try {
      const { idCompany } = req.params;
  
      const companyDoc = await db.collection("companies").doc(idCompany).get();
      if (!companyDoc.exists) {
        return res.status(404).json({ message: "Perusahaan tidak ditemukan." });
      }
  
      const data = companyDoc.data();
      // Return data secukupnya aja (jangan semua data sensitif)
      return res.status(200).json({
        namaPerusahaan: data.namaPerusahaan,
        logoUrl: data.logoUrl || "",
        alamatLoc: data.alamatLoc || ""
      });
  
    } catch (e) {
      return res.status(500).json({ message: "Server Error" });
    }
});

// ---------------------------------------------------------
// 2. SUBMIT LAMARAN (User Login Google -> Jadi Candidate)
// ---------------------------------------------------------
router.post("/apply", async (req, res) => {
    try {
      const { idToken, idCompany, noTelp, noWA } = req.body;
  
      // A. Validasi
      if (!idToken || !idCompany || !noTelp) {
        return res.status(400).json({ message: "Data tidak lengkap." });
      }
  
      // B. Cek Perusahaan Valid
      const companyDoc = await db.collection("companies").doc(idCompany).get();
      if (!companyDoc.exists) {
        return res.status(404).json({ message: "Perusahaan tujuan tidak ditemukan." });
      }
      const companyData = companyDoc.data();
  
      // C. Verifikasi Google Token
      let decodedToken;
      try {
        decodedToken = await admin.auth().verifyIdToken(idToken.toString().trim());
      } catch (error) {
        return res.status(401).json({ message: "Sesi Google tidak valid." });
      }
  
      const email = decodedToken.email;
      const uid = decodedToken.uid;
      const username = decodedToken.name || email.split("@")[0];
      const photoURL = decodedToken.picture || "";
  
      // D. Cek Status User di Database
      const userRef = db.collection("users").doc(email);
      const userDoc = await userRef.get();
  
      if (userDoc.exists) {
        const data = userDoc.data();
        
        // 1. VALIDASI PENTING: User Aktif (Admin/Staff) DITOLAK
        if (["admin", "staff"].includes(data.role)) {
          return res.status(400).json({ 
              // Pesan ini sudah benar untuk mencegah admin menimpa akunnya sendiri
              message: `Akun ini sudah terdaftar sebagai ${data.role} di ${data.companyName || "perusahaan lain"}. Harap gunakan email berbeda.`,
              role: data.role 
          });
        }
  
        // 2. Kalau user sudah Candidate (nunggu approval) -> TOLAK (Biar gak spam)
        if (data.role === "candidate") {
          return res.status(400).json({ 
              message: "Lamaran Anda sebelumnya sedang diproses. Harap tunggu konfirmasi Admin.",
          });
        }
  
        // 3. Kalau user statusnya 'fired' atau 'rejected', BOLEH daftar ulang (Re-apply)
      }
  
      // E. CREATE / UPDATE USER (Sebagai Candidate)
      const applicantData = {
        uid: uid,
        username: username,
        alamatEmail: email,
        photoURL: photoURL,
        authProvider: "google",
        noTelp: noTelp,
        noWA: noWA || noTelp,
        
        // Link ke Company Tujuan
        idCompany: idCompany,
        companyName: companyData.namaPerusahaan,
        
        role: "candidate",       // <--- Masuk sebagai Candidate
        status: "pending_approval", 
        
        verified: true, // Email google dianggap verified
        createdAt: Timestamp.now(), 
        lastLogin: Timestamp.now()
      };
  
      // Pakai set merge: true (penting untuk overwrite data lama jika ada)
      await userRef.set(applicantData, { merge: true });
  
      // F. Log Aktivitas Company
      await logCompanyActivity(idCompany, {
          actorEmail: email,
          actorName: username,
          target: idCompany,
          action: "NEW_APPLICANT",
          description: `${username} melamar pekerjaan via Link Publik.`
      });
  
      return res.status(200).json({
        message: "Lamaran berhasil dikirim. Menunggu persetujuan Admin.",
        user: { email, role: "candidate" }
      });
  
    } catch (e) {
      console.error("Public Join Error:", e);
      return res.status(500).json({ message: "Server Error" });
    }
});

// ---------------------------------------------------------
// 3. GET PUBLIC JOIN LINK (Untuk Admin Share) - NEW!
// ---------------------------------------------------------
router.get("/public-link", verifyToken, async (req, res) => {
    try {
      const user = req.user;
  
      // Pastikan user punya ID Company
      if (!user.idCompany) {
        return res.status(400).json({ message: "Anda tidak terikat dengan perusahaan manapun." });
      }
  
      // Format Link sesuai permintaan
      // Pastikan ID Company di-encode biar aman di URL (walaupun biasanya aman)
      const publicLink = `https://hora-7394b.web.app/apply/?id=${user.idCompany}`;
  
      return res.status(200).json({
        message: "Link public join berhasil diambil",
        link: publicLink
      });
  
    } catch (e) {
      console.error("Get Public Link Error:", e);
      return res.status(500).json({ message: "Server Error" });
    }
  });

  
module.exports = router;
