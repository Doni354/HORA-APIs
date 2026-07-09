/* eslint-disable */
const { db } = require("../config/firebase");

// =============================================================
// Custom Error Class
// =============================================================
class ShiftScheduleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ShiftScheduleError";
    this.code = code;
  }
}

// =============================================================
// resolveUserShift
// Cari schedule aktif untuk user pada tanggal tertentu,
// lalu ambil master shift data dari collection shifts.
// =============================================================
/**
 * @param {string} companyId  - ID perusahaan
 * @param {string} userId     - ID karyawan (email / uid)
 * @param {Date}   targetDate - Tanggal check-in (biasanya new Date())
 * @param {string} zone       - Timezone, default "Asia/Jakarta"
 * @returns {Promise<{ schedule: object, shift: object }>}
 */
async function resolveUserShift(companyId, userId, targetDate, zone = "Asia/Jakarta") {
  // 1. Hitung day-of-week di timezone yang diminta
  //    0 = Minggu, 1 = Senin, … 6 = Sabtu  (sesuai getDay())
  const localDateStr = targetDate.toLocaleDateString("en-CA", { timeZone: zone }); // "YYYY-MM-DD"
  const localDate = new Date(localDateStr + "T00:00:00"); // midnight lokal sebagai Date
  const dayOfWeek = localDate.getDay(); // 0-6

  // 2. Query semua schedule aktif di company ini
  const schedulesSnap = await db
    .collection("companies")
    .doc(companyId)
    .collection("shiftSchedules")
    .where("isActive", "==", true)
    .get();

  if (schedulesSnap.empty) {
    throw new ShiftScheduleError(
      "NO_ACTIVE_SCHEDULE",
      "Tidak ada jadwal shift aktif. Hubungi admin untuk mengatur jadwal."
    );
  }

  // 3. Filter di application level
  const matchingSchedules = [];

  schedulesSnap.forEach((doc) => {
    const data = doc.data();

    // a) User ada di userIds?
    if (!Array.isArray(data.userIds) || !data.userIds.includes(userId)) return;

    // b) Hari ini ada di days?
    if (!Array.isArray(data.days) || !data.days.includes(dayOfWeek)) return;

    // c) Tanggal dalam rentang startDate – endDate?
    const start = data.startDate?.toDate ? data.startDate.toDate() : new Date(data.startDate);
    const end = data.endDate?.toDate ? data.endDate.toDate() : new Date(data.endDate);

    // Bandingkan hanya tanggal (tanpa jam) agar inklusif
    const targetOnly = new Date(localDateStr + "T00:00:00");
    const startOnly = new Date(start.toISOString().slice(0, 10) + "T00:00:00");
    const endOnly = new Date(end.toISOString().slice(0, 10) + "T00:00:00");

    if (targetOnly < startOnly || targetOnly > endOnly) return;

    matchingSchedules.push({ id: doc.id, ...data });
  });

  if (matchingSchedules.length === 0) {
    throw new ShiftScheduleError(
      "NO_ACTIVE_SCHEDULE",
      "Anda tidak memiliki jadwal shift aktif hari ini."
    );
  }

  // 4. Jika lebih dari satu, ambil yang paling baru (createdAt desc)
  if (matchingSchedules.length > 1) {
    console.warn(
      `[ShiftSchedule] User ${userId} memiliki ${matchingSchedules.length} schedule cocok. Menggunakan yang terbaru.`
    );
    matchingSchedules.sort((a, b) => {
      const aTime = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0;
      const bTime = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 0;
      return bTime - aTime; // descending
    });
  }

  const schedule = matchingSchedules[0];

  // 5. Fetch master shift document
  if (!schedule.shiftId) {
    throw new ShiftScheduleError(
      "SHIFT_NOT_FOUND",
      "Schedule tidak memiliki referensi shift (shiftId kosong)."
    );
  }

  const shiftDoc = await db
    .collection("companies")
    .doc(companyId)
    .collection("shifts")
    .doc(schedule.shiftId)
    .get();

  if (!shiftDoc.exists) {
    throw new ShiftScheduleError(
      "SHIFT_NOT_FOUND",
      `Data master shift '${schedule.shiftId}' tidak ditemukan. Hubungi admin.`
    );
  }

  const shift = { id: shiftDoc.id, ...shiftDoc.data() };

  return { schedule, shift };
}

// =============================================================
// calculateLateness
// Hitung apakah check-in terlambat berdasarkan data shift.
// =============================================================
/**
 * @param {object} shift       - { startTime: "07:00", lateTolerance: 15 }
 * @param {Date}   checkInTime - Waktu check-in
 * @param {string} zone        - Timezone
 * @returns {{ isLate: boolean, lateMinutes: number }}
 */
function calculateLateness(shift, checkInTime, zone = "Asia/Jakarta") {
  try {
    const startTime = shift.startTime || "00:00";
    const tolerance = typeof shift.lateTolerance === "number" ? shift.lateTolerance : 0;

    // Parse "HH:MM"
    const [startHour, startMin] = startTime.split(":").map(Number);

    // Bangun deadline di timezone lokal: startTime + tolerance
    const deadlineMinutes = startHour * 60 + startMin + tolerance;
    const deadlineHour = Math.floor(deadlineMinutes / 60);
    const deadlineMin = deadlineMinutes % 60;

    // Ambil jam & menit check-in di timezone yang diminta
    const checkInHour = parseInt(
      checkInTime.toLocaleString("en-US", { timeZone: zone, hour: "numeric", hour12: false })
    );
    const checkInMin = parseInt(
      checkInTime.toLocaleString("en-US", { timeZone: zone, minute: "numeric" })
    );

    const checkInTotal = checkInHour * 60 + checkInMin;
    const deadlineTotal = deadlineHour * 60 + deadlineMin;

    if (checkInTotal > deadlineTotal) {
      return { isLate: true, lateMinutes: checkInTotal - deadlineTotal };
    }

    return { isLate: false, lateMinutes: 0 };
  } catch (err) {
    console.error("[ShiftSchedule] calculateLateness error:", err);
    return { isLate: false, lateMinutes: 0 };
  }
}

module.exports = {
  resolveUserShift,
  calculateLateness,
  ShiftScheduleError,
};
