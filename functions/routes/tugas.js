/* eslint-disable */
const express = require("express");
const router = express.Router();
const { db } = require("../config/firebase");
const { verifyToken } = require("../middleware/token");
const { Timestamp, FieldValue } = require("firebase-admin/firestore");
// Sesuaikan path ini dengan struktur folder kamu
const { logCompanyActivity } = require("../helper/logCompanyActivity");

// ---------------------------------------------------------
// HELPER INTERNAL: Prepare Attachment Object
// ---------------------------------------------------------
// Digunakan oleh add-attachment dan update-status agar tidak duplikasi code
const prepareAttachment = async (idCompany, text, fileId, user) => {
  let fileData = null;

  // Lookup File jika fileId ada
  if (fileId) {
    const fileDoc = await db
      .collection("companies")
      .doc(idCompany)
      .collection("files")
      .doc(fileId)
      .get();

    if (fileDoc.exists) {
      const rawFile = fileDoc.data();
      fileData = {
        fileId: fileId,
        fileName: rawFile.fileName,
        fileUrl: rawFile.downloadUrl,
        mimeType: rawFile.mimeType,
        size: rawFile.size,
      };
    }
  }

  // Jika tidak ada text dan tidak ada file valid, return null
  if (!text && !fileData) return null;

  const attachmentId = db.collection("_").doc().id;
  
  return {
    id: attachmentId,
    type: fileData ? "file" : "text",
    text: text || "",
    ...(fileData && { file: fileData }), // Spread operator conditional
    senderEmail: user.email,
    senderName: user.username || user.nama || "User",
    senderRole: user.role,
    createdAt: Timestamp.now(),
  };
};

// ---------------------------------------------------------
// GET /list - Get All Tasks (Admin sees all, User sees assigned)
// ---------------------------------------------------------
router.get("/list", verifyToken, async (req, res) => {
  try {
    const { idCompany, role, email } = req.user;

    let query = db
      .collection("companies")
      .doc(idCompany)
      .collection("tasks")
      .orderBy("updatedAt", "desc"); // Urutkan dari yg update terakhir

    // Jika bukan Admin, filter hanya tugas milik dia
    if (role !== "admin") {
      query = query.where("assignedTo", "==", email);
    }

    const snapshot = await query.get();

    if (snapshot.empty) {
      return res.status(200).json({ message: "Tidak ada tugas.", data: [] });
    }

    const tasks = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      // Konversi Timestamp ke String untuk FE
      createdAt: doc.data().createdAt?.toDate().toISOString(),
      updatedAt: doc.data().updatedAt?.toDate().toISOString(),
    }));

    return res.status(200).json({
      message: "Data tugas berhasil diambil.",
      data: tasks,
    });
  } catch (error) {
    console.error("Error Get List Task:", error);
    return res.status(500).json({ message: "Server Error", error: error.message });
  }
});

