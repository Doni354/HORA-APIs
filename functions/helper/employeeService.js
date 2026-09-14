/* eslint-disable */
const { db } = require("../config/firebase");
const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const { logCompanyActivity } = require("./logCompanyActivity");
const EmailTemplates = require("./emailHelper");

/**
 * Capitalize first letter helper
 */
const capitalize = (str) => {
  if (!str || typeof str !== "string") return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
};

/**
 * Normalizes combined employee + user profile data
 */
const normalizeEmployee = (empData = {}, userData = {}, email) => {
  const role = empData.role || userData.role || "staff";
  const defaultJabatan = capitalize(role);
  const jabatan = empData.jabatan || defaultJabatan;
  const status = empData.status || userData.status || "active";

  const joinDate = empData.joinDate
    ? (empData.joinDate.toDate ? empData.joinDate.toDate() : new Date(empData.joinDate))
    : (userData.createdAt
        ? (userData.createdAt.toDate ? userData.createdAt.toDate() : new Date(userData.createdAt))
        : null);

  const createdAt = empData.createdAt
    ? (empData.createdAt.toDate ? empData.createdAt.toDate() : new Date(empData.createdAt))
    : (userData.createdAt
        ? (userData.createdAt.toDate ? userData.createdAt.toDate() : new Date(userData.createdAt))
        : null);

  const updatedAt = empData.updatedAt
    ? (empData.updatedAt.toDate ? empData.updatedAt.toDate() : new Date(empData.updatedAt))
    : null;

  const deactivatedAt = empData.deactivatedAt
    ? (empData.deactivatedAt.toDate ? empData.deactivatedAt.toDate() : new Date(empData.deactivatedAt))
    : null;

  return {
    userEmail: email,
    username: userData.username || userData.nama || "Tanpa Nama",
    photoURL: userData.photoURL || userData.photoUrl || null,
    noTelp: userData.noTelp || "-",
    noWA: userData.noWA || "-",
    gender: userData.gender || null,
    alamatLoc: userData.alamatLoc || null,
    authProvider: userData.authProvider || null,
    role: role,
    jabatan: jabatan,
    status: status,
    joinDate: joinDate ? joinDate.toISOString() : null,
    leaveBalance: empData.leaveBalance !== undefined ? Number(empData.leaveBalance) : 12,
    shiftQuota: empData.shiftQuota !== undefined ? Number(empData.shiftQuota) : 0,
    gaji: empData.gaji !== undefined ? Number(empData.gaji) : (userData.gaji !== undefined ? Number(userData.gaji) : 0),
    config: empData.config || {},
    cvUrl: empData.cvUrl || userData.cvUrl || null,
    applicantDesc: empData.applicantDesc || userData.applicantDesc || null,
    appliedAt: empData.appliedAt ? (empData.appliedAt.toDate ? empData.appliedAt.toDate().toISOString() : new Date(empData.appliedAt).toISOString()) : null,
    deactivatedAt: deactivatedAt ? deactivatedAt.toISOString() : null,
    deactivatedBy: empData.deactivatedBy || null,
    deactivationReason: empData.deactivationReason || null,
    createdAt: createdAt ? createdAt.toISOString() : null,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
  };
};

/**
 * Batch fetch user documents in chunks to avoid N+1 reads
 */
const batchFetchUsers = async (emails) => {
  if (!emails || emails.length === 0) return new Map();

  const userMap = new Map();
  const BATCH_SIZE = 300;

  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const chunk = emails.slice(i, i + BATCH_SIZE);
    const refs = chunk.map((email) => db.collection("users").doc(email));
    try {
      const snapshots = await db.getAll(...refs);
      snapshots.forEach((snap) => {
        if (snap.exists) {
          userMap.set(snap.id, snap.data());
        }
      });
    } catch (err) {
      console.warn("[employeeService] db.getAll fallback to individual gets:", err.message);
      await Promise.all(
        chunk.map(async (email) => {
          try {
            const snap = await db.collection("users").doc(email).get();
            if (snap.exists) userMap.set(snap.id, snap.data());
          } catch (e) {
            // non-fatal
          }
        })
      );
    }
  }

  return userMap;
};

