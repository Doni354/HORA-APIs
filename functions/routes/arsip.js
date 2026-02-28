/* eslint-disable */
const express = require("express");
const ExcelJS = require("exceljs");
const { db } = require("../config/firebase");
const router = express.Router();
const { ExcelFormatter, ExcelTemplate, COLORS } = require("../helper/excel");
const EmailTemplates = require("../helper/emailHelper");
// Ganti sesuai domain API kamu yang sebenarnya agar link di email bisa diklik
const BASE_URL = "https://api-y4ntpb3uvq-et.a.run.app/api/arsip";

// ---------------------------------------------------------
// HELPER FUNCTIONS
// ---------------------------------------------------------
// Helper Format Rupiah untuk Email
const formatRupiah = (angka) => {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
  }).format(angka);
};
const formatDateIndo = (timestamp) => {
  if (!timestamp) return "-";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toLocaleDateString("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

const formatTime = (timestamp) => {
  if (!timestamp) return "-";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  });
};

// Menghitung durasi single record
const calculateDuration = (start, end) => {
  if (!start || !end) return "-";
  const startTime = start.toDate ? start.toDate() : new Date(start);
  const endTime = end.toDate ? end.toDate() : new Date(end);
  const diffMs = endTime - startTime;
  if (diffMs < 0) return "00:00:00";

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
  const pad = (num) => num.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

// Helper konversi total milidetik ke string "JJ:MM:DD"
const msToTimeStr = (duration) => {
  const seconds = Math.floor((duration / 1000) % 60);
  const minutes = Math.floor((duration / (1000 * 60)) % 60);
  const hours = Math.floor(duration / (1000 * 60 * 60));

  const pad = (num) => num.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

// ---------------------------------------------------------
// 1. GET /Kinerja -> Total Jam Kerja Karyawan Per Bulan
// ---------------------------------------------------------
router.get("/Kinerja", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const { idperusahaan, month } = req.query;

    // 1. Auth Check
    if (!authHeader.startsWith("Bearer ")) {
      // Di sini kita return 401/203 sesuai kebutuhan, saya samakan dengan logic sebelumnya
      return res.status(203).send("Unauthorized");
    }

    // 2. Validation
    if (!idperusahaan || !month) {
      return res.status(400).json({
        message: "Missing required parameters: idperusahaan, month (YYYY-MM)",
      });
    }

    // 3. Parse Date Range (Start of Month - End of Month)
    const [year, monthStr] = month.split("-");
    const y = parseInt(year);
    const m = parseInt(monthStr) - 1; // Javascript Month is 0-indexed (0 = Jan, 8 = Sept)

    const startDate = new Date(y, m, 1); // Tanggal 1 bulan tersebut
    const endDate = new Date(y, m + 1, 0, 23, 59, 59); // Tanggal terakhir bulan tersebut

    // 4. Fetch Data Absensi
    const snapshot = await db
      .collection("companies")
      .doc(idperusahaan)
      .collection("absensi")
      .where("tanggal", ">=", startDate)
      .where("tanggal", "<=", endDate)
      .get();

    if (snapshot.empty) {
      return res.status(200).json([]);
    }

    // 5. Agregasi Data
    const kinerjaMap = {};

    snapshot.forEach((doc) => {
      const data = doc.data();
      const idKaryawan = data.idKaryawan;

      // Pastikan data checkout ada untuk menghitung durasi
      if (data.waktuCheckIn && data.waktuCheckOut) {
        const start = data.waktuCheckIn.toDate
          ? data.waktuCheckIn.toDate()
          : new Date(data.waktuCheckIn);
        const end = data.waktuCheckOut.toDate
          ? data.waktuCheckOut.toDate()
          : new Date(data.waktuCheckOut);

        const diffMs = end - start;

        // Jika perhitungan valid (tidak minus)
        if (diffMs > 0) {
          if (!kinerjaMap[idKaryawan]) {
            kinerjaMap[idKaryawan] = {
              namaKaryawan: data.namaKaryawan || "No Name",
              totalMs: 0,
              jumlahKehadiran: 0,
            };
          }

          kinerjaMap[idKaryawan].totalMs += diffMs;
          kinerjaMap[idKaryawan].jumlahKehadiran += 1;
        }
      }
    });

    // 6. Format Response
    const responseData = Object.keys(kinerjaMap).map((key) => {
      const item = kinerjaMap[key];
      return {
        namaKaryawan: item.namaKaryawan,
        totalKehadiran: item.jumlahKehadiran,
        totalDurasiKinerja: msToTimeStr(item.totalMs), // Format JJ:MM:DD
      };
    });

    return res.status(200).json(responseData);
  } catch (e) {
    console.error("Get Kinerja error:", e);
    return res
      .status(500)
      .json({ message: "Gagal mengambil data kinerja", error: e.message });
  }
});

