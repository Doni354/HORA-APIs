/* eslint-disable */
const Busboy = require("busboy");
const path = require("path");
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

        await r2.send(
          new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: filePath,
            Body: fileBuffer,
            ContentType: fileMime,
          })
        );

        const publicUrl = `https://cdn.vorce.id/${filePath}`;
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
// HELPER: Upload File Berkas to Cloudflare R2 (Returns full metadata)
// ---------------------------------------------------------
const uploadFileBerkas = (req, folderName, multiplier = 1.1) => {
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

        const publicUrl = `https://cdn.vorce.id/${objectKey}`;
        
        const sizeBytes = Math.ceil(fileBuffer.length * multiplier);

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

// ---------------------------------------------------------
// HELPER: Generate Presigned PUT URL for R2
// Allows frontend to upload directly to R2 without going through Cloud Run.
// The presigned URL is scoped to a single objectKey and mimeType,
// and expires after expiresInSeconds (default: 5 minutes).
// ---------------------------------------------------------
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

/**
 * @param {string} objectKey       - R2 object key, e.g. "company_files/abc/uuid"
 * @param {string} contentType     - Exact MIME type the client must PUT with
 * @param {number} expiresInSeconds - URL lifetime in seconds (default 300 = 5 min)
 * @returns {Promise<string>} presigned PUT URL
 */
const generatePresignedPutUrl = async (objectKey, contentType, expiresInSeconds = 300) => {
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: objectKey,
    ContentType: contentType,
  });
  return getSignedUrl(r2, command, { expiresIn: expiresInSeconds });
};

module.exports = { uploadFile, uploadFileBerkas, formatFileSize, parseSizeStringToBytes, generatePresignedPutUrl };
