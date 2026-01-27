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
// 3. UPDATE IZIN (Edit Data oleh Owner ATAU Proses Status oleh Admin)
// ---------------------------------------------------------
router.put("/:leaveId", verifyToken, async (req, res) => {
  try {
    const { leaveId } = req.params;
    const user = req.user;
    const body = req.body; // Data yang dikirim (bisa status, bisa data izin)

    // 1. Ambil Data Existing
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
    const isOwner = currentData.userId === user.email;
    const isAdmin = user.role === "admin";

    // Validasi Dasar Akses
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: "Anda tidak memiliki akses ke data ini." });
    }

    let updatePayload = {
      updatedAt: Timestamp.now(),
    };
    let logAction = "";
    let logDesc = "";

    // =========================================================
    // SKENARIO A: ADMIN MENGUBAH STATUS (Approve / Reject)
    // =========================================================
    if (body.status) {
      // Validasi: Hanya Admin yang boleh kirim field 'status'
      if (!isAdmin) {
        return res.status(403).json({ message: "Hanya Admin yang boleh mengubah status izin." });
      }

      // Validasi Input Status
      if (!["approved", "rejected", "pending"].includes(body.status)) {
        return res.status(400).json({ message: "Status tidak valid." });
      }

      updatePayload.status = body.status;
      updatePayload.processedBy = user.email;
      updatePayload.processedAt = Timestamp.now();
      
      // Tambah History
      updatePayload.history = FieldValue.arrayUnion({
        status: body.status,
        by: user.email,
        at: new Date(),
        reason: body.rejectionReason || "-",
      });

      // Jika Rejected, simpan alasannya
      if (body.status === "rejected" && body.rejectionReason) {
        updatePayload.rejectionReason = body.rejectionReason;
      }

      logAction = body.status === "approved" ? "APPROVE_LEAVE" : "REJECT_LEAVE";
      logDesc = `Admin ${user.nama} mengubah status menjadi ${body.status}.`;
    } 
    
    // =========================================================
    // SKENARIO B: OWNER MENGEDIT DATA (Reset ke Pending)
    // =========================================================
    else {
      // Validasi: Hanya Owner yang boleh edit data (sesuai request Anda)
      if (!isOwner) {
        return res.status(403).json({ message: "Hanya pembuat izin yang dapat mengedit data." });
      }

      // Validasi: Tidak boleh edit jika sudah Approved
      if (currentData.status === "approved") {
        return res.status(400).json({ message: "Izin yang sudah disetujui tidak dapat diedit." });
      }

      // Masukkan data baru ke payload
      if (body.tipeIzin) updatePayload.tipeIzin = body.tipeIzin;
      if (body.keterangan) updatePayload.keterangan = body.keterangan;
      if (body.startDate) updatePayload.startDate = new Date(body.startDate);
      if (body.endDate) updatePayload.endDate = new Date(body.endDate);

      // FORCE RESET STATUS KE PENDING (Karena data berubah)
      updatePayload.status = "pending";
      // Hapus alasan penolakan lama (jika ada) agar bersih
      updatePayload.rejectionReason = FieldValue.delete(); 

      updatePayload.history = FieldValue.arrayUnion({
        status: "edited",
        by: user.email,
        at: new Date(),
        note: "Data diedit oleh user (Status reset ke Pending)",
      });

      // --- LOGIC GANTI FILE (Jika ada fileId baru) ---
      if (body.fileId && body.fileId !== currentData.attachmentFileId) {
        // 1. Ambil info file baru
        const newFileRef = db.collection("companies").doc(user.idCompany).collection("files").doc(body.fileId);
        const newFileDoc = await newFileRef.get();

        if (!newFileDoc.exists) {
          return res.status(404).json({ message: "File baru tidak ditemukan." });
        }
        const newFileData = newFileDoc.data();

        // 2. Hapus file lama dari Storage (Cleanup)
        if (currentData.attachmentPath) {
          try {
            await bucket.file(currentData.attachmentPath).delete();
          } catch (err) {
            console.warn("Gagal hapus file lama:", err.message);
          }
        }

        // 3. Update metadata file baru
        await newFileRef.update({
          category: "LEAVE_ATTACHMENT",
          relatedTo: "Employee Leave (Edited)",
          updatedAt: Timestamp.now(),
        });

        // 4. Masukkan ke payload
        updatePayload.attachmentFileId = body.fileId;
        updatePayload.attachmentUrl = newFileData.downloadUrl;
        updatePayload.attachmentPath = newFileData.storagePath;
        updatePayload.attachmentName = newFileData.fileName;
      }

      logAction = "EDIT_LEAVE";
      logDesc = `${user.nama} mengedit data izin (Status reset ke Pending).`;
    }

    // 2. Eksekusi Update ke Firestore
    await leaveRef.update(updatePayload);

    // 3. Log Aktivitas
    await logCompanyActivity(user.idCompany, {
      actorEmail: user.email,
      actorName: user.nama,
      target: leaveId,
      action: logAction,
      description: logDesc,
    });

    return res.status(200).json({ 
      message: logAction === "EDIT_LEAVE" ? "Data berhasil diubah." : "Status berhasil diperbarui." 
    });

  } catch (e) {
    console.error("Update Leave Error:", e);
    return res.status(500).json({ message: "Server Error", error: e.message });
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
