/* eslint-disable */
const express = require("express");
const router = express.Router();
const Busboy = require("busboy");
const { db, admin } = require("../config/firebase");
const { verifyToken } = require("../middleware/token");
// IMPORT PENTING: Import FieldValue langsung dari sini agar tidak error undefined
const { Timestamp, FieldValue } = require("firebase-admin/firestore");

const bucket = admin.storage().bucket();

// ---------------------------------------------------------
// POST /create - Create New Task (JSON Body)
// ---------------------------------------------------------
// Content-Type: application/json
// Body: { "assignedTo": "email@user.com", "description": "Tugas baru" }
router.post("/create", verifyToken, async (req, res) => {
  try {
    // 1. Validasi Role Admin
    if (!req.user || req.user.role !== "admin") {
      return res.status(403).json({ 
        message: "Akses ditolak. Hanya Admin yang dapat membuat tugas." 
      });
    }

    // 2. Ambil data langsung dari JSON Body
    const { assignedTo, description } = req.body;
    const { idCompany, email: adminEmail } = req.user;

    // 3. Validasi Input
    if (!assignedTo || !description) {
      return res.status(400).json({ 
        message: "AssignedTo (Email User) dan Description wajib diisi." 
      });
    }

    // 4. Validasi User Target
    const targetUserRef = db.collection("users").doc(assignedTo);
    const targetUserDoc = await targetUserRef.get();

    if (!targetUserDoc.exists) {
      return res.status(404).json({ 
        message: `User dengan email ${assignedTo} tidak ditemukan.` 
      });
    }

    const targetUserData = targetUserDoc.data();
    if (targetUserData.idCompany !== idCompany) {
      return res.status(403).json({ 
        message: "User target tidak berada di perusahaan yang sama." 
      });
    }

    // 5. Buat Object Tugas
    const newTask = {
      companyId: idCompany,
      assignedTo: assignedTo,
      assignedToName: targetUserData.username || targetUserData.nama,
      assignedToPhoto: targetUserData.photoURL || null,
      createdBy: adminEmail,
      description: description,
      
      status: "Proses",
      statusCode: 1, // 1: Proses, 2: Tunda/Revisi, 3: Selesai
      
      attachments: [], // Array kosong
      
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    };

    // 6. Simpan ke Sub-Collection
    const docRef = await db
      .collection("companies")
      .doc(idCompany)
      .collection("tasks")
      .add(newTask);

    return res.status(201).json({
      message: "Tugas berhasil dibuat.",
      taskId: docRef.id,
      data: {
        id: docRef.id,
        ...newTask,
        createdAt: new Date().toISOString()
      },
    });

  } catch (error) {
    console.error("Error Create Task:", error);
    return res.status(500).json({ 
      message: "Server Error", 
      error: error.message 
    });
  }
});

// ---------------------------------------------------------
// POST /add-attachment - Menambah File/Text (Form-Data)
// ---------------------------------------------------------
router.post("/add-attachment", verifyToken, (req, res) => {
  const busboy = Busboy({ headers: req.headers });
  
  const fields = {};
  let fileBuffer = null;
  let fileInfo = {};

  busboy.on("field", (fieldname, val) => {
    fields[fieldname] = val;
  });

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
    try {
      const { taskId, text } = fields; 
      const { idCompany, email, role, nama } = req.user;

      if (!taskId) {
        return res.status(400).json({ message: "Task ID wajib diisi." });
      }

      // 1. Cek keberadaan Tugas
      const taskRef = db
        .collection("companies")
        .doc(idCompany)
        .collection("tasks")
        .doc(taskId);
      
      const taskDoc = await taskRef.get();

      if (!taskDoc.exists) {
        return res.status(404).json({ message: "Tugas tidak ditemukan." });
      }

      // 2. Upload File (Jika ada buffer)
      let attachmentUrl = null;
      let attachmentPath = null;
      let attachmentType = "text"; 

      if (fileBuffer) {
        attachmentType = "file";
        const safeFileName = fileInfo.filename.replace(/[^a-zA-Z0-9.-]/g, "_");
        const timestamp = Date.now();
        const storagePath = `companies/${idCompany}/tasks/${taskId}/${timestamp}_${safeFileName}`;
        
        const fileRef = bucket.file(storagePath);
        await fileRef.save(fileBuffer, {
          metadata: { contentType: fileInfo.mimeType },
          public: true,
        });

        attachmentUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
        attachmentPath = storagePath;
      }

      // Validasi: Harus ada text ATAU file
      if (!text && !fileBuffer) {
        return res.status(400).json({ message: "Harus menyertakan text atau file." });
      }

      // 3. Susun Object Attachment
      const newAttachment = {
        id: db.collection("_").doc().id, // Random ID
        type: attachmentType,
        text: text || "",
        fileUrl: attachmentUrl || null,
        fileName: fileInfo.filename || null,
        filePath: attachmentPath || null,
        senderEmail: email,
        senderName: nama || email,
        senderRole: role,
        createdAt: Timestamp.now()
      };

      // 4. Update Database (SOLUSI ERROR: Gunakan FieldValue yang di-import)
      await taskRef.update({
        attachments: FieldValue.arrayUnion(newAttachment),
        updatedAt: Timestamp.now()
      });

      return res.status(200).json({
        message: "Attachment berhasil ditambahkan.",
        data: {
            ...newAttachment,
            createdAt: new Date().toISOString()
        }
      });

    } catch (error) {
      console.error("Error Add Attachment:", error);
      return res.status(500).json({ message: "Server Error", error: error.message });
    }
  });

  if (req.rawBody) busboy.end(req.rawBody);
  else req.pipe(busboy);
});

module.exports = router;