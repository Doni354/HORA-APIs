/* eslint-disable */
const express = require("express");
const router = express.Router();
const { db, bucket } = require("../config/firebase");
const { verifyToken } = require("../middleware/token");
const { logCompanyActivity } = require("../helper/logCompanyActivity");
// FIX: Import Timestamp dan FieldValue langsung dari module-nya
const { Timestamp, FieldValue } = require("firebase-admin/firestore");

// ---------------------------------------------------------
// 1. AJUKAN IZIN BARU (JSON Only - File Sudah Diupload Duluan)
// ---------------------------------------------------------
router.post("/", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    const { tipeIzin, startDate, endDate, keterangan, fileId } = req.body;

    // 1. Validasi Input
    if (!user.idCompany) {
      return res
        .status(400)
        .json({ message: "Anda tidak terikat dengan perusahaan manapun." });
    }

    if (!tipeIzin || !startDate || !endDate) {
      return res.status(400).json({
        message: "Lengkapi data izin (Tipe, Tanggal Mulai & Selesai).",
      });
    }

    if (!fileId) {
      return res.status(400).json({
        message: "Wajib menyertakan lampiran berkas (fileId kosong).",
      });
    }

    // 2. Ambil Data File dari Collection 'files' Perusahaan
    const fileRef = db
      .collection("companies")
      .doc(user.idCompany)
      .collection("files")
      .doc(fileId);
    const fileDoc = await fileRef.get();

    if (!fileDoc.exists) {
      return res.status(404).json({
        message:
          "Berkas lampiran tidak ditemukan. Pastikan sudah upload berkas.",
      });
    }

    const fileData = fileDoc.data();

    // Opsional: Cek Security
    if (fileData.uploadedBy !== user.email && user.role !== "admin") {
      return res
        .status(403)
        .json({ message: "Anda tidak berhak menggunakan berkas ini." });
    }

    // 3. Update Metadata File
    await fileRef.update({
      category: "LEAVE_ATTACHMENT",
      relatedTo: "Employee Leave",
      updatedAt: Timestamp.now(), // FIX: Gunakan Timestamp langsung
    });

    // 4. Simpan Data Izin
    const leaveData = {
      userId: user.email,
      userName: user.nama || "Staff",
      userRole: user.role,
      idCompany: user.idCompany,

      tipeIzin: tipeIzin,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      keterangan: keterangan || "-",

      attachmentFileId: fileId,
      attachmentUrl: fileData.downloadUrl,
      attachmentPath: fileData.storagePath,
      attachmentName: fileData.fileName,

      status: "pending",

      createdAt: Timestamp.now(), // FIX: Gunakan Timestamp langsung
      history: [{ status: "created", by: user.email, at: new Date() }],
    };

    const leaveRef = await db
      .collection("companies")
      .doc(user.idCompany)
      .collection("leaves")
      .add(leaveData);

    // 5. Log Aktivitas
    await logCompanyActivity(user.idCompany, {
      actorEmail: user.email,
      actorName: user.nama,
      target: leaveRef.id,
      action: "REQUEST_LEAVE",
      description: `${user.nama} mengajukan izin ${tipeIzin} (${startDate} s/d ${endDate}).`,
    });

    return res.status(201).json({ message: "Berhasil mengajukan izin." });
  } catch (e) {
    console.error("Create Leave Error:", e);
    return res
      .status(500)
      .json({ message: "Gagal memproses izin.", error: e.message });
  }
});

// ---------------------------------------------------------
// 2. GET LIST IZIN (Filter by Role)
// ---------------------------------------------------------
router.get("/list", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    if (!user.idCompany)
      return res.status(400).json({ message: "ID Company invalid." });

    let query = db
      .collection("companies")
      .doc(user.idCompany)
      .collection("leaves");

    if (user.role !== "admin") {
      query = query.where("userId", "==", user.email);
    }

    const snapshot = await query.orderBy("createdAt", "desc").get();

    if (snapshot.empty) {
      return res
        .status(200)
        .json({ message: "Tidak ada data perizinan.", data: [] });
    }

    const leaves = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      leaves.push({
        id: doc.id,
        ...data,
        startDate: data.startDate.toDate().toISOString().split("T")[0],
        endDate: data.endDate.toDate().toISOString().split("T")[0],
        createdAt: data.createdAt.toDate(),
      });
    });

    return res.status(200).json({
      message: "Data perizinan berhasil diambil.",
      data: leaves,
    });
  } catch (e) {
    console.error("Get Leaves Error:", e);
    if (e.code === 9 || e.message.includes("requires an index")) {
      return res
        .status(500)
        .json({ message: "Server Error: Index Firestore belum dibuat." });
    }
    return res.status(500).json({ message: "Server Error" });
  }
});

