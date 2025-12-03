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

module.exports = { uploadFile };