// ---------------------------------------------------------
// POST /create - Create New Task (JSON Body)
// ---------------------------------------------------------
router.post("/create", verifyToken, async (req, res) => {
  try {
    // 1. Validasi Admin
    if (!req.user || req.user.role !== "admin") {
      return res.status(403).json({
        message: "Akses ditolak. Hanya Admin yang dapat membuat tugas.",
      });
    }

    const { assignedTo, description } = req.body;
    const { idCompany, email: adminEmail, nama: adminName } = req.user;

    if (!assignedTo || !description) {
      return res.status(400).json({
        message: "AssignedTo (Email User) dan Description wajib diisi.",
      });
    }

    // 2. Validasi User Target
    const targetUserRef = db.collection("users").doc(assignedTo);
    const targetUserDoc = await targetUserRef.get();

    if (!targetUserDoc.exists) {
      return res.status(404).json({
        message: `User dengan email ${assignedTo} tidak ditemukan.`,
      });
    }

    const targetUserData = targetUserDoc.data();
    if (targetUserData.idCompany !== idCompany) {
      return res.status(403).json({
        message: "User target tidak berada di perusahaan yang sama.",
      });
    }

    // 3. Buat Object Tugas
    const newTask = {
      companyId: idCompany,
      assignedTo: assignedTo,
      assignedToName: targetUserData.username || targetUserData.nama,
      assignedToPhoto: targetUserData.photoURL || null,
      createdBy: adminEmail,
      description: description,
      status: "Proses",
      statusCode: 1,
      attachments: [],
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    };

    const docRef = await db
      .collection("companies")
      .doc(idCompany)
      .collection("tasks")
      .add(newTask);

    // 4. LOG AKTIVITAS
    await logCompanyActivity(idCompany, {
      actorEmail: adminEmail,
      actorName: adminName || "Admin",
      target: assignedTo,
      action: "CREATE_TASK",
      description: `Membuat tugas baru untuk ${targetUserData.username || assignedTo}`,
    });

    return res.status(201).json({
      message: "Tugas berhasil dibuat.",
      taskId: docRef.id,
      data: {
        id: docRef.id,
        ...newTask,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Error Create Task:", error);
    return res
      .status(500)
      .json({ message: "Server Error", error: error.message });
  }
});

// ---------------------------------------------------------
// POST /add-attachment - JSON Body (Relasi ke File ID)
// ---------------------------------------------------------
router.post("/add-attachment", verifyToken, async (req, res) => {
  try {
    const { taskId, text, fileId } = req.body;
    const { idCompany, email, nama } = req.user;

    if (!taskId) return res.status(400).json({ message: "Task ID wajib diisi." });
    if (!text && !fileId) return res.status(400).json({ message: "Isi text atau fileId." });

    const taskRef = db
      .collection("companies")
      .doc(idCompany)
      .collection("tasks")
      .doc(taskId);

    const taskDoc = await taskRef.get();
    if (!taskDoc.exists) {
      return res.status(404).json({ message: "Tugas tidak ditemukan." });
    }

    // 1. Prepare Attachment (Pake Helper)
    const newAttachment = await prepareAttachment(idCompany, text, fileId, req.user);
    
    if (!newAttachment) {
      return res.status(400).json({ message: "File tidak ditemukan atau input kosong." });
    }

    // 2. Update Database
    await taskRef.update({
      attachments: FieldValue.arrayUnion(newAttachment),
      updatedAt: Timestamp.now(),
    });

    // 3. LOG AKTIVITAS
    await logCompanyActivity(idCompany, {
      actorEmail: email,
      actorName: nama || "User",
      target: taskId,
      action: "ADD_ATTACHMENT",
      description: `Menambahkan attachment pada tugas.`,
    });

    return res.status(200).json({
      message: "Attachment berhasil ditambahkan.",
      data: {
        ...newAttachment,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Error Add Attachment:", error);
    return res
      .status(500)
      .json({ message: "Server Error", error: error.message });
  }
});

// ---------------------------------------------------------
// POST /update-status - Update Status & Optional Attachment
// ---------------------------------------------------------
// Body: { taskId, status: "Proses"|"Tunda"|"Selesai", text?, fileId? }
router.post("/update-status", verifyToken, async (req, res) => {
  try {
    const { taskId, status, text, fileId } = req.body;
    const { idCompany, email, role, nama } = req.user;

    // Mapping Status Text ke Code
    const statusMap = {
      "Proses": 1,
      "Tunda": 2,
      "Selesai": 3
    };

    if (!taskId || !status || !statusMap[status]) {
      return res.status(400).json({ 
        message: "Task ID dan Status (Proses, Tunda, Selesai) valid wajib diisi." 
      });
    }

    const taskRef = db
      .collection("companies")
      .doc(idCompany)
      .collection("tasks")
      .doc(taskId);

    const taskDoc = await taskRef.get();
    if (!taskDoc.exists) {
      return res.status(404).json({ message: "Tugas tidak ditemukan." });
    }

    const taskData = taskDoc.data();
    const currentStatus = taskData.status;

    // -----------------------------------------------------
    // VALIDASI LOGIKA STATUS
    // -----------------------------------------------------
    // 1. Proses -> Tunda (Submit Review): Staff & Admin Boleh
    if (currentStatus === "Proses" && status === "Tunda") {
        // Allowed for everyone involved
    }
    // 2. Tunda -> Proses (Revisi): Admin Only
    else if (currentStatus === "Tunda" && status === "Proses") {
        if (role !== "admin") {
            return res.status(403).json({ message: "Hanya Admin yang dapat mengembalikan status ke Proses (Revisi)." });
        }
    }
    // 3. Tunda -> Selesai (Approve): Admin Only
    else if (currentStatus === "Tunda" && status === "Selesai") {
        if (role !== "admin") {
            return res.status(403).json({ message: "Hanya Admin yang dapat menyelesaikan tugas." });
        }
    }
    // 4. Status Sama (Cuma update attachment mungkin?) - Boleh
    else if (currentStatus === status) {
       // Pass
    }
    // 5. Flow lain yang tidak diizinkan (Misal: Selesai -> Tunda, atau Staff langsung ke Selesai)
    else {
        // Jika Staff mencoba langsung Proses -> Selesai (Skip Tunda)
        if (role !== "admin" && status === "Selesai") {
             return res.status(403).json({ message: "Staff harus mengubah status ke Tunda (Review) terlebih dahulu." });
        }
        // Admin bebas mengubah flow jika perlu (Opsional, tapi logic di atas sudah cover standard flow)
    }

    // -----------------------------------------------------
    // PROSES UPDATE
    // -----------------------------------------------------
    const updateData = {
        status: status,
        statusCode: statusMap[status],
        updatedAt: Timestamp.now()
    };

    // Jika ada Attachment (Text / File) saat ganti status
    let newAttachment = null;
    if (text || fileId) {
        newAttachment = await prepareAttachment(idCompany, text, fileId, req.user);
        if (newAttachment) {
            updateData.attachments = FieldValue.arrayUnion(newAttachment);
        }
    }

    await taskRef.update(updateData);

    // LOG AKTIVITAS
    await logCompanyActivity(idCompany, {
        actorEmail: email,
        actorName: nama || "User",
        target: taskId,
        action: "UPDATE_STATUS_TASK",
        description: `Mengubah status dari ${currentStatus} ke ${status}.`,
    });

    return res.status(200).json({
        message: `Status berhasil diubah ke ${status}.`,
        data: {
            taskId,
            status,
            statusCode: statusMap[status],
            addedAttachment: newAttachment
        }
    });

  } catch (error) {
    console.error("Error Update Status:", error);
    return res.status(500).json({ message: "Server Error", error: error.message });
  }
});

module.exports = router;