// ---------------------------------------------------------
// 3. PROSES IZIN (Terima / Tolak) - Admin Only
// ---------------------------------------------------------
router.put("/:leaveId/status", verifyToken, async (req, res) => {
  try {
    const { leaveId } = req.params;
    const { status, rejectionReason } = req.body;
    const user = req.user;

    if (user.role !== "admin") {
      return res
        .status(403)
        .json({ message: "Hanya Admin yang dapat memproses izin." });
    }

    if (!["approved", "rejected"].includes(status)) {
      return res
        .status(400)
        .json({ message: "Status harus 'approved' atau 'rejected'." });
    }

    const leaveRef = db
      .collection("companies")
      .doc(user.idCompany)
      .collection("leaves")
      .doc(leaveId);
    const leaveDoc = await leaveRef.get();

    if (!leaveDoc.exists) {
      return res.status(404).json({ message: "Data izin tidak ditemukan." });
    }

    const currentData = leaveDoc.data();

    if (currentData.status !== "pending") {
      return res
        .status(400)
        .json({ message: "Izin ini sudah diproses sebelumnya." });
    }

    const updatePayload = {
      status: status,
      processedBy: user.email,
      processedAt: Timestamp.now(), // FIX: Gunakan Timestamp langsung
      // FIX: Gunakan FieldValue langsung dari import
      history: FieldValue.arrayUnion({
        status: status,
        by: user.email,
        at: new Date(),
        reason: rejectionReason || "-",
      }),
    };

    if (status === "rejected" && rejectionReason) {
      updatePayload.rejectionReason = rejectionReason;
    }

    await leaveRef.update(updatePayload);

    const actionText = status === "approved" ? "menerima" : "menolak";

    await logCompanyActivity(user.idCompany, {
      actorEmail: user.email,
      actorName: user.nama,
      target: leaveId,
      action: status === "approved" ? "APPROVE_LEAVE" : "REJECT_LEAVE",
      description: `Admin ${user.nama} ${actionText} izin ${currentData.tipeIzin} dari ${currentData.userName}.`,
    });

    return res.status(200).json({ message: `Berhasil ${actionText} izin.` });
  } catch (e) {
    console.error("Process Leave Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

// ---------------------------------------------------------
// 4. HAPUS IZIN (Delete)
// ---------------------------------------------------------
router.delete("/:leaveId", verifyToken, async (req, res) => {
  try {
    const { leaveId } = req.params;
    const user = req.user;

    const leaveRef = db
      .collection("companies")
      .doc(user.idCompany)
      .collection("leaves")
      .doc(leaveId);
    const leaveDoc = await leaveRef.get();

    if (!leaveDoc.exists) {
      return res.status(404).json({ message: "Data izin tidak ditemukan." });
    }

    const data = leaveDoc.data();

    if (user.role !== "admin" && data.userId !== user.email) {
      return res
        .status(403)
        .json({ message: "Anda tidak berhak menghapus data ini." });
    }

    if (data.status !== "pending") {
      return res
        .status(400)
        .json({ message: "Izin yang sudah diproses tidak dapat dihapus." });
    }

    if (data.attachmentFileId) {
      try {
        if (data.attachmentPath) {
          await bucket.file(data.attachmentPath).delete();
        }
        await db
          .collection("companies")
          .doc(user.idCompany)
          .collection("files")
          .doc(data.attachmentFileId)
          .delete();
      } catch (err) {
        console.warn("Gagal hapus file attachment:", err.message);
      }
    }

    await leaveRef.delete();

    await logCompanyActivity(user.idCompany, {
      actorEmail: user.email,
      actorName: user.nama,
      target: leaveId,
      action: "DELETE_LEAVE",
      description: `${user.nama} menghapus pengajuan izin ${data.tipeIzin}.`,
    });

    return res.status(200).json({ message: "Berhasil menghapus izin." });
  } catch (e) {
    console.error("Delete Leave Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

module.exports = router;
