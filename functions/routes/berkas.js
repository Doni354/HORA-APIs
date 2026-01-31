/* eslint-disable */
const express = require("express");
const router = express.Router();
const { db, bucket } = require("../config/firebase");
const { verifyToken } = require("../middleware/token");
const { logCompanyActivity } = require("../helper/logCompanyActivity");
const Busboy = require("busboy");
const path = require("path");
const { Timestamp } = require("firebase-admin/firestore");
const {uploadFileBerkas,formatFileSize,parseSizeStringToBytes, } = require("../helper/uploadFile");

// ---------------------------------------------------------
// POST /upload - Upload File dengan Kategori
// ---------------------------------------------------------
// URL: {{BaseUrl}}/api/files/upload?category=reimburse
router.post("/upload", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    // Ambil category dari Query Param, default ke "general" jika kosong
    const category = req.query.category || "general";

    // 1. Validasi Akses
    if (!["admin", "staff"].includes(user.role)) {
      return res.status(403).json({
        message: "Akses ditolak. Hanya Admin & Staff yang boleh upload.",
      });
    }

    if (!user.idCompany) {
      return res.status(400).json({ message: "ID Company tidak valid." });
    }

    // 2. Panggil Helper Upload
    const folderPath = `company_files/${user.idCompany}`;
    const result = await uploadFileBerkas(req, folderPath);

    // 3. Simpan Metadata ke Firestore
    const newFileDoc = {
      fileName: result.originalName,
      storagePath: result.storagePath,
      downloadUrl: result.publicUrl,
      mimeType: result.mimeType,
      size: result.sizeDisplay,
      sizeBytes: result.sizeBytes,

      // Metadata category
      category: category,

      uploadedBy: user.email,
      uploaderName: user.nama || "User",
      uploaderRole: user.role,

      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      updatedBy: null,
    };

    const docRef = await db
      .collection("companies")
      .doc(user.idCompany)
      .collection("files")
      .add(newFileDoc);

    // 4. Log Aktivitas
    await logCompanyActivity(user.idCompany, {
      actorEmail: user.email,
      actorName: user.nama || "User",
      target: docRef.id,
      action: "UPLOAD_FILE",
      description: `Mengupload berkas (${category}): ${result.originalName}`,
    });

    return res.status(201).json({
      message: "Berkas berhasil diupload.",
      fileId: docRef.id,
      data: {
        id: docRef.id,
        ...newFileDoc,
      },
    });
  } catch (e) {
    console.error("Upload File Error:", e);
    return res.status(500).json({
      message: "Gagal mengupload file.",
      error: e.message,
    });
  }
});