// ---------------------------------------------------------
// 2. GET /statlaporan -> Kirim Email Laporan Perizinan (+ Tombol Download)
// ---------------------------------------------------------
router.get("/statlaporan", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    // Ambil parameter raw dari query untuk dipassing ke link download
    const { idperusahaan, tglstart, tglend, emailrep } = req.query;

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(203).send("Only accesisble by admin");
    }

    if (!idperusahaan || !tglstart || !tglend || !emailrep) {
      return res.status(400).json({ message: "Missing required parameters" });
    }

    const startDate = new Date(tglstart);
    const endDate = new Date(tglend);

    // Get Company Info
    const companyRef = db.collection("companies").doc(idperusahaan);
    const companySnap = await companyRef.get();
    let namaPerusahaanDisplay = idperusahaan;
    if (companySnap.exists && companySnap.data().namaPerusahaan) {
      namaPerusahaanDisplay = companySnap.data().namaPerusahaan;
    }

    // Kirim Email dengan Link Export (via EmailHelper)
    const exportLink = `${BASE_URL}/export/laporan?idperusahaan=${idperusahaan}&tglstart=${tglstart}&tglend=${tglend}`;

    await EmailTemplates.send([emailrep], "report", {
      companyName: namaPerusahaanDisplay,
      reportTitle: "Laporan Rekap Perizinan",
      subject: `Laporan Perizinan - ${namaPerusahaanDisplay}`,
      periode: `${formatDateIndo(startDate)} s/d ${formatDateIndo(endDate)}`,
      link: exportLink,
    });

    return res.status(200).send("Report has been emailed");
  } catch (e) {
    console.error("Statistik Laporan error:", e);
    return res.status(500).json({ message: "Error", error: e.message });
  }
});

// ---------------------------------------------------------
// 3. GET /statkehadiran -> Kirim Email Kehadiran (+ Tombol Download)
// ---------------------------------------------------------
router.get("/statkehadiran", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const { idperusahaan, tglstart, tglend, emailrep } = req.query;

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(203).send("Only accesisble by admin");
    }

    if (!idperusahaan || !tglstart || !tglend || !emailrep) {
      return res.status(400).json({ message: "Missing required parameters" });
    }

    const startDate = new Date(tglstart);
    const endDate = new Date(tglend);

    const companyDoc = await db.collection("companies").doc(idperusahaan).get();
    let namaPerusahaanDisplay = idperusahaan;
    if (companyDoc.exists && companyDoc.data().namaPerusahaan) {
      namaPerusahaanDisplay = companyDoc.data().namaPerusahaan;
    }

    // Kirim Email dengan Link Export (via EmailHelper)
    const exportLink = `${BASE_URL}/export/kehadiran?idperusahaan=${idperusahaan}&tglstart=${tglstart}&tglend=${tglend}`;

    await EmailTemplates.send([emailrep], "report", {
      companyName: namaPerusahaanDisplay,
      reportTitle: "Laporan Kehadiran Bulanan",
      subject: `Laporan Kehadiran - ${namaPerusahaanDisplay}`,
      periode: `${formatDateIndo(startDate)} s/d ${formatDateIndo(endDate)}`,
      link: exportLink,
    });

    return res.status(200).send("Report has been emailed");
  } catch (e) {
    console.error("Statistik Kehadiran error:", e);
    return res.status(500).json({ message: "Error", error: e.message });
  }
});

