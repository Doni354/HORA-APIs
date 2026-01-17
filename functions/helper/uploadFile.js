/* eslint-disable */
const Busboy = require("busboy");
const path = require("path");
const { bucket } = require("../config/firebase");

// Helper sederhana untuk format size
const formatFileSize = (bytes) => {
  if (bytes === 0) return "0 B";

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];

  // Mencari index satuan (0=B, 1=KB, 2=MB, dst)
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  // Menghitung nilai sesuai satuan
  const value = parseFloat((bytes / Math.pow(k, i)).toFixed(2));

  return `${value} ${sizes[i]}`;
};

const uploadFile = (req, folderName, fileNameFunc) => {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    let fileBuffer = null;
    let fileMime = null;
    let fileExt = null;

    busboy.on("file", (name, file, info) => {
      const { filename, mimeType } = info;
      fileMime = mimeType;
      fileExt = path.extname(filename);

      const chunks = [];
      file.on("data", (data) => chunks.push(data));
      file.on("end", () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    busboy.on("finish", async () => {
      if (!fileBuffer) return reject(new Error("Tidak ada file yang diupload"));

      try {
        const finalFileName = fileNameFunc(fileExt);
        const filePath = `${folderName}/${finalFileName}`;
        const fileRef = bucket.file(filePath);

        await fileRef.save(fileBuffer, {
          metadata: { contentType: fileMime },
          public: true,
        });

        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
        resolve(publicUrl);
      } catch (e) {
        reject(e);
      }
    });

    if (req.rawBody) {
      busboy.end(req.rawBody);
    } else {
      req.pipe(busboy);
    }
  });
};

// ---------------------------------------------------------
// HELPER: Upload File Berkas (Returns Detail Metadata)
// ---------------------------------------------------------
const uploadFileBerkas = (req, folderName) => {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    let fileBuffer = null;
    let fileInfo = {};

    busboy.on("file", (fieldname, file, info) => {
      const { filename, mimeType } = info;
      fileInfo = { filename, mimeType };

      const chunks = [];
      file.on("data", (data) => chunks.push(data));
      file.on("end", () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    busboy.on("finish", async () => {
      if (!fileBuffer)
        return reject(new Error("Tidak ada file yang diupload."));

      try {
        // 1. Generate Nama File Unik
        const safeFileName = fileInfo.filename.replace(/[^a-zA-Z0-9.-]/g, "_");
        const storagePath = `${folderName}/${Date.now()}_${safeFileName}`;

        const fileRef = bucket.file(storagePath);

        // 2. Upload ke GCS
        await fileRef.save(fileBuffer, {
          metadata: { contentType: fileInfo.mimeType },
          public: true,
        });

        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;

        // 3. Hitung Ukuran Dinamis (IMPROVED)
        const sizeBytes = fileBuffer.length;
        const sizeDisplay = formatFileSize(sizeBytes); // Pakai helper di atas

        // Return Object Lengkap
        resolve({
          publicUrl,
          storagePath,
          originalName: fileInfo.filename,
          mimeType: fileInfo.mimeType,
          sizeDisplay: sizeDisplay, // Contoh: "500 B", "12 KB", "1.5 MB"
          sizeBytes: sizeBytes,
        });
      } catch (e) {
        reject(e);
      }
    });

    if (req.rawBody) {
      busboy.end(req.rawBody);
    } else {
      req.pipe(busboy);
    }
  });
};

module.exports = { uploadFile, uploadFileBerkas };
