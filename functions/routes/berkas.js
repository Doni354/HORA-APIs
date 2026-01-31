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
const { FieldValue } = require("firebase-admin/firestore"); // Import FieldValue

// ---------------------------------------------------------
// POST /upload - Upload File dengan Cek Kuota Storage
// ---------------------------------------------------------
router.post("/upload", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    const category = req.query.category || "general";

    // 1. Validasi Akses
    if (!["admin", "staff"].includes(user.role)) {
      return res.status(403).json({ message: "Hanya Admin & Staff yang boleh upload." });
    }
    if (!user.idCompany) {
      return res.status(400).json({ message: "ID Company tidak valid." });
    }

    // 2. CEK KUOTA STORAGE (Pre-Upload Check)
    const companyRef = db.collection("companies").doc(user.idCompany);
    const companyDoc = await companyRef.get();
    
    if (!companyDoc.exists) return res.status(404).json({ message: "Perusahaan tidak ditemukan." });
    
    const companyData = companyDoc.data();
    const maxStorage = companyData.maxStorage || 0; // Default 0 (Locked)
    const usedStorage = companyData.usedStorage || 0;

    // A. Jika Max Storage 0, berarti belum berlangganan/aktivasi
    if (maxStorage === 0) {
        return res.status(402).json({ 
            message: "Penyimpanan Anda 0 GB. Silakan upgrade paket perusahaan untuk mulai mengunggah berkas.",
            code: "NO_STORAGE_QUOTA"
        });
    }

    // B. Jika sudah penuh sebelum upload
    if (usedStorage >= maxStorage) {
        return res.status(400).json({ 
            message: "Penyimpanan penuh! Hapus berkas lama atau upgrade paket.",
            code: "STORAGE_FULL"
        });
    }

    // 3. Proses Upload ke Cloud Storage
    const folderPath = `company_files/${user.idCompany}`;
    let result;
    
    try {
        result = await uploadFileBerkas(req, folderPath);
    } catch (uploadError) {
        return res.status(500).json({ message: "Gagal upload ke server.", error: uploadError.message });
    }

    // 4. CEK KUOTA LAGI (Post-Upload Check)
    // Kita baru tau size asli file setelah selesai upload
    const newFileSize = result.sizeBytes;
    
    if (usedStorage + newFileSize > maxStorage) {
        // ROLLBACK: Hapus file yang barusan diupload karena melampaui batas
        try {
            await bucket.file(result.storagePath).delete();
        } catch (delErr) {
            console.error("Gagal rollback file:", delErr);
        }

        return res.status(400).json({ 
            message: `File terlalu besar (${result.sizeDisplay}). Sisa kuota tidak mencukupi.`,
            code: "QUOTA_EXCEEDED"
        });
    }

    // 5. Simpan Metadata & Update Kuota Terpakai
    const newFileDoc = {
      fileName: result.originalName,
      storagePath: result.storagePath,
      downloadUrl: result.publicUrl,
      mimeType: result.mimeType,
      size: result.sizeDisplay,
      sizeBytes: result.sizeBytes, // Simpan bytes untuk perhitungan
      category: category,
      uploadedBy: user.email,
      uploaderName: user.nama || "User",
      uploaderRole: user.role,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      updatedBy: null,
    };

    // Jalankan Transaction/Batch agar atomik (Simpan File + Update Used Storage)
    const batch = db.batch();
    
    // A. Add File Doc
    const newDocRef = companyRef.collection("files").doc();
    batch.set(newDocRef, newFileDoc);

    // B. Increment Used Storage
    batch.update(companyRef, {
        usedStorage: FieldValue.increment(newFileSize)
    });

    await batch.commit();

    // 6. Log Aktivitas
    await logCompanyActivity(user.idCompany, {
      actorEmail: user.email,
      actorName: user.nama || "User",
      target: newDocRef.id,
      action: "UPLOAD_FILE",
      description: `Mengupload berkas (${category}): ${result.originalName} (${result.sizeDisplay})`,
    });

    return res.status(201).json({
      message: "Berkas berhasil diupload.",
      data: { id: newDocRef.id, ...newFileDoc },
    });

  } catch (e) {
    console.error("Upload Error:", e);
    return res.status(500).json({ message: "Server Error", error: e.message });
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
// DELETE BERKAS (Mengembalikan Kuota Storage)
// ---------------------------------------------------------
router.delete("/:fileId", verifyToken, async (req, res) => {
  try {
    const { fileId } = req.params;
    const user = req.user;

    // Security: Hanya Admin
    if (user.role !== "admin") {
      return res.status(403).json({ message: "Hanya Admin yang boleh menghapus berkas." });
    }

    const companyRef = db.collection("companies").doc(user.idCompany);
    const fileRef = companyRef.collection("files").doc(fileId);
    
    // Gunakan Transaction untuk memastikan konsistensi hapus + update kuota
    await db.runTransaction(async (transaction) => {
        const fileDoc = await transaction.get(fileRef);
        if (!fileDoc.exists) throw new Error("FILE_NOT_FOUND");
        
        const data = fileDoc.data();
        const fileSizeToDelete = data.sizeBytes || 0; // Ambil size bytes

        // 1. Delete Metadata
        transaction.delete(fileRef);

        // 2. Decrement Used Storage
        // Pakai increment negatif untuk mengurangi
        transaction.update(companyRef, {
            usedStorage: FieldValue.increment(-fileSizeToDelete)
        });

        // 3. Hapus Fisik di Luar Transaksi (atau di sini, tapi promise bucket harus ditunggu)
        // Kita simpan info path untuk dihapus setelah transaksi sukses
        // (Tapi dalam firebase function, lebih aman hapus fisik belakangan atau biarkan async)
        if (data.storagePath) {
             bucket.file(data.storagePath).delete().catch(err => 
                console.warn("Gagal hapus fisik:", err.message)
            );
        }

        // Log Aktivitas (di luar transaksi biasanya, tapi logic kita butuh await)
        // Kita biarkan log dieksekusi setelah response saja atau disini tidak apa2.
    });

    await logCompanyActivity(user.idCompany, {
      actorEmail: user.email,
      actorName: user.nama || "Admin",
      target: fileId,
      action: "DELETE_FILE",
      description: `Admin menghapus berkas.`,
    });

    return res.status(200).json({ message: "Berkas berhasil dihapus & kuota dikembalikan." });

  } catch (e) {
    if (e.message === "FILE_NOT_FOUND") {
        return res.status(404).json({ message: "Berkas tidak ditemukan." });
    }
    console.error("Delete Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

module.exports = router;