/**
 * 1. GET LIST EMPLOYEES
 */
const getCompanyEmployees = async ({
  companyId,
  status,
  role,
  search,
  page = 1,
  limit = 50,
  requester,
}) => {
  if (!companyId) throw new Error("ID Company wajib diisi.");

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

  const empCollectionRef = db.collection("companies").doc(companyId).collection("employees");
  const empSnap = await empCollectionRef.get();

  let employeeDocs = [];

  if (!empSnap.empty) {
    // Mode 1: Data ada di subcollection companies/{companyId}/employees
    empSnap.forEach((doc) => {
      employeeDocs.push({
        id: doc.id,
        data: doc.data(),
      });
    });
  } else {
    // Mode 2 (Fallback / Pre-migration): Baca dari users where idCompany == companyId
    const usersSnap = await db.collection("users")
      .where("idCompany", "==", companyId)
      .get();

    usersSnap.forEach((doc) => {
      const uData = doc.data();
      employeeDocs.push({
        id: doc.id,
        data: {
          userEmail: doc.id,
          role: uData.role || "staff",
          jabatan: capitalize(uData.role || "staff"),
          status: uData.status === "fired" ? "terminated" : (uData.status || "active"),
          joinDate: uData.createdAt || null,
          leaveBalance: 12,
          shiftQuota: 0,
          config: {},
          createdAt: uData.createdAt || null,
          updatedAt: null,
        },
      });
    });
  }

  // Ambil data profil user via batch
  const emails = employeeDocs.map((e) => e.id);
  const userMap = await batchFetchUsers(emails);

  // Normalisasi seluruh employee
  let list = employeeDocs.map((e) => {
    const uData = userMap.get(e.id) || {};
    return normalizeEmployee(e.data, uData, e.id);
  });

  // Filter Status jika diberikan
  if (status) {
    const targetStatus = status.toLowerCase();
    list = list.filter((item) => (item.status || "").toLowerCase() === targetStatus);
  }

  // Filter Role jika diberikan
  if (role) {
    const targetRole = role.toLowerCase();
    list = list.filter((item) => (item.role || "").toLowerCase() === targetRole);
  }

  // Filter Search jika diberikan (username, email, jabatan)
  if (search && search.trim() !== "") {
    const q = search.trim().toLowerCase();
    list = list.filter(
      (item) =>
        (item.username && item.username.toLowerCase().includes(q)) ||
        (item.userEmail && item.userEmail.toLowerCase().includes(q)) ||
        (item.jabatan && item.jabatan.toLowerCase().includes(q))
    );
  }

  // Total setelah filter
  const total = list.length;
  const totalPages = Math.ceil(total / limitNum) || 1;

  // Pagination slice
  const startIndex = (pageNum - 1) * limitNum;
  const paginatedData = list.slice(startIndex, startIndex + limitNum);

  return {
    employees: paginatedData,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages,
    },
  };
};

/**
 * 2. GET EMPLOYEE DETAIL WITH ACTIVITY SUMMARY
 */