// ---------------------------------------------------------
// 4. GET /export/laporan - DOWNLOAD Excel Perizinan (Stream)
// ---------------------------------------------------------
router.get("/export/laporan", async (req, res) => {
  try {
    const { idperusahaan, tglstart, tglend } = req.query;
    if (!idperusahaan || !tglstart || !tglend) {
      return res.status(400).send("Parameter tidak lengkap");
    }

    // 1. Ambil Data Perusahaan
    const companyDoc = await db.collection("companies").doc(idperusahaan).get();
    if (!companyDoc.exists)
      return res.status(404).send("Perusahaan tidak ditemukan");

    const cData = companyDoc.data();
    const namaPT = cData.namaPerusahaan || idperusahaan;
    const emailAdmin = cData.createdBy || cData.email || "hr@sms.id";

    // 2. Filter Tanggal & Query (Hanya yang Approved)
    const startDateFilter = new Date(tglstart);
    const endDateFilter = new Date(tglend);
    endDateFilter.setHours(23, 59, 59, 999);

    const snapshot = await db
      .collection("companies")
      .doc(idperusahaan)
      .collection("leaves")
      .where("status", "==", "approved")
      .where("startDate", "<=", endDateFilter)
      .get();

    // 3. Grouping Data: Map<Nama, Map<Tanggal, { tipe, link }>>
    const leavesMap = new Map();

    snapshot.forEach((doc) => {
      const data = doc.data();
      const nama = data.userName || data.userId || "Tanpa Nama";

      const startIzin = data.startDate?.toDate
        ? data.startDate.toDate()
        : new Date(data.startDate);
      const endIzin = data.endDate?.toDate
        ? data.endDate.toDate()
        : new Date(data.endDate);

      if (!leavesMap.has(nama)) leavesMap.set(nama, {});

      let current = new Date(startIzin);
      while (current <= endIzin) {
        if (current >= startDateFilter && current <= endDateFilter) {
          const day = current.getDate();
          leavesMap.get(nama)[day] = {
            tipe: data.tipeIzin || "Izin",
            link: data.attachmentUrl || null,
          };
        }
        current.setDate(current.getDate() + 1);
      }
    });

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Arsip Perizinan");

    const now = new Date();
    const exportDateStr = now.toLocaleDateString("id-ID", {
      timeZone: "Asia/Jakarta",
    });
    const exportTimeStr = now
      .toLocaleTimeString("id-ID", {
        timeZone: "Asia/Jakarta",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
      .replace(/\./g, ":");

    // 4. Build Header Informasi (A1-C7)
    ExcelTemplate.buildHeaderInfo(ws, [
      `Arsip Perizinan PT. ${namaPT}`,
      startDateFilter.toLocaleDateString("id-ID"),
      endDateFilter.toLocaleDateString("id-ID"),
      "VORCE",
      emailAdmin,
      exportDateStr,
      exportTimeStr,
    ]);

    const RINCIAN_LABELS = ["Tipe", "Lampiran"];
    let currentRow = 9;

    // 5. Loop Setiap Karyawan
    leavesMap.forEach((daysData, namaKaryawan) => {
      if (currentRow > 9) currentRow += 1;

      ExcelTemplate.buildTableGridHeader(ws, currentRow);
      const dataStartRow = currentRow + 2;

      const lastRowOfEmp = dataStartRow + 1;
      ws.mergeCells(`A${dataStartRow}:A${lastRowOfEmp}`);
      const nameCell = ws.getCell(`A${dataStartRow}`);
      nameCell.value = namaKaryawan;
      ExcelFormatter.setCellStyle(
        nameCell,
        COLORS.PURPLE,
        COLORS.WHITE,
        "center"
      );

      RINCIAN_LABELS.forEach((label, idx) => {
        const rincianCell = ws.getCell(dataStartRow + idx, 2);
        rincianCell.value = label;
        ExcelFormatter.setCellStyle(
          rincianCell,
          COLORS.PURPLE,
          COLORS.WHITE,
          "left"
        );
      });

      // Isi Data 1 - 31
      for (let d = 1; d <= 31; d++) {
        const col = 2 + d;
        const leaveData = daysData[d];

        // Baris Tipe
        const cellTipe = ws.getCell(dataStartRow, col);
        cellTipe.value = leaveData ? leaveData.tipe : "-";
        // Rule: Selalu Putih untuk Arsip Perizinan
        ExcelFormatter.setCellStyle(
          cellTipe,
          COLORS.WHITE,
          COLORS.BLACK,
          "center"
        );

        // Baris Lampiran
        const cellLink = ws.getCell(dataStartRow + 1, col);
        if (leaveData && leaveData.link) {
          cellLink.value = { text: "Buka", hyperlink: leaveData.link };
          ExcelFormatter.setCellStyle(
            cellLink,
            COLORS.WHITE,
            COLORS.LINK_BLUE,
            "center"
          );
          cellLink.font.underline = true;
        } else {
          cellLink.value = "-";
          ExcelFormatter.setCellStyle(
            cellLink,
            COLORS.WHITE,
            COLORS.BLACK,
            "center"
          );
        }
      }

      currentRow = lastRowOfEmp + 1;
    });

    ExcelFormatter.adjustColumnWidth(ws);
    ExcelFormatter.fixRowHeights(ws);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Arsip_Perizinan_${namaPT.replace(/\s+/g, "_")}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error("Export Perizinan Error:", e);
    res.status(500).send(`Gagal download excel perizinan: ${e.message}`);
  }
});
// ---------------------------------------------------------
// 5. GET /export/kehadiran - DOWNLOAD Excel Kehadiran (Stream)
// ---------------------------------------------------------
router.get("/export/kehadiran", async (req, res) => {
  try {
    const { idperusahaan, tglstart, tglend } = req.query;
    if (!idperusahaan || !tglstart || !tglend)
      return res.status(400).send("Parameter tidak lengkap");

    const companyDoc = await db.collection("companies").doc(idperusahaan).get();
    if (!companyDoc.exists)
      return res.status(404).send("Perusahaan tidak ditemukan");

    const cData = companyDoc.data();
    const namaPT = cData.namaPerusahaan || idperusahaan;
    const emailAdmin = cData.createdBy || cData.email || "hr@sms.id";

    const startDate = new Date(tglstart);
    const endDate = new Date(tglend);
    if (tglend.length <= 10) endDate.setHours(23, 59, 59, 999);

    // 1. Ambil Data Absensi
    const absensiSnapshot = await db
      .collection("companies")
      .doc(idperusahaan)
      .collection("absensi")
      .where("tanggal", ">=", startDate)
      .where("tanggal", "<=", endDate)
      .orderBy("tanggal", "asc")
      .get();

    // 2. Ambil Data Perizinan (Approved)
    const leavesSnapshot = await db
      .collection("companies")
      .doc(idperusahaan)
      .collection("leaves")
      .where("status", "==", "approved")
      .where("startDate", "<=", endDate)
      .get();

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Arsip Kehadiran");

    const now = new Date();
    const exportDateStr = now.toLocaleDateString("id-ID", {
      timeZone: "Asia/Jakarta",
    });
    const exportTimeStr = now
      .toLocaleTimeString("id-ID", {
        timeZone: "Asia/Jakarta",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
      .replace(/\./g, ":");

    ExcelTemplate.buildHeaderInfo(ws, [
      `Arsip hadir PT. ${namaPT}`,
      startDate.toLocaleDateString("id-ID"),
      endDate.toLocaleDateString("id-ID"),
      "VORCE",
      emailAdmin,
      exportDateStr,
      exportTimeStr,
    ]);

    const RINCIAN_LABELS = [
      "Shift",
      "Masuk",
      "Pulang",
      "Durasi",
      "Cekin",
      "Cekout",
      "Lokasi",
    ];

    // 3. Gabungkan Data per Karyawan
    const employeeData = new Map(); // Map<Nama, { absensi: Map<day, data>, leaves: Map<day, data> }>

    absensiSnapshot.forEach((doc) => {
      const d = doc.data();
      const nama = d.namaKaryawan || "Tanpa Nama";
      if (!employeeData.has(nama))
        employeeData.set(nama, { absensi: new Map(), leaves: new Map() });

      const dateObj = d.tanggal.toDate
        ? d.tanggal.toDate()
        : new Date(d.tanggal);
      employeeData.get(nama).absensi.set(dateObj.getDate(), d);
    });

    leavesSnapshot.forEach((doc) => {
      const d = doc.data();
      const nama = d.userName || d.userId || "Tanpa Nama";
      if (!employeeData.has(nama))
        employeeData.set(nama, { absensi: new Map(), leaves: new Map() });

      const startIzin = d.startDate?.toDate
        ? d.startDate.toDate()
        : new Date(d.startDate);
      const endIzin = d.endDate?.toDate
        ? d.endDate.toDate()
        : new Date(d.endDate);

      let current = new Date(startIzin);
      while (current <= endIzin) {
        if (current >= startDate && current <= endDate) {
          employeeData
            .get(nama)
            .leaves.set(current.getDate(), d.tipeIzin || "Izin");
        }
        current.setDate(current.getDate() + 1);
      }
    });

    let currentRow = 9;

    employeeData.forEach((dataObj, namaKaryawan) => {
      if (currentRow > 9) currentRow += 1;

      ExcelTemplate.buildTableGridHeader(ws, currentRow);
      const dataStartRow = currentRow + 2;

      // Nama (A)
      const lastRowOfEmp = dataStartRow + 6;
      ws.mergeCells(`A${dataStartRow}:A${lastRowOfEmp}`);
      const nameCell = ws.getCell(`A${dataStartRow}`);
      nameCell.value = namaKaryawan;
      ExcelFormatter.setCellStyle(
        nameCell,
        COLORS.PURPLE,
        COLORS.WHITE,
        "center"
      );

      // Label Rincian (B)
      RINCIAN_LABELS.forEach((label, idx) => {
        const rincianCell = ws.getCell(dataStartRow + idx, 2);
        rincianCell.value = label;
        ExcelFormatter.setCellStyle(
          rincianCell,
          COLORS.PURPLE,
          COLORS.WHITE,
          "left"
        );
      });

      // Data Per Tanggal
      for (let d = 1; d <= 31; d++) {
        const col = 2 + d;
        const leaveType = dataObj.leaves.get(d);
        const absensi = dataObj.absensi.get(d);

        if (leaveType) {
          // JIKA ADA IZIN: Isi semua baris rincian dengan tipe izin, background ORANYE
          for (let idx = 0; idx < 7; idx++) {
            const cell = ws.getCell(dataStartRow + idx, col);
            cell.value = leaveType;
            ExcelFormatter.setCellStyle(
              cell,
              COLORS.ORANGE,
              COLORS.BLACK,
              "center"
            );
          }
        } else if (absensi) {
          // JIKA ADA ABSENSI: Isi data normal
          const durasiFormatted = absensi.durasi
            ? ExcelFormatter.formatDuration(absensi.durasi)
            : "-";
          const rowValues = [
            absensi.shift,
            ExcelFormatter.formatToAMPM(absensi.waktuCheckIn),
            ExcelFormatter.formatToAMPM(absensi.waktuCheckOut),
            durasiFormatted,
            absensi.fotoCheckIn ? "Buka" : "-",
            absensi.fotoCheckOut ? "Buka" : "-",
            absensi.alamatLatitude || absensi.alamatLoc ? "Buka" : "-",
          ];
          const links = [
            null,
            null,
            null,
            null,
            absensi.fotoCheckIn,
            absensi.fotoCheckOut,
            absensi.alamatLatitude && absensi.alamatLongtitude
              ? `https://www.google.com/maps?q=${absensi.alamatLatitude},${absensi.alamatLongtitude}`
              : null,
          ];

          rowValues.forEach((val, idx) => {
            const cell = ws.getCell(dataStartRow + idx, col);
            ExcelFormatter.applyDataCellStyle(
              cell,
              val,
              !!links[idx],
              links[idx]
            );
          });
        } else {
          // KOSONG: Isi "-" background MERAH (default applyDataCellStyle untuk "-")
          for (let idx = 0; idx < 7; idx++) {
            const cell = ws.getCell(dataStartRow + idx, col);
            ExcelFormatter.applyDataCellStyle(cell, "-");
          }
        }
      }

      currentRow = lastRowOfEmp + 1;
    });

    ExcelFormatter.adjustColumnWidth(ws);
    ExcelFormatter.fixRowHeights(ws);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Arsip_Kehadiran_${namaPT.replace(/\s+/g, "_")}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error("Export Error:", e);
    res.status(500).send(`Gagal download excel: ${e.message}`);
  }
});

// ---------------------------------------------------------
// 6. GET /statreimburse -> Kirim Email Laporan Reimburse (+ Tombol Download)
// ---------------------------------------------------------
router.get("/statreimburse", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const { idperusahaan, tglstart, tglend, emailrep } = req.query;

    // 1. Auth Check (Menyesuaikan style arsip.js)
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(203).send("Unauthorized");
    }

    // 2. Validation
    if (!idperusahaan || !tglstart || !tglend || !emailrep) {
      return res.status(400).json({ message: "Missing required parameters" });
    }

    const startDate = new Date(tglstart);
    const endDate = new Date(tglend);
    // Pastikan endDate mencakup sampai akhir hari tersebut
    endDate.setHours(23, 59, 59, 999);

    // 3. Get Company Info
    const companyRef = db.collection("companies").doc(idperusahaan);
    const companySnap = await companyRef.get();
    let namaPerusahaanDisplay = idperusahaan;
    if (companySnap.exists && companySnap.data().namaPerusahaan) {
      namaPerusahaanDisplay = companySnap.data().namaPerusahaan;
    }

    // 4. Fetch Reimbursements
    // Note: Pastikan field di database adalah 'date' (timestamp)
    const snapshot = await db
      .collection("companies")
      .doc(idperusahaan)
      .collection("reimbursements")
      .where("date", ">=", startDate)
      .where("date", "<=", endDate)
      .orderBy("date", "desc")
      .get();

    // Kirim Email dengan Link Export (via EmailHelper)
    const exportLink = `${BASE_URL}/export/reimburse?idperusahaan=${idperusahaan}&tglstart=${tglstart}&tglend=${tglend}`;

    await EmailTemplates.send([emailrep], "report", {
      companyName: namaPerusahaanDisplay,
      reportTitle: "Laporan Reimburse",
      subject: `Laporan Reimburse - ${namaPerusahaanDisplay}`,
      periode: `${formatDateIndo(startDate)} s/d ${formatDateIndo(endDate)}`,
      link: exportLink,
    });

    return res.status(200).send("Report has been emailed");
  } catch (e) {
    console.error("Statistik Reimburse error:", e);
    return res.status(500).json({ message: "Error", error: e.message });
  }
});

// ---------------------------------------------------------
// 7. GET /export/reimburse - DOWNLOAD Excel Reimburse (Stream)
// ---------------------------------------------------------
router.get("/export/reimburse", async (req, res) => {
  try {
    const { idperusahaan, tglstart, tglend } = req.query;
    if (!idperusahaan || !tglstart || !tglend) {
      return res.status(400).send("Parameter tidak lengkap");
    }

    // 1. Ambil Data Perusahaan
    const companyDoc = await db.collection("companies").doc(idperusahaan).get();
    if (!companyDoc.exists)
      return res.status(404).send("Perusahaan tidak ditemukan");

    const cData = companyDoc.data();
    const namaPT = cData.namaPerusahaan || idperusahaan;
    const emailAdmin = cData.createdBy || cData.email || "hr@sms.id";

    // 2. Filter Tanggal
    const startDate = new Date(tglstart);
    const endDate = new Date(tglend);
    endDate.setHours(23, 59, 59, 999);

    // 3. Query Reimbursements - Filter hanya yang statusnya "Lunas"
    const snapshot = await db
      .collection("companies")
      .doc(idperusahaan)
      .collection("reimbursements")
      .where("status", "==", "Lunas") // Request: Hanya yang sudah lunas
      .where("date", ">=", startDate)
      .where("date", "<=", endDate)
      .get();

    // 4. Grouping & Sum Data per Karyawan: Map<Nama, Map<Day, TotalAmount>>
    const reimburseMap = new Map();

    snapshot.forEach((doc) => {
      const data = doc.data();
      const nama = data.requestByName || data.requestByEmail || "Tanpa Nama";
      const dateObj = data.date?.toDate
        ? data.date.toDate()
        : new Date(data.date);
      const day = dateObj.getDate();
      const amount = Number(data.amount) || 0;

      if (!reimburseMap.has(nama)) reimburseMap.set(nama, new Map());

      const currentDaySum = reimburseMap.get(nama).get(day) || 0;
      reimburseMap.get(nama).set(day, currentDaySum + amount);
    });

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Arsip Reimburse");

    const now = new Date();
    const exportDateStr = now.toLocaleDateString("id-ID", {
      timeZone: "Asia/Jakarta",
    });
    const exportTimeStr = now
      .toLocaleTimeString("id-ID", {
        timeZone: "Asia/Jakarta",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
      .replace(/\./g, ":");

    // 5. Build Header Informasi (A1-C7)
    ExcelTemplate.buildHeaderInfo(ws, [
      `Arsip Reimburse (Lunas) PT. ${namaPT}`,
      startDate.toLocaleDateString("id-ID"),
      endDate.toLocaleDateString("id-ID"),
      "VORCE",
      emailAdmin,
      exportDateStr,
      exportTimeStr,
    ]);

    const RINCIAN_LABELS = ["Total Lunas (Rp)"];
    let currentRow = 9;

    // Helper format currency Rp18,350.00
    const formatRp = (val) => {
      if (val === undefined || val === null || val === 0) return "Rp0.00";
      return (
        "Rp" +
        Number(val).toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      );
    };

    // 6. Loop Setiap Karyawan
    reimburseMap.forEach((daysSumMap, namaKaryawan) => {
      if (currentRow > 9) currentRow += 1;

      ExcelTemplate.buildTableGridHeader(ws, currentRow);
      const dataStartRow = currentRow + 2;

      // Nama (A)
      const nameCell = ws.getCell(`A${dataStartRow}`);
      nameCell.value = namaKaryawan;
      ExcelFormatter.setCellStyle(
        nameCell,
        COLORS.PURPLE,
        COLORS.WHITE,
        "center"
      );

      // Label Rincian (B)
      const rincianCell = ws.getCell(dataStartRow, 2);
      rincianCell.value = RINCIAN_LABELS[0];
      ExcelFormatter.setCellStyle(
        rincianCell,
        COLORS.PURPLE,
        COLORS.WHITE,
        "left"
      );

      // Data 1 - 31
      for (let d = 1; d <= 31; d++) {
        const col = 2 + d;
        const totalAmount = daysSumMap.get(d) || 0;

        const cell = ws.getCell(dataStartRow, col);
        if (totalAmount > 0) {
          cell.value = formatRp(totalAmount);
          // Data ada: BG Putih, Font Hitam Bold
          ExcelFormatter.setCellStyle(
            cell,
            COLORS.WHITE,
            COLORS.BLACK,
            "center"
          );
          cell.font.bold = true;
        } else {
          cell.value = "-";
          // Kosong: BG Putih, Font Hitam Biasa
          ExcelFormatter.setCellStyle(
            cell,
            COLORS.WHITE,
            COLORS.BLACK,
            "center"
          );
          cell.font.bold = false;
        }
      }

      currentRow = dataStartRow + 1;
    });

    // 7. Sentuhan Akhir
    ExcelFormatter.adjustColumnWidth(ws);
    ExcelFormatter.fixRowHeights(ws);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Arsip_Reimburse_Lunas_${namaPT.replace(
        /\s+/g,
        "_"
      )}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error("Export Reimburse Error:", e);
    res.status(500).send(`Gagal download excel reimburse: ${e.message}`);
  }
});
// ---------------------------------------------------------
// 8. GET /stattugas -> Kirim Email Laporan Tugas (+ Tombol Download)
// ---------------------------------------------------------
router.get("/stattugas", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const { idperusahaan, tglstart, tglend, emailrep } = req.query;

    // 1. Auth Check
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(203).send("Unauthorized");
    }

    // 2. Validation
    if (!idperusahaan || !tglstart || !tglend || !emailrep) {
      return res.status(400).json({ message: "Missing required parameters" });
    }

    const startDate = new Date(tglstart);
    const endDate = new Date(tglend);
    endDate.setHours(23, 59, 59, 999);

    // 3. Get Company Info
    const companyRef = db.collection("companies").doc(idperusahaan);
    const companySnap = await companyRef.get();
    let namaPerusahaanDisplay = idperusahaan;
    if (companySnap.exists && companySnap.data().namaPerusahaan) {
      namaPerusahaanDisplay = companySnap.data().namaPerusahaan;
    }

    // 4. Fetch Tasks (Filter berdasarkan Tanggal Pembuatan Tugas)
    const snapshot = await db
      .collection("companies")
      .doc(idperusahaan)
      .collection("tasks")
      .where("createdAt", ">=", startDate)
      .where("createdAt", "<=", endDate)
      .orderBy("createdAt", "desc")
      .get();

    // Kirim Email dengan Link Export (via EmailHelper)
    const exportLink = `${BASE_URL}/export/tugas?idperusahaan=${idperusahaan}&tglstart=${tglstart}&tglend=${tglend}`;

    await EmailTemplates.send([emailrep], "report", {
      companyName: namaPerusahaanDisplay,
      reportTitle: "Laporan Tugas Karyawan",
      subject: `Laporan Tugas - ${namaPerusahaanDisplay}`,
      periode: `${formatDateIndo(startDate)} s/d ${formatDateIndo(endDate)}`,
      link: exportLink,
    });

    return res.status(200).send("Report has been emailed");
  } catch (e) {
    console.error("Statistik Tugas error:", e);
    return res.status(500).json({ message: "Error", error: e.message });
  }
});

