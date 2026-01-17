/* eslint-disable */
const express = require("express");
const router = express.Router();
const { db } = require("../config/firebase");
const { verifyToken } = require("../middleware/token");
const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const { logCompanyActivity } = require("../helper/logCompanyActivity");

// ---------------------------------------------------------
// CONSTANTS & HELPERS
// ---------------------------------------------------------
const REIMBURSE_STATUS = {
  TUNGGAKAN: { text: "Tunggakan", code: 0 },
  LUNAS: { text: "Lunas", code: 1 },
  DITOLAK: { text: "Ditolak", code: 2 }, // Opsional untuk masa depan
};

// Helper: Ambil snapshot file dari collection 'files'
const getFileSnapshot = async (idCompany, fileId) => {
  if (!fileId) return null;

  const fileDoc = await db
    .collection("companies")
    .doc(idCompany)
    .collection("files")
    .doc(fileId)
    .get();

  if (!fileDoc.exists) return null;

  const data = fileDoc.data();
  return {
    fileId: fileId,
    fileName: data.fileName,
    fileUrl: data.downloadUrl,
    mimeType: data.mimeType,
    size: data.size,
  };
};

// ---------------------------------------------------------
// GET /list - List Reimburse (Filter by Role)
// ---------------------------------------------------------
router.get("/list", verifyToken, async (req, res) => {
  try {
    const { idCompany, role, email } = req.user;

    let query = db
      .collection("companies")
      .doc(idCompany)
      .collection("reimbursements")
      .orderBy("createdAt", "desc");

    // Jika Staff, hanya lihat reimburse milik sendiri
    if (role !== "admin") {
      query = query.where("requestByEmail", "==", email);
    }

    const snapshot = await query.get();

    if (snapshot.empty) {
      return res
        .status(200)
        .json({ message: "Data tidak ditemukan", data: [] });
    }

    const data = snapshot.docs.map((doc) => {
      const item = doc.data();
      return {
        id: doc.id,
        ...item,
        // Format tanggal untuk FE
        date: item.date?.toDate().toISOString(), // Tgl Transaksi
        processedAt: item.processedAt?.toDate().toISOString() || null, // Tgl Lunas
        createdAt: item.createdAt?.toDate().toISOString(),
        updatedAt: item.updatedAt?.toDate().toISOString(),
      };
    });

    return res.status(200).json({
      message: "Data reimburse berhasil diambil.",
      data: data,
    });
  } catch (error) {
    console.error("Error Get Reimburse:", error);
    return res
      .status(500)
      .json({ message: "Server Error", error: error.message });
  }
});