const getEmployeeDetail = async ({ companyId, email }) => {
  if (!companyId || !email) throw new Error("companyId dan email wajib diisi.");

  const empDocRef = db.collection("companies").doc(companyId).collection("employees").doc(email);
  const userDocRef = db.collection("users").doc(email);

  const [empSnap, userSnap] = await Promise.all([
    empDocRef.get(),
    userDocRef.get(),
  ]);

  // Jika tidak ada di subcollection, cek fallback ke user doc
  let empData = null;
  let userData = userSnap.exists ? userSnap.data() : {};

  if (empSnap.exists) {
    empData = empSnap.data();
  } else if (userSnap.exists && userData.idCompany === companyId) {
    empData = {
      userEmail: email,
      role: userData.role || "staff",
      jabatan: capitalize(userData.role || "staff"),
      status: userData.status === "fired" ? "terminated" : (userData.status || "active"),
      joinDate: userData.createdAt || null,
      leaveBalance: 12,
      shiftQuota: 0,
      config: {},
      createdAt: userData.createdAt || null,
    };
  } else {
    return null; // 404
  }

  const normalized = normalizeEmployee(empData, userData, email);

  // Ambil activity summary secara paralel dan aman (Promise.allSettled)
  const targetUid = userData.uid || email;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    absensiResult,
    leavesResult,
    reimbursementsResult,
    tasksResult,
  ] = await Promise.allSettled([
    // A. 5 Absensi terakhir
    db.collection("companies").doc(companyId).collection("absensi")
      .where("idKaryawan", "in", [email, targetUid])
      .orderBy("tanggal", "desc")
      .limit(5)
      .get()
      .catch(() => ({ empty: true, docs: [] })),

    // B. 3 Cuti/Izin terakhir
    db.collection("companies").doc(companyId).collection("leaves")
      .where("userId", "==", email)
      .orderBy("createdAt", "desc")
      .limit(3)
      .get()
      .catch(() => ({ empty: true, docs: [] })),

    // C. 3 Reimburse terakhir
    db.collection("companies").doc(companyId).collection("reimbursements")
      .where("userId", "==", email)
      .orderBy("createdAt", "desc")
      .limit(3)
      .get()
      .catch(() => ({ empty: true, docs: [] })),

    // D. 5 Tugas aktif/belum selesai
    db.collection("companies").doc(companyId).collection("tasks")
      .orderBy("updatedAt", "desc")
      .limit(20)
      .get()
      .catch(() => ({ empty: true, docs: [] })),
  ]);

  // Format Absensi
  const recentAttendance = [];
  let attendanceThisMonthCount = 0;
  if (absensiResult.status === "fulfilled" && absensiResult.value?.docs) {
    absensiResult.value.docs.forEach((d) => {
      const item = d.data();
      const tgl = item.tanggal?.toDate ? item.tanggal.toDate() : new Date(item.tanggal);
      if (tgl >= startOfMonth) attendanceThisMonthCount++;
      recentAttendance.push({
        id: d.id,
        tanggal: tgl ? tgl.toISOString() : null,
        waktuCheckIn: item.waktuCheckIn || null,
        waktuCheckOut: item.waktuCheckOut || null,
        shift: item.shift || "-",
        durasi: item.durasi || null,
        telat: item.telat || false,
      });
    });
  }

  // Format Leaves
  const recentLeaves = [];
  if (leavesResult.status === "fulfilled" && leavesResult.value?.docs) {
    leavesResult.value.docs.forEach((d) => {
      const item = d.data();
      recentLeaves.push({
        id: d.id,
        tipeIzin: item.tipeIzin || "Izin",
        status: item.status || "pending",
        startDate: item.startDate?.toDate ? item.startDate.toDate().toISOString() : item.startDate,
        endDate: item.endDate?.toDate ? item.endDate.toDate().toISOString() : item.endDate,
        keterangan: item.keterangan || "",
      });
    });
  }

  // Format Reimbursements
  const recentReimbursements = [];
  if (reimbursementsResult.status === "fulfilled" && reimbursementsResult.value?.docs) {
    reimbursementsResult.value.docs.forEach((d) => {
      const item = d.data();
      recentReimbursements.push({
        id: d.id,
        title: item.title || item.keterangan || "Klaim",
        nominal: item.nominal || 0,
        status: item.status || "pending",
        date: item.date?.toDate ? item.date.toDate().toISOString() : item.date,
      });
    });
  }

  // Format Tasks (filter assignedTo user)
  const activeTasks = [];
  if (tasksResult.status === "fulfilled" && tasksResult.value?.docs) {
    tasksResult.value.docs.forEach((d) => {
      const item = d.data();
      const isAssigned =
        (Array.isArray(item.assignedTo) &&
          item.assignedTo.some((u) => u === email || u?.email === email || u === targetUid)) ||
        item.createdBy === email;

      if (isAssigned && item.status !== "Selesai") {
        activeTasks.push({
          id: d.id,
          judul: item.judul || item.title || "Tugas",
          status: item.status || "Berjalan",
          deadline: item.deadline?.toDate ? item.deadline.toDate().toISOString() : null,
        });
      }
    });
  }

  return {
    ...normalized,
    activitySummary: {
      attendance: {
        totalThisMonth: attendanceThisMonthCount,
        recent: recentAttendance.slice(0, 5),
      },
      leaves: {
        remainingBalance: normalized.leaveBalance,
        recent: recentLeaves,
      },
      reimbursements: {
        recent: recentReimbursements,
      },
      tasks: {
        activeCount: activeTasks.length,
        recent: activeTasks.slice(0, 5),
      },
    },
  };
};

