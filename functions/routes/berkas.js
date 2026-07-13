/* eslint-disable */
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { db } = require("../config/firebase");
const { verifyToken } = require("../middleware/token");
const { logCompanyActivity } = require("../helper/logCompanyActivity");
const Busboy = require("busboy");
const path = require("path");
const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const { uploadFileBerkas, formatFileSize, parseSizeStringToBytes, generatePresignedPutUrl } = require("../helper/uploadFile");
const { DeleteObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { r2 } = require("../config/r2");
const BUCKET_NAME = "vorce";
const CDN_BASE = "https://cdn.vorce.id";

// MIME type whitelist — executables, scripts, etc. are intentionally excluded
const ALLOWED_MIME_TYPES = new Set([
  // Images
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/bmp", "image/tiff",
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Text
  "text/plain", "text/csv",
  // Archives
  "application/zip", "application/x-zip-compressed", "application/x-rar-compressed",
  // Video
  "video/mp4", "video/quicktime", "video/x-msvideo",
  // Audio
  "audio/mpeg", "audio/mp4", "audio/wav",
]);

// Internal helper: delete a R2 object, swallowing errors (best-effort cleanup)
const deleteR2Object = async (key) => {
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
  } catch (err) {
    console.error("[R2 Delete] Best-effort delete failed for", key, err.message);
  }
};

// Internal helper: remove an entry from the upload pending registry
const clearPendingRegistry = async (registryId) => {
  try {
    await db.collection("_upload_pending").doc(registryId).delete();
  } catch (err) {
    console.error("[Registry] Failed to clear pending entry", registryId, err.message);
  }
};
// Internal helper: get storage padding multiplier from settings
let cachedMultiplier = null;
let lastMultiplierCacheTime = 0;
const MULTIPLIER_CACHE_TTL = 5 * 60 * 1000; // 5 menit

