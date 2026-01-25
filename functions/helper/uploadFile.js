/* eslint-disable */
const Busboy = require("busboy");
const path = require("path");
const { bucket } = require("../config/firebase");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { r2 } = require("../config/r2");
const BUCKET_NAME = "vorce";
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
// ---------------------------------------------------------
// HELPER: Convert "1.17 MB" string back to bytes number
// ---------------------------------------------------------
const parseSizeStringToBytes = (sizeString) => {
  if (!sizeString) return 0;
  
  // Kalau ternyata di database kesimpannya angka, langsung return
  if (typeof sizeString === 'number') return sizeString;

  const parts = sizeString.split(' '); // Pisahkan "1.17" dan "MB"
  
  // Kalau formatnya aneh (gak ada spasi atau array < 2), anggap 0
  if (parts.length < 2) {
      // Coba parse langsung siapa tau isinya string angka "12345"
      return Number(sizeString) || 0; 
  }

  const value = parseFloat(parts[0]);
  const unit = parts[1].toUpperCase(); // Pastikan huruf besar (MB, KB)

  const k = 1024;
  
  switch (unit) {
    case 'KB': return value * k;
    case 'MB': return value * Math.pow(k, 2);
    case 'GB': return value * Math.pow(k, 3);
    case 'TB': return value * Math.pow(k, 4);
    default: return value; // Asumsi Bytes (B)
  }
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

// ---------------------------------------------------------
// HELPER: Upload File Berkas to Cloudflare R2
// ---------------------------------------------------------
const uploadFileBerkasR2 = (req, folderName) => {
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
      if (!fileBuffer) {
        return reject(new Error("Tidak ada file yang diupload."));
      }

      try {
        const safeFileName = fileInfo.filename.replace(/[^a-zA-Z0-9.-]/g, "_");
        const objectKey = `${folderName}/${Date.now()}_${safeFileName}`;

        await r2.send(
          new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: objectKey,
            Body: fileBuffer,
            ContentType: fileInfo.mimeType,
          })
        );

        const publicUrl = `https://609723b5d7cc16b02d6454eebea06c5a.r2.cloudflarestorage.com/${BUCKET_NAME}/${objectKey}`;

        const sizeBytes = fileBuffer.length;

        resolve({
          publicUrl,
          storagePath: objectKey,
          originalName: fileInfo.filename,
          mimeType: fileInfo.mimeType,
          sizeDisplay: formatFileSize(sizeBytes),
          sizeBytes,
        });
      } catch (err) {
        reject(err);
      }
    });

    if (req.rawBody) {
      busboy.end(req.rawBody);
    } else {
      req.pipe(busboy);
    }
  });
};

module.exports = { uploadFile, uploadFileBerkas, formatFileSize, parseSizeStringToBytes };