/**
 * 3. UPDATE EMPLOYEE (HR-Editable Fields)
 */
const updateEmployee = async ({ companyId, email, updateData, actor }) => {
  if (!companyId || !email) throw new Error("companyId dan email wajib diisi.");

  // 1. Cek Permission Actor (harus Admin / Owner dari company yang sama)
  if (actor.idCompany !== companyId || actor.role !== "admin") {
    const err = new Error("Hanya Admin perusahaan yang boleh memperbarui data karyawan.");
    err.status = 403;
    throw err;
  }

  // 2. Ambil data company untuk proteksi Owner
  const companyDoc = await db.collection("companies").doc(companyId).get();
  if (!companyDoc.exists) {
    const err = new Error("Perusahaan tidak ditemukan.");
    err.status = 404;
    throw err;
  }
  const companyData = companyDoc.data();

  // 3. Target Employee Reference
  const empRef = db.collection("companies").doc(companyId).collection("employees").doc(email);
  const userRef = db.collection("users").doc(email);

  const [empSnap, userSnap] = await Promise.all([empRef.get(), userRef.get()]);
  if (!empSnap.exists && !userSnap.exists) {
    const err = new Error("Karyawan tidak ditemukan.");
    err.status = 404;
    throw err;
  }

  const currentEmpData = empSnap.exists ? empSnap.data() : {};
  const currentRole = currentEmpData.role || (userSnap.exists ? userSnap.data().role : "staff");

  // 4. Proteksi Owner
  const isOwner =
    email === companyData.createdBy ||
    (userSnap.exists && userSnap.data().uid === companyData.ownerUid);

  // 5. Whitelist & Sanitasi Field
  const fieldsToUpdate = {};
  let roleChanged = false;

  // Role: hanya boleh "admin" atau "staff"
  if (updateData.role !== undefined) {
    const targetRole = String(updateData.role).toLowerCase();
    if (!["admin", "staff"].includes(targetRole)) {
      const err = new Error("Role tidak valid. Pilihan: 'admin' atau 'staff'.");
      err.status = 400;
      throw err;
    }
    if (isOwner && targetRole !== "admin") {
      const err = new Error("DILARANG: Anda tidak dapat menurunkan jabatan Pemilik Perusahaan (Owner).");
      err.status = 403;
      throw err;
    }
    if (targetRole !== currentRole) {
      fieldsToUpdate.role = targetRole;
      roleChanged = true;
    }
  }

  // Jabatan: string bebas (1 - 100 karakter)
  if (updateData.jabatan !== undefined) {
    const j = String(updateData.jabatan).trim();
    if (j.length > 100) {
      const err = new Error("Nama jabatan maksimal 100 karakter.");
      err.status = 400;
      throw err;
    }
    fieldsToUpdate.jabatan = j || capitalize(fieldsToUpdate.role || currentRole);
  }

  // LeaveBalance: number >= 0
  if (updateData.leaveBalance !== undefined) {
    const lb = Number(updateData.leaveBalance);
    if (isNaN(lb) || lb < 0) {
      const err = new Error("leaveBalance harus berupa angka bernilai 0 atau lebih.");
      err.status = 400;
      throw err;
    }
    fieldsToUpdate.leaveBalance = lb;
  }

  // ShiftQuota: number >= 0
  if (updateData.shiftQuota !== undefined) {
    const sq = Number(updateData.shiftQuota);
    if (isNaN(sq) || sq < 0) {
      const err = new Error("shiftQuota harus berupa angka bernilai 0 atau lebih.");
      err.status = 400;
      throw err;
    }
    fieldsToUpdate.shiftQuota = sq;
  }

  // Gaji: number >= 0
  if (updateData.gaji !== undefined) {
    const g = Number(updateData.gaji);
    if (isNaN(g) || g < 0) {
      const err = new Error("gaji harus berupa angka bernilai 0 atau lebih.");
      err.status = 400;
      throw err;
    }
    fieldsToUpdate.gaji = g;
  }

  // Config: object
  if (updateData.config !== undefined) {
    if (typeof updateData.config !== "object" || updateData.config === null || Array.isArray(updateData.config)) {
      const err = new Error("config harus berupa object konfigurasi.");
      err.status = 400;
      throw err;
    }
    fieldsToUpdate.config = updateData.config;
  }

  if (Object.keys(fieldsToUpdate).length === 0) {
    const err = new Error("Tidak ada field valid yang dikirim untuk diperbarui.");
    err.status = 400;
    throw err;
  }

  fieldsToUpdate.updatedAt = Timestamp.now();

  // Simpan ke subcollection companies/{companyId}/employees/{email}
  await empRef.set(fieldsToUpdate, { merge: true });

  // Dual-write ke users/{email} jika role diubah (agar token auth tetap valid)
  if (roleChanged && userSnap.exists) {
    await userRef.update({ role: fieldsToUpdate.role });
  }

  // Catat Log Perusahaan
  await logCompanyActivity(companyId, {
    actorEmail: actor.email,
    actorName: actor.nama || "Admin",
    target: email,
    action: "UPDATE_EMPLOYEE_HR",
    description: `Admin ${actor.nama || "Admin"} memperbarui profil HR karyawan ${email}.`,
  });

  return {
    userEmail: email,
    updatedFields: fieldsToUpdate,
  };
};