const getStorageMultiplier = async () => {
  try {
    const now = Date.now();
    // Return cached value jika TTL belum habis (agar API tetap cepat)
    if (cachedMultiplier !== null && (now - lastMultiplierCacheTime < MULTIPLIER_CACHE_TTL)) {
       return cachedMultiplier;
    }

    const docSnap = await db.collection("server_settings").doc("global").get();
    if (docSnap.exists) {
      const pct = docSnap.data().storagePaddingPercentage;
      if (pct !== undefined) {
          cachedMultiplier = 1 + (Number(pct) / 100);
          lastMultiplierCacheTime = now;
          return cachedMultiplier;
      }
    }
  } catch (err) {
    console.error("[Settings] Failed to fetch storage padding", err.message);
  }
  
  // Default padding fallback 10% jika gagal/belum disetting
  cachedMultiplier = 1.1;
  lastMultiplierCacheTime = Date.now();
  return cachedMultiplier;
};
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
        const multiplier = await getStorageMultiplier();
        result = await uploadFileBerkas(req, folderPath, multiplier);
    } catch (uploadError) {
        return res.status(500).json({ message: "Gagal upload ke server.", error: uploadError.message });
    }

    // 4. CEK KUOTA LAGI (Post-Upload Check)
    // Kita baru tau size asli file setelah selesai upload
    const newFileSize = result.sizeBytes;
    
    if (usedStorage + newFileSize > maxStorage) {
        // ROLLBACK: Hapus file yang barusan diupload karena melampaui batas
        try {
            await r2.send(
              new DeleteObjectCommand({
                Bucket: BUCKET_NAME,
                Key: decodeURIComponent(result.storagePath),
              })
            );
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
// POST /upload - Upload File dengan Cek Kuota Storage
// ---------------------------------------------------------
router.post("/upload-noLogs", verifyToken, async (req, res) => {
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
        const multiplier = await getStorageMultiplier();
        result = await uploadFileBerkas(req, folderPath, multiplier);
    } catch (uploadError) {
        return res.status(500).json({ message: "Gagal upload ke server.", error: uploadError.message });
    }

    // 4. CEK KUOTA LAGI (Post-Upload Check)
    // Kita baru tau size asli file setelah selesai upload
    const newFileSize = result.sizeBytes;
    
    if (usedStorage + newFileSize > maxStorage) {
        // ROLLBACK: Hapus file yang barusan diupload karena melampaui batas
        try {
            await r2.send(
              new DeleteObjectCommand({
                Bucket: BUCKET_NAME,
                Key: decodeURIComponent(result.storagePath),
              })
            );
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
// POST /presign - Generate Presigned URL untuk Upload Langsung ke R2
// ---------------------------------------------------------
// Orphan strategy: setiap presign menulis doc ke _upload_pending/{uuid}.
// Doc otomatis dihapus oleh /confirm-upload atau oleh scheduled cleanup
// (cleanupOrphanUploads) yang berjalan setiap jam.
// ---------------------------------------------------------
router.post("/presign", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    const { fileName, mimeType, fileSize: rawFileSize, category } = req.body;

    // 1. Validasi Akses
    if (!["admin", "staff"].includes(user.role)) {
      return res.status(403).json({ message: "Hanya Admin & Staff yang boleh upload." });
    }
    if (!user.idCompany) {
      return res.status(400).json({ message: "ID Company tidak valid." });
    }
    if (!fileName || !mimeType || rawFileSize == null) {
      return res.status(400).json({ message: "fileName, mimeType, dan fileSize wajib diisi." });
    }

    // 2. Validasi fileSize (pastikan number, bukan string dari FE)
    const actualFileSize = Number(rawFileSize);
    if (isNaN(actualFileSize) || actualFileSize <= 0) {
      return res.status(400).json({ message: "fileSize harus berupa angka positif (bytes)." });
    }
    const multiplier = await getStorageMultiplier();
    const fileSize = Math.ceil(actualFileSize * multiplier); // Add padding as requested

    // 3. Validasi MIME type
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return res.status(400).json({
        message: `Tipe file "${mimeType}" tidak diizinkan.`,
        code: "MIME_NOT_ALLOWED"
      });
    }

    // 4. Cek Kuota Storage (snapshot read — quota enforcement final ada di /confirm-upload via Transaction)
    const companyRef = db.collection("companies").doc(user.idCompany);
    const companyDoc = await companyRef.get();
    if (!companyDoc.exists) return res.status(404).json({ message: "Perusahaan tidak ditemukan." });

    const companyData = companyDoc.data();
    const maxStorage = companyData.maxStorage || 0;
    const usedStorage = companyData.usedStorage || 0;

    if (maxStorage === 0) {
      return res.status(402).json({ message: "Storage 0 GB. Upgrade paket perusahaan.", code: "NO_STORAGE_QUOTA" });
    }
    if (usedStorage >= maxStorage) {
      return res.status(400).json({ message: "Penyimpanan penuh! Hapus berkas lama atau upgrade paket.", code: "STORAGE_FULL" });
    }
    if (usedStorage + fileSize > maxStorage) {
      return res.status(400).json({
        message: `File terlalu besar (${formatFileSize(fileSize)}). Sisa kuota tidak mencukupi.`,
        code: "QUOTA_EXCEEDED"
      });
    }

    // 5. Generate UUID-based Object Key (collision-proof)
    const uuid = crypto.randomUUID();
    const ext = path.extname(fileName).toLowerCase() || "";
    const objectKey = `company_files/${user.idCompany}/${uuid}${ext}`;

    // 6. Generate Presigned URL
    const presignedUrl = await generatePresignedPutUrl(objectKey, mimeType, 300);

    // 7. Write to upload registry (orphan detection)
    const expiresAt = Timestamp.fromMillis(Date.now() + 15 * 60 * 1000); // 15 min
    await db.collection("_upload_pending").doc(uuid).set({
      objectKey,
      idCompany: user.idCompany,
      uploadedBy: user.email,
      declaredMimeType: mimeType,
      declaredFileSize: fileSize,
      category: category || "general",
      createdAt: Timestamp.now(),
      expiresAt,
    });

    return res.status(200).json({
      message: "Presigned URL berhasil dibuat. Upload dalam 5 menit, konfirmasi dalam 15 menit.",
      uploadUrl: presignedUrl,
      objectKey,
      registryId: uuid,       // Kirim ke /confirm-upload
      publicUrl: `${CDN_BASE}/${objectKey}`,
      expiresInSeconds: 300,
    });

  } catch (e) {
    console.error("Presign Error:", e);
    return res.status(500).json({ message: "Server Error", error: e.message });
  }
});

// ---------------------------------------------------------
// POST /confirm-upload - Konfirmasi Upload & Simpan Metadata ke Firestore
// Dipanggil FE SETELAH berhasil upload langsung ke R2.
// SOURCE OF TRUTH: HeadObjectCommand ke R2 (tidak percaya metadata dari FE).
// RACE CONDITION SAFE: Firestore Transaction untuk quota update.
// ---------------------------------------------------------
router.post("/confirm-upload", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    const { objectKey, registryId, category, withLogs } = req.body;
    // Catatan: fileName, mimeType, fileSize TIDAK diambil dari body —
    // semua metadata diambil dari R2 via HeadObjectCommand sebagai source of truth.

    // 1. Validasi Akses
    if (!["admin", "staff"].includes(user.role)) {
      return res.status(403).json({ message: "Hanya Admin & Staff yang boleh upload." });
    }
    if (!user.idCompany) {
      return res.status(400).json({ message: "ID Company tidak valid." });
    }
    if (!objectKey || !registryId) {
      return res.status(400).json({ message: "objectKey dan registryId wajib diisi." });
    }

    // 2. Validasi prefix objectKey (cegah user menyalahgunakan objectKey company lain)
    const expectedPrefix = `company_files/${user.idCompany}/`;
    if (!objectKey.startsWith(expectedPrefix)) {
      return res.status(403).json({ message: "objectKey tidak valid untuk perusahaan ini." });
    }

    // 3. Verifikasi registry — pastikan presign memang dibuat oleh user ini
    const registryRef = db.collection("_upload_pending").doc(registryId);
    const registryDoc = await registryRef.get();
    if (!registryDoc.exists) {
      return res.status(404).json({ message: "Registry tidak ditemukan atau sudah expired/dikonfirmasi.", code: "REGISTRY_NOT_FOUND" });
    }
    const registry = registryDoc.data();
    if (registry.uploadedBy !== user.email || registry.objectKey !== objectKey) {
      return res.status(403).json({ message: "Registry tidak cocok dengan user atau objectKey ini." });
    }

    // 4. HeadObjectCommand — verifikasi file benar-benar ada di R2
    //    Sekaligus ambil ContentLength & ContentType sebagai source of truth
    let realContentLength, realContentType;
    try {
      const multiplier = await getStorageMultiplier();
      const headResult = await r2.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: objectKey }));
      realContentLength = Math.ceil(headResult.ContentLength * multiplier);   // bytes, dari R2 (+ padding)
      realContentType   = headResult.ContentType;     // MIME, dari R2
    } catch (headErr) {
      // File belum/gagal upload ke R2
      return res.status(422).json({
        message: "File tidak ditemukan di storage. Pastikan upload ke R2 berhasil sebelum konfirmasi.",
        code: "FILE_NOT_IN_STORAGE"
      });
    }

    // 5. Validasi ulang ContentType dari R2 terhadap whitelist
    if (!ALLOWED_MIME_TYPES.has(realContentType)) {
      // File sudah terlanjur ada di R2 dengan type aneh — hapus dan tolak
      await deleteR2Object(objectKey);
      await clearPendingRegistry(registryId);
      return res.status(400).json({
        message: `Tipe file "${realContentType}" tidak diizinkan. File telah dihapus dari storage.`,
        code: "MIME_NOT_ALLOWED"
      });
    }

    // 6. Atomic quota check + metadata write via Firestore Transaction
    //    (mencegah race condition concurrent upload)
    const companyRef = db.collection("companies").doc(user.idCompany);
    let newDocRef;

    await db.runTransaction(async (t) => {
      const companySnap = await t.get(companyRef);
      if (!companySnap.exists) throw new Error("COMPANY_NOT_FOUND");

      const { maxStorage = 0, usedStorage = 0 } = companySnap.data();

      if (usedStorage + realContentLength > maxStorage) {
        throw new Error("QUOTA_EXCEEDED");
      }

      // Buat ref baru untuk file doc
      newDocRef = companyRef.collection("files").doc();

      const newFileDoc = {
        fileName: registry.objectKey.split("/").pop(), // nama dari objectKey (uuid.ext)
        storagePath: objectKey,
        downloadUrl: `${CDN_BASE}/${objectKey}`,
        mimeType: realContentType,             // dari R2, bukan FE
        size: formatFileSize(realContentLength), // dari R2, bukan FE
        sizeBytes: realContentLength,          // dari R2, bukan FE
        category: category || registry.category || "general",
        uploadedBy: user.email,
        uploaderName: user.nama || "User",
        uploaderRole: user.role,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
        updatedBy: null,
      };

      t.set(newDocRef, newFileDoc);
      t.update(companyRef, { usedStorage: FieldValue.increment(realContentLength) });
    });

    // 7. Hapus entry registry (tidak perlu atomic — cleanup jika gagal ditangani scheduler)
    await clearPendingRegistry(registryId);

    // 8. Log aktivitas
    if (withLogs !== false) {
      await logCompanyActivity(user.idCompany, {
        actorEmail: user.email,
        actorName: user.nama || "User",
        target: newDocRef.id,
        action: "UPLOAD_FILE",
        description: `Upload berkas (${category || registry.category || "general"}): ${formatFileSize(realContentLength)} — ${realContentType}`,
      });
    }

    return res.status(201).json({
      message: "Berkas berhasil dikonfirmasi dan disimpan.",
      data: {
        id: newDocRef.id,
        objectKey,
        downloadUrl: `${CDN_BASE}/${objectKey}`,
        mimeType: realContentType,
        size: formatFileSize(realContentLength),
        sizeBytes: realContentLength,
        category: category || registry.category || "general",
      },
    });

  } catch (e) {
    if (e.message === "QUOTA_EXCEEDED") {
      // Rollback: hapus file yg sudah terlanjur ada di R2 (opsional, tapi fair)
      if (req.body?.objectKey) await deleteR2Object(req.body.objectKey);
      if (req.body?.registryId) await clearPendingRegistry(req.body.registryId);
      return res.status(400).json({ message: "Kuota storage tidak cukup. File dihapus dari storage.", code: "QUOTA_EXCEEDED" });
    }
    if (e.message === "COMPANY_NOT_FOUND") {
      return res.status(404).json({ message: "Perusahaan tidak ditemukan." });
    }
    console.error("Confirm Upload Error:", e);
    return res.status(500).json({ message: "Server Error", error: e.message });
  }
});

