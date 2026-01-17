/* eslint-disable */
const express = require("express");
const router = express.Router();
const { db, bucket } = require("../config/firebase");
const { verifyToken } = require("../middleware/token");
const { logCompanyActivity } = require("../helper/logCompanyActivity");
const Busboy = require("busboy");
const path = require("path");
const { Timestamp } = require("firebase-admin/firestore");
const { uploadFileBerkas } = require("../helper/uploadFile");

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
// URL: {{BaseUrl}}/api/files/list?category=reimburse
// URL: {{BaseUrl}}/api/files/list (Default: General + Null)
router.get("/list", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    const categoryFilter = req.query.category; // Bisa string atau undefined

    if (!user.idCompany) {
      return res.status(400).json({ message: "ID Company tidak valid." });
    }

    let query = db
      .collection("companies")
      .doc(user.idCompany)
      .collection("files")
      .orderBy("createdAt", "desc");

    // OPTIMASI: Jika user minta kategori spesifik, kita filter langsung di query
    if (categoryFilter) {
      query = query.where("category", "==", categoryFilter);
    }
    // JIKA KOSONG: Kita ambil semua dulu (karena query OR null+general susah di Firestore bareng orderBy)
    // Lalu kita filter di bawah.

    const snapshot = await query.get();

    if (snapshot.empty) {
      return res.status(200).json({ message: "Belum ada berkas.", data: [] });
    }

    const files = [];
    snapshot.forEach((doc) => {
      const data = doc.data();

      // LOGIKA FILTER MANUAL (Untuk kasus Default/Kosong)
      // Jika categoryFilter TIDAK ADA, kita hanya mau mengambil:
      // 1. Data yang category-nya "general"
      // 2. Data yang category-nya NULL/Undefined (legacy data)
      if (!categoryFilter) {
        // Jika data punya kategori DAN kategorinya bukan general, SKIP.
        // (Berarti ini file reimburse/tugas dsb yang tidak boleh muncul di list general)
        if (data.category && data.category !== "general") {
          return; 
        }
      }

      files.push({
        id: doc.id,
        fileName: data.fileName,
        downloadUrl: data.downloadUrl,
        mimeType: data.mimeType,
        size: data.size,
        category: data.category || "general", // Default tampilkan general jika null
        uploaderName: data.uploaderName,
        createdAt: data.createdAt ? data.createdAt.toDate() : null,
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