/**
 * 4. DEACTIVATE EMPLOYEE (Non-Destructive)
 */
const deactivateEmployee = async ({ companyId, email, status, reason, actor }) => {
  if (!companyId || !email) throw new Error("companyId dan email wajib diisi.");

  // 1. Validasi Status Transisi
  const targetStatus = (status || "").toLowerCase().trim();
  if (!["resigned", "terminated"].includes(targetStatus)) {
    const err = new Error("Status deactivasi tidak valid. Pilihan: 'resigned' atau 'terminated'.");
    err.status = 400;
    throw err;
  }

  // 2. Validasi Hak Akses Actor
  if (actor.idCompany !== companyId || actor.role !== "admin") {
    const err = new Error("Hanya Admin perusahaan yang boleh menonaktifkan karyawan.");
    err.status = 403;
    throw err;
  }

  // 3. Ambil data Perusahaan
  const companyDoc = await db.collection("companies").doc(companyId).get();
  if (!companyDoc.exists) {
    const err = new Error("Perusahaan tidak ditemukan.");
    err.status = 404;
    throw err;
  }
  const companyData = companyDoc.data();

  // 4. Ambil target user untuk validasi owner & existence
  const userRef = db.collection("users").doc(email);
  const userDoc = await userRef.get();
  if (!userDoc.exists) {
    const err = new Error("Karyawan tidak ditemukan di sistem.");
    err.status = 404;
    throw err;
  }
  const userData = userDoc.data();

  // Proteksi Owner
  if (email === companyData.createdBy || userData.uid === companyData.ownerUid) {
    const err = new Error("TINDAKAN ILEGAL: Anda tidak dapat menonaktifkan Pemilik Perusahaan (Owner).");
    err.status = 403;
    throw err;
  }

  const finalReason = reason && reason.trim() !== "" ? reason.trim() : (targetStatus === "resigned" ? "Pengunduran diri" : "Pemutusan hubungan kerja");

  // 5. Update di subcollection employees (TETAP ADA, TIDAK DIHAPUS)
  const empRef = db.collection("companies").doc(companyId).collection("employees").doc(email);
  const empUpdateData = {
    userEmail: email,
    status: targetStatus,
    deactivatedAt: Timestamp.now(),
    deactivatedBy: actor.email,
    deactivationReason: finalReason,
    updatedAt: Timestamp.now(),
  };
  await empRef.set(empUpdateData, { merge: true });

  // 6. Dual-write ke user doc (melepas idCompany agar kuota kembali bertambah dan user tidak bisa akses company)
  await userRef.update({
    role: "rejected",
    status: targetStatus === "resigned" ? "resigned" : "fired",
    firedAt: Timestamp.now(),
    firedBy: actor.email,
    firedReason: finalReason,
    idCompany: null, // Lepas idCompany untuk keamanan akses
  });

  // 7. Sync totalEmployees (decrement)
  await db.collection("companies").doc(companyId).update({
    totalEmployees: FieldValue.increment(-1),
  });

  // 8. Log Aktivitas
  await logCompanyActivity(companyId, {
    actorEmail: actor.email,
    actorName: actor.nama || "Admin",
    target: email,
    action: targetStatus === "resigned" ? "EMPLOYEE_RESIGNED" : "EMPLOYEE_TERMINATED",
    description: `Admin ${actor.nama || "Admin"} menonaktifkan ${userData.username || email} (${targetStatus.toUpperCase()}). Alasan: ${finalReason}`,
  });

  // 9. Kirim Email Notifikasi
  EmailTemplates.send(email, "employee_fired", {
    username: userData.username || email,
    companyName: companyData.namaPerusahaan,
    reason: finalReason,
  }).catch((err) => console.error(`[Email Notification] Gagal kirim email deactivation ke ${email}:`, err.message));

  return {
    userEmail: email,
    status: targetStatus,
    deactivatedAt: empUpdateData.deactivatedAt.toDate().toISOString(),
    deactivatedBy: actor.email,
    reason: finalReason,
  };
};