// ---------------------------------------------------------
// 9. GET /export/tugas - DOWNLOAD Excel Tugas (Stream)
// ---------------------------------------------------------
router.get("/export/tugas", async (req, res) => {
  try {
    const { idperusahaan, tglstart, tglend } = req.query;
    if (!idperusahaan || !tglstart || !tglend) {
      return res.status(400).send("Parameter tidak lengkap");
    }

    // 1. Ambil Data Perusahaan
    const companyDoc = await db.collection("companies").doc(idperusahaan).get();
    if (!companyDoc.exists)
      return res.status(404).send("Perusahaan tidak ditemukan");

    const cData = companyDoc.data();
    const namaPT = cData.namaPerusahaan || idperusahaan;
    const emailAdmin = cData.createdBy || cData.email || "hr@sms.id";

    // 2. Filter Tanggal
    const startDate = new Date(tglstart);
    const endDate = new Date(tglend);
    endDate.setHours(23, 59, 59, 999);

    // 3. Query Tasks
    const snapshot = await db
      .collection("companies")
      .doc(idperusahaan)
      .collection("tasks")
      .where("createdAt", ">=", startDate)
      .where("createdAt", "<=", endDate)
      .get();

    // 4. Grouping Data: Map<Nama, Map<Tanggal, {Proses, Tunda, Selesai}>>
    const statsMap = new Map();

    snapshot.forEach((doc) => {
      const data = doc.data();
      const createdAt = data.createdAt?.toDate
        ? data.createdAt.toDate()
        : new Date(data.createdAt);
      const day = createdAt.getDate();
      const status = data.status || "Proses";

      // Handle assignedToName (Bisa String atau Array)
      let names = [];
      if (Array.isArray(data.assignedToName)) {
        names = data.assignedToName;
      } else if (data.assignedToName) {
        names = [data.assignedToName];
      } else {
        names = ["Tanpa Nama"];
      }

      names.forEach((nama) => {
        if (!statsMap.has(nama)) statsMap.set(nama, {});
        if (!statsMap.get(nama)[day]) {
          statsMap.get(nama)[day] = { Proses: 0, Tunda: 0, Selesai: 0 };
        }

        // Tambahkan hitungan jika status cocok
        if (statsMap.get(nama)[day].hasOwnProperty(status)) {
          statsMap.get(nama)[day][status]++;
        } else {
          // Fallback jika ada status aneh di luar 3 itu, masukkan ke Proses atau abaikan
          statsMap.get(nama)[day]["Proses"]++;
        }
      });
    });

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Arsip Tugas");

    const now = new Date();
    const exportDateStr = now.toLocaleDateString("id-ID", {
      timeZone: "Asia/Jakarta",
    });
    const exportTimeStr = now
      .toLocaleTimeString("id-ID", {
        timeZone: "Asia/Jakarta",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
      .replace(/\./g, ":");

    // 5. Build Header Informasi (A1-C7)
    ExcelTemplate.buildHeaderInfo(ws, [
      `Arsip Tugas PT. ${namaPT}`,
      startDate.toLocaleDateString("id-ID"),
      endDate.toLocaleDateString("id-ID"),
      "VORCE",
      emailAdmin,
      exportDateStr,
      exportTimeStr,
    ]);

    const TASK_STATUS_LABELS = ["Proses", "Tunda", "Selesai"];
    let currentRow = 9;

    // 6. Loop Setiap Karyawan
    statsMap.forEach((daysData, namaKaryawan) => {
      if (currentRow > 9) currentRow += 1; // Gap antar karyawan

      ExcelTemplate.buildTableGridHeader(ws, currentRow);
      const dataStartRow = currentRow + 2;

      // Merge Nama (Kolom A) untuk 3 baris status
      const lastRowOfEmp = dataStartRow + 2;
      ws.mergeCells(`A${dataStartRow}:A${lastRowOfEmp}`);
      const nameCell = ws.getCell(`A${dataStartRow}`);
      nameCell.value = namaKaryawan;
      ExcelFormatter.setCellStyle(
        nameCell,
        COLORS.PURPLE,
        COLORS.WHITE,
        "center"
      );

      // Label Status (Kolom B)
      TASK_STATUS_LABELS.forEach((label, idx) => {
        const statusLabelCell = ws.getCell(dataStartRow + idx, 2);
        statusLabelCell.value = label;
        ExcelFormatter.setCellStyle(
          statusLabelCell,
          COLORS.PURPLE,
          COLORS.WHITE,
          "left"
        );
      });

      // Isi Data 1 - 31
      for (let d = 1; d <= 31; d++) {
        const col = 2 + d;
        const dailyTask = daysData[d]; // {Proses, Tunda, Selesai} atau undefined

        TASK_STATUS_LABELS.forEach((statusLabel, idx) => {
          const cell = ws.getCell(dataStartRow + idx, col);
          const count = dailyTask ? dailyTask[statusLabel] : 0;

          if (count > 0) {
            // Jika ada tugas: Tampilkan angka, bg Putih, text Hitam
            cell.value = count;
            ExcelFormatter.setCellStyle(
              cell,
              COLORS.WHITE,
              COLORS.BLACK,
              "center"
            );
            cell.font.bold = true;
          } else {
            // Sesuai Request: Jika tidak ada data, isi "-" bg putih
            cell.value = "-";
            ExcelFormatter.setCellStyle(
              cell,
              COLORS.WHITE,
              COLORS.BLACK,
              "center"
            );
            cell.font.bold = false;
          }
        });
      }

      currentRow = lastRowOfEmp + 1;
    });

    // 7. Finalisasi File
    ExcelFormatter.adjustColumnWidth(ws);
    ExcelFormatter.fixRowHeights(ws);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Arsip_Tugas_${namaPT.replace(/\s+/g, "_")}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error("Export Tugas Error:", e);
    res.status(500).send(`Gagal download excel tugas: ${e.message}`);
  }
});

// ---------------------------------------------------------
// 8. UPDATE RESOURCE LIMITS (API PAYMENT GATEWAY) UNTUK NANTI
// ---------------------------------------------------------
// Endpoint ini siap menerima Webhook dari Payment Gateway
router.post("/upgrade-resource", async (req, res) => {
  try {
    // A. Security Check (API Key)
    // Ambil dari Header (x-api-key) atau Body (secretKey)
    const apiKey = req.headers["x-api-key"] || req.body.secretKey;
    const SYSTEM_KEY = process.env.INTERNAL_API_KEY || "vorce-secret-key-123"; // Ganti di .env production

    if (apiKey !== SYSTEM_KEY) {
      return res.status(403).json({ message: "Forbidden: Invalid API Key" });
    }

    // B. Parse Data
    const { idCompany, maxStorage, maxKaryawan } = req.body;

    if (!idCompany)
      return res.status(400).json({ message: "ID Company required" });

    const updates = {};
    if (maxStorage !== undefined) updates.maxStorage = parseInt(maxStorage); // Pastikan angka (Bytes)
    if (maxKaryawan !== undefined) updates.maxKaryawan = parseInt(maxKaryawan); // Pastikan angka

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No data to update" });
    }

    // C. Update Firestore
    await db.collection("companies").doc(idCompany).update(updates);

    // D. Log System Activity
    await logCompanyActivity(idCompany, {
      actorEmail: "payment-gateway@vorce.io",
      actorName: "System Payment",
      target: idCompany,
      action: "UPGRADE_RESOURCE",
      description: `Upgrade Resource via API. Storage: ${
        maxStorage || "-"
      }, Karyawan: ${maxKaryawan || "-"}`,
    });

    // E. Kirim Notifikasi Email ke Owner
    // Ambil email owner dari data company
    const compDoc = await db.collection("companies").doc(idCompany).get();
    if (compDoc.exists) {
      const compData = compDoc.data();
      const ownerEmail = compData.createdBy;

      if (ownerEmail) {
        // Tulis ke collection 'mail' untuk trigger extension
        await EmailTemplates.send(ownerEmail, "upgrade", {
          companyName: compData.namaPerusahaan,
          maxStorageDisplay: maxStorage
            ? (maxStorage / 1024 / 1024).toFixed(0) + " MB"
            : "Tidak Berubah",
          maxKaryawanDisplay: maxKaryawan
            ? maxKaryawan + " Orang"
            : "Tidak Berubah",
        });
      }
    }

    return res
      .status(200)
      .json({ message: "Success updating resources", data: updates });
  } catch (e) {
    console.error("Upgrade API Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

module.exports = router;
