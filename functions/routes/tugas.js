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
const prepareAttachment = async (idCompany, text, fileId, user) => {
  let fileData = null;

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

  if (!text && !fileData) return null;

  const attachmentId = db.collection("_").doc().id;
  
  return {
    id: attachmentId,
    type: fileData ? "file" : "text",
    text: text || "",
    ...(fileData && { file: fileData }), 
    senderEmail: user.email,
    senderName: user.username || user.nama || "User",
    senderRole: user.role,
    createdAt: Timestamp.now(),
  };
};

// ---------------------------------------------------------
// GET /list - Get All Tasks (Calculates Overdue Status)
// ---------------------------------------------------------
router.get("/list", verifyToken, async (req, res) => {
  try {
    const { idCompany, role, email } = req.user;

    let query = db
      .collection("companies")
      .doc(idCompany)
      .collection("tasks")
      .orderBy("updatedAt", "desc"); 

    if (role !== "admin") {
      query = query.where("assignedTo", "==", email);
    }

    const snapshot = await query.get();

    if (snapshot.empty) {
      return res.status(200).json({ message: "Tidak ada tugas.", data: [] });
    }

    const now = new Date();

    const tasks = snapshot.docs.map((doc) => {
      const data = doc.data();
      
      // LOGIKA OVERDUE (REVISI)
      let isOverdue = false;
      let daysOverdue = 0;
      let compareTime = now; // Default pembanding adalah waktu sekarang (untuk status Proses/Tunda)

      // Hanya proses jika ada deadline
      if (data.deadline) {
        const deadlineDate = data.deadline.toDate();

        // Jika status sudah Selesai, kita bandingkan Deadline dengan Waktu Penyelesaian (finishedAt)
        // Jika finishedAt tidak ada (data lama), kita pakai updatedAt sebagai fallback
        if (data.status === 'Selesai') {
            compareTime = data.finishedAt ? data.finishedAt.toDate() : (data.updatedAt ? data.updatedAt.toDate() : now);
        }

        // Cek Kondisi Terlambat
        if (compareTime > deadlineDate) {
           isOverdue = true;
           const diffTime = Math.abs(compareTime - deadlineDate);
           daysOverdue = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
        }
      }

      return {
        id: doc.id,
        ...data,
        isOverdue: isOverdue, // Boolean: true jika telat (baik masih proses maupun sudah selesai)
        overdueInfo: isOverdue ? `Terlambat ${daysOverdue} hari` : null, 
        
        // Konversi Timestamp ke String ISO
        createdAt: data.createdAt?.toDate().toISOString(),
        updatedAt: data.updatedAt?.toDate().toISOString(),
        finishedAt: data.finishedAt?.toDate().toISOString() || null, // Info kapan selesai
        deadline: data.deadline?.toDate().toISOString() || null 
      };
    });

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
// POST /create - Create New Task (With Optional Deadline)
// ---------------------------------------------------------
router.post("/create", verifyToken, async (req, res) => {
  try {
    if (!req.user || req.user.role !== "admin") {
      return res.status(403).json({
        message: "Akses ditolak. Hanya Admin yang dapat membuat tugas.",
      });
    }

    const { assignedTo, description, deadline } = req.body; 
    const { idCompany, email: adminEmail, nama: adminName } = req.user;

    if (!assignedTo || !description) {
      return res.status(400).json({
        message: "AssignedTo (Email User) dan Description wajib diisi.",
      });
    }

    // 1. Validasi Deadline (Opsional)
    let deadlineTimestamp = null;
    if (deadline) {
       const dateCheck = new Date(deadline);
       if (isNaN(dateCheck.getTime())) {
          return res.status(400).json({ message: "Format deadline tidak valid. Gunakan ISO 8601." });
       }
       deadlineTimestamp = Timestamp.fromDate(dateCheck);
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
      
      deadline: deadlineTimestamp,
      finishedAt: null, // Default null saat baru dibuat
      
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
        deadline: deadline ? deadlineTimestamp.toDate().toISOString() : null
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
// POST /add-attachment
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

    const newAttachment = await prepareAttachment(idCompany, text, fileId, req.user);
    
    if (!newAttachment) {
      return res.status(400).json({ message: "File tidak ditemukan atau input kosong." });
    }

    await taskRef.update({
      attachments: FieldValue.arrayUnion(newAttachment),
      updatedAt: Timestamp.now(),
    });

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
// POST /update-status
// ---------------------------------------------------------
router.post("/update-status", verifyToken, async (req, res) => {
  try {
    const { taskId, status, text, fileId } = req.body;
    const { idCompany, email, role, nama } = req.user;

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

    // VALIDASI LOGIKA STATUS
    if (currentStatus === "Proses" && status === "Tunda") {
        // OK
    }
    else if (currentStatus === "Tunda" && status === "Proses") {
        if (role !== "admin") {
            return res.status(403).json({ message: "Hanya Admin yang dapat mengembalikan status ke Proses (Revisi)." });
        }
    }
    else if (currentStatus === "Tunda" && status === "Selesai") {
        if (role !== "admin") {
            return res.status(403).json({ message: "Hanya Admin yang dapat menyelesaikan tugas." });
        }
    }
    else if (currentStatus === status) {
       // OK
    }
    else {
        if (role !== "admin" && status === "Selesai") {
             return res.status(403).json({ message: "Staff harus mengubah status ke Tunda (Review) terlebih dahulu." });
        }
    }

    const updateData = {
        status: status,
        statusCode: statusMap[status],
        updatedAt: Timestamp.now(),
        // Jika status jadi 'Selesai', catat waktunya (finishedAt).
        // Jika status dikembalikan ke 'Proses'/'Tunda', reset finishedAt jadi null.
        finishedAt: status === "Selesai" ? Timestamp.now() : null
    };

    let newAttachment = null;
    if (text || fileId) {
        newAttachment = await prepareAttachment(idCompany, text, fileId, req.user);
        if (newAttachment) {
            updateData.attachments = FieldValue.arrayUnion(newAttachment);
        }
    }

    await taskRef.update(updateData);

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
            // Return finishedAt agar FE bisa update UI
            finishedAt: updateData.finishedAt ? updateData.finishedAt.toDate().toISOString() : null,
            addedAttachment: newAttachment
        }
    });

  } catch (error) {
    console.error("Error Update Status:", error);
    return res.status(500).json({ message: "Server Error", error: error.message });
  }
});

module.exports = router;