/**
 * 5. SYNC USER TO EMPLOYEE SUBCOLLECTION (Helper saat approve / join)
 */
const syncUserToEmployee = async (companyId, email, customFields = {}) => {
  if (!companyId || !email) return;

  const empRef = db.collection("companies").doc(companyId).collection("employees").doc(email);
  const userRef = db.collection("users").doc(email);
  const userSnap = await userRef.get();

  const uData = userSnap.exists ? userSnap.data() : {};

  const payload = {
    userEmail: email,
    role: customFields.role || uData.role || "staff",
    jabatan: customFields.jabatan || capitalize(customFields.role || uData.role || "staff"),
    status: customFields.status || uData.status || "active",
    joinDate: customFields.joinDate || uData.createdAt || Timestamp.now(),
    leaveBalance: customFields.leaveBalance !== undefined ? customFields.leaveBalance : 12,
    shiftQuota: customFields.shiftQuota !== undefined ? customFields.shiftQuota : 0,
    gaji: customFields.gaji !== undefined ? Number(customFields.gaji) : (uData.gaji !== undefined ? Number(uData.gaji) : 0),
    config: customFields.config || {},
    updatedAt: Timestamp.now(),
  };

  await empRef.set(payload, { merge: true });
};

module.exports = {
  normalizeEmployee,
  getCompanyEmployees,
  getEmployeeDetail,
  updateEmployee,
  deactivateEmployee,
  syncUserToEmployee,
};