// ---------------------------------------------------------
// GET /list - List Files (Filter by Category)
// ---------------------------------------------------------
// URL: {{BaseUrl}}/api/files/list?category=ALL        <-- AMBIL SEMUA
// URL: {{BaseUrl}}/api/files/list?category=reimburse  <-- KATEGORI KHUSUS
// URL: {{BaseUrl}}/api/files/list                     <-- DEFAULT (General + Null)
router.get("/list", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    const categoryFilter = req.query.category; // Bisa 'ALL', string lain, atau undefined

    if (!user.idCompany) {
      return res.status(400).json({ message: "ID Company tidak valid." });
    }

    let query = db
      .collection("companies")
      .doc(user.idCompany)
      .collection("files")
      .orderBy("createdAt", "desc");

    // OPTIMASI QUERY:
    // 1. Jika 'ALL', jangan pakai .where(), biarkan ambil semua.
    // 2. Jika kosong (undefined), jangan pakai .where() dulu (filter manual nanti).
    // 3. Jika ada isi DAN bukan 'ALL', baru filter di database.
    if (categoryFilter && categoryFilter !== "ALL") {
      query = query.where("category", "==", categoryFilter);
    }

    const snapshot = await query.get();

    if (snapshot.empty) {
      return res.status(200).json({ message: "Belum ada berkas.", data: [] });
    }

    const files = [];
    snapshot.forEach((doc) => {
      const data = doc.data();

      // LOGIKA FILTER MANUAL
      // Kita hanya filter manual jika user TIDAK minta 'ALL' DAN TIDAK minta kategori spesifik.
      // Artinya, jika categoryFilter kosong, jalankan logika Default Group.
      if (!categoryFilter && categoryFilter !== "ALL") {
        // Logika Default: Hanya General atau Null/Undefined
        if (data.category && data.category !== "general") {
          return; // Skip kategori lain (reimburse, dll)
        }
      }

      files.push({
        id: doc.id,
        fileName: data.fileName,
        downloadUrl: data.downloadUrl,
        mimeType: data.mimeType,
        size: data.size,
        category: data.category || "general",
        uploaderName: data.uploaderName,
        createdAt: data.createdAt ? data.createdAt.toDate() : null,
        updatedAt: data.updatedAt || null,
        updatedBy: data.updatedBy || null
      });
    });

    return res.status(200).json({
      message: "Data berkas berhasil diambil.",
      data: files,
    });
  } catch (e) {
    console.error("Get Files Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

// ---------------------------------------------------------
// GET /total-size - Get Total Size (Default: General + Null + Undefined)
// ---------------------------------------------------------
router.get("/total-size", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    const categoryFilter = req.query.category; // Bisa 'ALL', string lain, atau undefined

    if (!user.idCompany) {
      return res.status(400).json({ message: "ID Company tidak valid." });
    }

    let query = db
      .collection("companies")
      .doc(user.idCompany)
      .collection("files");

    // Optimasi select fields
    query = query.select("size", "category");

    // LOGIKA QUERY DATABASE:
    // Hanya pasang .where jika ada kategori spesifik DAN bukan 'ALL'
    if (categoryFilter && categoryFilter !== "ALL") {
      query = query.where("category", "==", categoryFilter);
    }

    const snapshot = await query.get();

    let totalBytes = 0;
    let fileCount = 0;

    if (snapshot.empty) {
      return res.status(200).json({
        message: "Total size berhasil dihitung.",
        totalSize: "0 B",
        totalBytes: 0,
        fileCount: 0,
      });
    }

    snapshot.forEach((doc) => {
      const data = doc.data();

      // LOGIKA FILTER MANUAL (STRICT)
      // Jalankan hanya jika user TIDAK minta 'ALL' DAN categoryFilter kosong (mode default)
      if (!categoryFilter && categoryFilter !== "ALL") {
        const isDefaultGroup = !data.category || data.category === "general";

        // Jika bukan bagian dari default group, skip
        if (!isDefaultGroup) return;
      }

      // Parse string "1.17 MB" ke bytes angka
      const sizeInBytes = parseSizeStringToBytes(data.size);

      totalBytes += sizeInBytes;
      fileCount++;
    });

    return res.status(200).json({
      message: "Total size berhasil dihitung.",
      totalSize: formatFileSize(totalBytes),
      totalBytes: totalBytes,
      fileCount: fileCount,
    });
  } catch (e) {
    console.error("Get Total Size Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});
// ---------------------------------------------------------
// 3. EDIT NAMA BERKAS (Rename)
// ---------------------------------------------------------
router.put("/:fileId", verifyToken, async (req, res) => {
  try {
    const { fileId } = req.params;
    const { newFileName } = req.body; // Nama baru (tanpa ekstensi gpp, atau full string)
    const user = req.user;

    if (!newFileName) {
      return res.status(400).json({ message: "Nama berkas baru wajib diisi." });
    }

    // Security: Hanya Admin yang boleh edit (atau uploader aslinya, opsional)
    // Di sini kita set Admin only biar aman
    if (user.role !== "admin") {
      return res
        .status(403)
        .json({ message: "Hanya Admin yang boleh mengedit berkas." });
    }

    const fileRef = db
      .collection("companies")
      .doc(user.idCompany)
      .collection("files")
      .doc(fileId);
    const fileDoc = await fileRef.get();

    if (!fileDoc.exists) {
      return res.status(404).json({ message: "Berkas tidak ditemukan." });
    }

    // Kita hanya update Display Name di Database.
    // Tidak perlu rename fisik file di Storage (karena mahal resource & url bisa putus)
    await fileRef.update({
      fileName: newFileName,
      updatedAt: Timestamp.now(),
      updatedBy: user.nama,
    });

    await logCompanyActivity(user.idCompany, {
      actorEmail: user.email,
      actorName: user.nama || "Admin",
      target: fileId,
      action: "RENAME_FILE",
      description: `Admin mengubah nama berkas menjadi: ${newFileName}`,
    });

    return res.status(200).json({ message: "Nama berkas berhasil diubah." });
  } catch (e) {
    console.error("Rename File Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

// ---------------------------------------------------------
// 4. HAPUS BERKAS (Delete)
// ---------------------------------------------------------
router.delete("/:fileId", verifyToken, async (req, res) => {
  try {
    const { fileId } = req.params;
    const user = req.user;

    // Security: Hanya Admin
    if (user.role !== "admin") {
      return res
        .status(403)
        .json({ message: "Hanya Admin yang boleh menghapus berkas." });
    }

    const fileRef = db
      .collection("companies")
      .doc(user.idCompany)
      .collection("files")
      .doc(fileId);
    const fileDoc = await fileRef.get();

    if (!fileDoc.exists) {
      return res
        .status(404)
        .json({ message: "Berkas tidak ditemukan atau sudah dihapus." });
    }

    const data = fileDoc.data();

    // 1. Hapus Fisik dari Google Cloud Storage
    if (data.storagePath) {
      try {
        await bucket.file(data.storagePath).delete();
        console.log("Deleted file from storage:", data.storagePath);
      } catch (storageErr) {
        console.warn(
          "Gagal hapus fisik file (mungkin sudah hilang):",
          storageErr.message
        );
        // Lanjut aja hapus DB-nya biar bersih
      }
    }

    // 2. Hapus Metadata dari Firestore
    await fileRef.delete();

    // 3. Log Aktivitas
    await logCompanyActivity(user.idCompany, {
      actorEmail: user.email,
      actorName: user.nama || "Admin",
      target: fileId,
      action: "DELETE_FILE",
      description: `Admin menghapus berkas: ${data.fileName}`,
    });

    return res
      .status(200)
      .json({ message: "Berkas berhasil dihapus permanen." });
  } catch (e) {
    console.error("Delete File Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

module.exports = router;
