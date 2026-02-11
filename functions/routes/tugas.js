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
// GET /list - Get All Tasks (Modified for Multi-Assign)
// ---------------------------------------------------------
router.get("/list", verifyToken, async (req, res) => {
  try {
    const { idCompany, role, email } = req.user;

    let query = db
      .collection("companies")
      .doc(idCompany)
      .collection("tasks")
      .orderBy("updatedAt", "desc");

    const snapshot = await query.get();

    if (snapshot.empty) {
      return res.status(200).json({ message: "Tidak ada tugas.", data: [] });
    }

    const now = new Date();

    const tasks = snapshot.docs.map((doc) => {
      const data = doc.data();

      // LOGIKA OVERDUE (Sama seperti sebelumnya)
      let isOverdue = false;
      let daysOverdue = 0;
      let compareTime = now;

      if (data.deadline) {
        const deadlineDate = data.deadline.toDate();

        if (data.status === "Selesai") {
          compareTime = data.finishedAt
            ? data.finishedAt.toDate()
            : data.updatedAt
            ? data.updatedAt.toDate()
            : now;
        }

        if (compareTime > deadlineDate) {
          isOverdue = true;
          const diffTime = Math.abs(compareTime - deadlineDate);
          daysOverdue = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        }
      }

      return {
        id: doc.id,
        ...data,
        isOverdue: isOverdue,
        overdueInfo: isOverdue ? `Terlambat ${daysOverdue} hari` : null,
        createdAt: data.createdAt?.toDate().toISOString(),
        updatedAt: data.updatedAt?.toDate().toISOString(),
        finishedAt: data.finishedAt?.toDate().toISOString() || null,
        deadline: data.deadline?.toDate().toISOString() || null,
      };
    });

    return res.status(200).json({
      message: "Data tugas berhasil diambil.",
      data: tasks,
    });
  } catch (error) {
    console.error("Error Get List Task:", error);
    return res
      .status(500)
      .json({ message: "Server Error", error: error.message });
  }
});