// ---------------------------------------------------------
// EDIT NAMA BERKAS (Admin / Pemilik File)
// ---------------------------------------------------------
router.put("/:fileId", verifyToken, async (req, res) => {
  try {
    const { fileId } = req.params;
    const { newFileName } = req.body;
    const user = req.user;

    if (!newFileName) {
      return res.status(400).json({
        message: "Nama berkas baru wajib diisi.",
      });
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

    const fileData = fileDoc.data();

    const isAdmin = user.role === "admin";
    const isOwner = fileData.uploadedBy === user.email;

    if (!isAdmin && !isOwner) {
      return res.status(403).json({
        message: "Anda tidak memiliki izin mengedit berkas ini.",
      });
    }

    await fileRef.update({
      fileName: newFileName,
      updatedAt: Timestamp.now(),
      updatedBy: user.nama || user.email,
    });

    await logCompanyActivity(user.idCompany, {
      actorEmail: user.email,
      actorName: user.nama || user.email,
      target: fileId,
      action: "RENAME_FILE",
      description: `Mengubah nama berkas menjadi: ${newFileName}`,
    });

    return res.status(200).json({
      message: "Nama berkas berhasil diubah.",
    });

  } catch (e) {
    console.error("Rename File Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

// ---------------------------------------------------------
// DELETE BERKAS (Mengembalikan Kuota Storage + R2)
// ---------------------------------------------------------
router.delete("/:fileId", verifyToken, async (req, res) => {
  try {
    const { fileId } = req.params;
    const user = req.user;

    if (!user.idCompany) {
      return res.status(400).json({ message: "ID Company tidak valid." });
    }

    const companyRef = db.collection("companies").doc(user.idCompany);
    const fileRef = companyRef.collection("files").doc(fileId);

    let fileData = null;

    // 1️⃣ TRANSACTION DB
    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(fileRef);
      if (!snap.exists) throw new Error("FILE_NOT_FOUND");

      fileData = snap.data();

      const isAdmin = user.role === "admin";
      const isOwner = fileData.uploadedBy === user.email;

      if (!isAdmin && !isOwner) {
        throw new Error("FORBIDDEN");
      }

      transaction.delete(fileRef);
      transaction.update(companyRef, {
        usedStorage: FieldValue.increment(-(fileData.sizeBytes || 0)),
      });
    });

    // 2️⃣ DELETE STORAGE (OUTSIDE TRANSACTION)
    const deleteTasks = [];

    // ☁️ Cloudflare R2 (PRIMARY)
    if (fileData?.storagePath) {
      deleteTasks.push(
        r2.send(
          new DeleteObjectCommand({
            Bucket: BUCKET_NAME,
            Key: fileData.storagePath,
          })
        )
      );
    }

    // Removed Firebase Fallback since migration is complete.

    const results = await Promise.allSettled(deleteTasks);

    results.forEach(r => {
      if (r.status === "rejected") {
        console.warn("Gagal hapus storage:", r.reason?.message);
      }
    });

    // 3️⃣ LOG
    await logCompanyActivity(user.idCompany, {
      actorEmail: user.email,
      actorName: user.nama || user.email,
      target: fileId,
      action: "DELETE_FILE",
      description:
        user.role === "admin"
          ? "Admin menghapus berkas."
          : "Pemilik berkas menghapus berkas.",
    });

    return res.status(200).json({
      message: "Berkas berhasil dihapus.",
      storageResult: results.map(r => r.status),
    });

  } catch (e) {
    if (e.message === "FILE_NOT_FOUND") {
      return res.status(404).json({ message: "Berkas tidak ditemukan." });
    }
    if (e.message === "FORBIDDEN") {
      return res.status(403).json({
        message: "Anda tidak memiliki izin menghapus berkas ini.",
      });
    }

    console.error("Delete Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});



module.exports = router;