// ---------------------------------------------------------
// POST /create - Ajukan Reimburse (All Roles)
// ---------------------------------------------------------
router.post("/create", verifyToken, async (req, res) => {
  try {
    const { title, description, amount, date, fileId } = req.body;
    const { idCompany, email, nama, role } = req.user;

    // 1. Validasi Input Wajib (Title & Desc Opsional)
    if (!amount || !fileId || !date) {
      return res.status(400).json({
        message:
          "Jumlah (amount), Tanggal (date), dan Bukti (fileId) wajib diisi.",
      });
    }

    // 2. Lookup File Bukti Pengajuan
    const evidenceData = await getFileSnapshot(idCompany, fileId);
    if (!evidenceData) {
      return res.status(404).json({ message: "File bukti tidak ditemukan." });
    }

    // 3. Set Default Title jika kosong
    const finalTitle =
      title || `Reimburse - ${new Date(date).toLocaleDateString("id-ID")}`;

    // 4. Buat Object Reimburse
    const newReimburse = {
      title: finalTitle,
      description: description || "",
      amount: Number(amount),
      date: Timestamp.fromDate(new Date(date)),

      // Status Awal: Tunggakan
      status: REIMBURSE_STATUS.TUNGGAKAN.text,
      statusCode: REIMBURSE_STATUS.TUNGGAKAN.code,

      // Snapshot Bukti Pengajuan
      evidence: evidenceData,

      // Metadata Request
      requestByEmail: email,
      requestByName: nama || "User",
      requestByRole: role,

      // Metadata Proses (Kosong di awal)
      processedBy: null,
      processedAt: null,
      paymentEvidence: null, // Tempat bukti transfer pelunasan nanti

      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    };

    const docRef = await db
      .collection("companies")
      .doc(idCompany)
      .collection("reimbursements")
      .add(newReimburse);

    // 5. Log Aktivitas
    await logCompanyActivity(idCompany, {
      actorEmail: email,
      actorName: nama || "User",
      target: docRef.id,
      action: "CREATE_REIMBURSE",
      description: `Mengajukan reimburse: ${finalTitle} sebesar Rp${amount}`,
    });

    return res.status(201).json({
      message: "Reimburse berhasil diajukan.",
      id: docRef.id,
      data: {
        id: docRef.id,
        ...newReimburse,
        date: newReimburse.date.toDate().toISOString(),
        createdAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Error Create Reimburse:", error);
    return res
      .status(500)
      .json({ message: "Server Error", error: error.message });
  }
});

// ---------------------------------------------------------
// POST /update-status - Update Status & Pelunasan (Admin Only)
// ---------------------------------------------------------
// Body: { reimburseId: "...", status: "Lunas" | "Tunggakan", fileId: "..." (Bukti Transfer - Opsional/Wajib jika lunas) }
router.post("/update-status", verifyToken, async (req, res) => {
  try {
    const { reimburseId, status, fileId } = req.body; // fileId disini adalah bukti pelunasan
    const { idCompany, role, email, nama } = req.user;

    // 1. Validasi Admin
    if (role !== "admin") {
      return res.status(403).json({
        message:
          "Akses ditolak. Hanya Admin yang dapat mengubah status reimburse.",
      });
    }

    // 2. Mapping Status Valid
    let targetStatusCode;
    if (status === REIMBURSE_STATUS.LUNAS.text)
      targetStatusCode = REIMBURSE_STATUS.LUNAS.code;
    else if (status === REIMBURSE_STATUS.TUNGGAKAN.text)
      targetStatusCode = REIMBURSE_STATUS.TUNGGAKAN.code;
    else {
      return res.status(400).json({
        message: "Status tidak valid. Gunakan: 'Tunggakan' atau 'Lunas'.",
      });
    }

    // 3. Validasi Bukti Pelunasan (Jika status LUNAS, fileId disarankan ada)
    // Anda bisa membuat ini wajib atau opsional. Di sini saya buat wajib jika statusnya Lunas agar akuntabel.
    if (status === REIMBURSE_STATUS.LUNAS.text && !fileId) {
      return res.status(400).json({
        message:
          "Harap lampirkan bukti transfer (fileId) untuk mengubah status menjadi Lunas.",
      });
    }

    // 4. Lookup File Bukti Pelunasan (Jika ada fileId)
    let paymentEvidenceData = null;
    if (fileId) {
      paymentEvidenceData = await getFileSnapshot(idCompany, fileId);
      if (!paymentEvidenceData) {
        return res
          .status(404)
          .json({ message: "File bukti pelunasan tidak ditemukan." });
      }
    }

    const reimburseRef = db
      .collection("companies")
      .doc(idCompany)
      .collection("reimbursements")
      .doc(reimburseId);

    const reimburseDoc = await reimburseRef.get();
    if (!reimburseDoc.exists) {
      return res
        .status(404)
        .json({ message: "Data reimburse tidak ditemukan." });
    }
    const currentData = reimburseDoc.data();

    // 5. Update Data
    const updateData = {
      status: status,
      statusCode: targetStatusCode,
      updatedAt: Timestamp.now(),
    };

    if (status === REIMBURSE_STATUS.LUNAS.text) {
      // Jika jadi LUNAS: Simpan admin yg memproses & bukti bayar
      updateData.processedBy = email;
      updateData.processedAt = Timestamp.now();
      if (paymentEvidenceData) {
        updateData.paymentEvidence = paymentEvidenceData;
      }
    } else {
      // Jika dibalikin jadi TUNGGAKAN: Reset data pelunasan
      updateData.processedBy = FieldValue.delete();
      updateData.processedAt = FieldValue.delete();
      updateData.paymentEvidence = FieldValue.delete();
    }

    await reimburseRef.update(updateData);

    // 6. Log Aktivitas
    await logCompanyActivity(idCompany, {
      actorEmail: email,
      actorName: nama || "Admin",
      target: reimburseId,
      action: "UPDATE_STATUS_REIMBURSE",
      description: `Mengubah status reimburse '${currentData.title}' menjadi ${status}.`,
    });

    return res.status(200).json({
      message: `Status reimburse berhasil diubah menjadi ${status}.`,
      data: {
        reimburseId,
        status,
        statusCode: targetStatusCode,
        paymentEvidence: paymentEvidenceData,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Error Update Status Reimburse:", error);
    return res
      .status(500)
      .json({ message: "Server Error", error: error.message });
  }
});

module.exports = router;