// ---------------------------------------------------------
// POST /create - Create New Task (Modified for Multi-Assign)
// ---------------------------------------------------------
router.post("/create", verifyToken, async (req, res) => {
  try {
    if (!req.user || req.user.role !== "admin") {
      return res.status(403).json({
        message: "Akses ditolak. Hanya Admin yang dapat membuat tugas.",
      });
    }

    // PERUBAHAN 2: assignedTo diharapkan berupa Array of Emails ["a@mail.com", "b@mail.com"]
    // Jika frontend mengirim string single, kita ubah jadi array.
    let { assignedTo, description, deadline } = req.body;
    const { idCompany, email: adminEmail, nama: adminName } = req.user;

    if (!assignedTo || !description) {
      return res.status(400).json({
        message: "AssignedTo (List Email User) dan Description wajib diisi.",
      });
    }

    // Handle jika user mengirim string (single user) untuk backward compatibility
    if (!Array.isArray(assignedTo)) {
      assignedTo = [assignedTo];
    }

    // 1. Validasi Deadline
    let deadlineTimestamp = null;
    if (deadline) {
      const dateCheck = new Date(deadline);
      if (isNaN(dateCheck.getTime())) {
        return res
          .status(400)
          .json({ message: "Format deadline tidak valid. Gunakan ISO 8601." });
      }
      deadlineTimestamp = Timestamp.fromDate(dateCheck);
    }

    // 2. Validasi & Fetch Multiple Users
    const targetEmails = [];
    const targetNames = [];
    const targetPhotos = [];

    // Kita loop semua email yang dikirim
    for (const targetEmail of assignedTo) {
      const targetUserRef = db.collection("users").doc(targetEmail);
      const targetUserDoc = await targetUserRef.get();

      if (targetUserDoc.exists) {
        const userData = targetUserDoc.data();
        // Pastikan user ada di perusahaan yang sama
        if (userData.idCompany === idCompany) {
          targetEmails.push(targetEmail); // Masukkan ke Array Email
          targetNames.push(userData.username || userData.nama || targetEmail); // Masukkan ke Array Nama
          targetPhotos.push(userData.photoURL || null); // Masukkan ke Array Foto
        }
      }
    }

    if (targetEmails.length === 0) {
      return res.status(404).json({
        message: "Tidak ada user valid yang ditemukan dalam list assignedTo.",
      });
    }

    // 3. Buat Object Tugas dengan Array
    const newTask = {
      companyId: idCompany,
      assignedTo: targetEmails, // Array of Strings
      assignedToName: targetNames, // Array of Strings
      assignedToPhoto: targetPhotos, // Array of Strings/Null
      createdBy: adminEmail,
      description: description,
      status: "Proses",
      statusCode: 1,
      attachments: [],

      deadline: deadlineTimestamp,
      finishedAt: null,

      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    };

    const docRef = await db
      .collection("companies")
      .doc(idCompany)
      .collection("tasks")
      .add(newTask);

    // 4. LOG AKTIVITAS (Join nama user jika banyak)
    const targetNamesString = targetNames.join(", ");

    await logCompanyActivity(idCompany, {
      actorEmail: adminEmail,
      actorName: adminName || "Admin",
      target: docRef.id, // Target log sebaiknya ID Task atau representasi string
      action: "CREATE_TASK",
      description: `Membuat tugas untuk: ${targetNamesString}`,
    });

    return res.status(201).json({
      message: `Tugas berhasil dibuat untuk ${targetEmails.length} orang.`,
      taskId: docRef.id,
      data: {
        id: docRef.id,
        ...newTask,
        createdAt: new Date().toISOString(),
        deadline: deadline ? deadlineTimestamp.toDate().toISOString() : null,
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
// POST /add-attachment (Tidak ada perubahan logika inti)
// ---------------------------------------------------------
router.post("/add-attachment", verifyToken, async (req, res) => {
  try {
    const { taskId, text, fileId } = req.body;
    const { idCompany, email, nama } = req.user;

    if (!taskId)
      return res.status(400).json({ message: "Task ID wajib diisi." });
    if (!text && !fileId)
      return res.status(400).json({ message: "Isi text atau fileId." });

    const taskRef = db
      .collection("companies")
      .doc(idCompany)
      .collection("tasks")
      .doc(taskId);

    const taskDoc = await taskRef.get();
    if (!taskDoc.exists) {
      return res.status(404).json({ message: "Tugas tidak ditemukan." });
    }

    const newAttachment = await prepareAttachment(
      idCompany,
      text,
      fileId,
      req.user
    );

    if (!newAttachment) {
      return res
        .status(400)
        .json({ message: "File tidak ditemukan atau input kosong." });
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
// POST /update-status (Perlu update validasi akses)
// ---------------------------------------------------------
router.post("/update-status", verifyToken, async (req, res) => {
  try {
    const { taskId, status, text, fileId } = req.body;
    const { idCompany, email, role, nama } = req.user;

    const statusMap = {
      Proses: 1,
      Tunda: 2,
      Selesai: 3,
    };

    if (!taskId || !status || !statusMap[status]) {
      return res.status(400).json({
        message:
          "Task ID dan Status (Proses, Tunda, Selesai) valid wajib diisi.",
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

    // VALIDASI AKSES: Cek apakah user yang request ada di list assignedTo
    // Jika user BUKAN admin, dan emailnya TIDAK ADA di array assignedTo, tolak.
    if (role !== "admin") {
      // Handle kompatibilitas data lama (string) vs data baru (array)
      const assignedToArray = Array.isArray(taskData.assignedTo)
        ? taskData.assignedTo
        : [taskData.assignedTo];

      if (!assignedToArray.includes(email)) {
        return res
          .status(403)
          .json({ message: "Anda tidak ditugaskan untuk tugas ini." });
      }
    }

    // VALIDASI LOGIKA STATUS
    if (currentStatus === "Proses" && status === "Tunda") {
      // OK
    } else if (currentStatus === "Tunda" && status === "Proses") {
      if (role !== "admin") {
        return res
          .status(403)
          .json({
            message:
              "Hanya Admin yang dapat mengembalikan status ke Proses (Revisi).",
          });
      }
    } else if (currentStatus === "Tunda" && status === "Selesai") {
      if (role !== "admin") {
        return res
          .status(403)
          .json({ message: "Hanya Admin yang dapat menyelesaikan tugas." });
      }
    } else if (currentStatus === status) {
      // OK
    } else {
      if (role !== "admin" && status === "Selesai") {
        return res
          .status(403)
          .json({
            message:
              "Staff harus mengubah status ke Tunda (Review) terlebih dahulu.",
          });
      }
    }

    const updateData = {
      status: status,
      statusCode: statusMap[status],
      updatedAt: Timestamp.now(),
      finishedAt: status === "Selesai" ? Timestamp.now() : null,
    };

    let newAttachment = null;
    if (text || fileId) {
      newAttachment = await prepareAttachment(
        idCompany,
        text,
        fileId,
        req.user
      );
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
        finishedAt: updateData.finishedAt
          ? updateData.finishedAt.toDate().toISOString()
          : null,
        addedAttachment: newAttachment,
      },
    });
  } catch (error) {
    console.error("Error Update Status:", error);
    return res
      .status(500)
      .json({ message: "Server Error", error: error.message });
  }
});

module.exports = router;
