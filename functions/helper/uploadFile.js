/* eslint-disable */
/* eslint-disable */
require('dotenv').config();
const express = require("express");
const Busboy = require("busboy");
const path = require("path");
const { bucket } = require("../config/firebase");


const uploadFile = (req, folderName, fileNameFunc) => {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    let fileBuffer = null;
    let fileMime = null;
    let fileExt = null;

    busboy.on('file', (name, file, info) => {
      const { filename, mimeType } = info;
      fileMime = mimeType;
      fileExt = path.extname(filename);
      
      const chunks = [];
      file.on('data', (data) => chunks.push(data));
      file.on('end', () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    busboy.on('finish', async () => {
      if (!fileBuffer) return reject(new Error("Tidak ada file yang diupload"));

      try {
        const finalFileName = fileNameFunc(fileExt);
        const filePath = `${folderName}/${finalFileName}`;
        const fileRef = bucket.file(filePath);

        await fileRef.save(fileBuffer, {
          metadata: { contentType: fileMime },
          public: true 
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
// Kita buat const khusus disini agar route handler bersih
// dan mengembalikan data lengkap (Size, Original Name, URL)

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
        // Format: folder/{timestamp}_{safe_filename}
        const safeFileName = fileInfo.filename.replace(/[^a-zA-Z0-9.-]/g, "_");
        const storagePath = `${folderName}/${Date.now()}_${safeFileName}`;

        const fileRef = bucket.file(storagePath);

        // 2. Upload ke GCS
        await fileRef.save(fileBuffer, {
          metadata: { contentType: fileInfo.mimeType },
          public: true,
        });

        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;

        // 3. Hitung Ukuran
        const sizeBytes = fileBuffer.length;
        const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2) + " MB";

        // Return Object Lengkap
        resolve({
          publicUrl,
          storagePath,
          originalName: fileInfo.filename,
          mimeType: fileInfo.mimeType,
          sizeDisplay: sizeMB,
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
