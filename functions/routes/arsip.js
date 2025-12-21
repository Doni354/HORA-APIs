/* eslint-disable */
const express = require("express")
const ExcelJS = require("exceljs") 
const { db } = require("../config/firebase")

const router = express.Router()

// Ganti sesuai domain API kamu yang sebenarnya agar link di email bisa diklik
const BASE_URL = "https://api-y4ntpb3uvq-et.a.run.app/api/arsip" 

// ---------------------------------------------------------
// HELPER FUNCTIONS
// ---------------------------------------------------------

const formatDateIndo = (timestamp) => {
  if (!timestamp) return "-"
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp)
  return date.toLocaleDateString("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

const formatTime = (timestamp) => {
  if (!timestamp) return "-"
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp)
  return date.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

// Menghitung durasi single record
const calculateDuration = (start, end) => {
  if (!start || !end) return "-"
  const startTime = start.toDate ? start.toDate() : new Date(start)
  const endTime = end.toDate ? end.toDate() : new Date(end)
  const diffMs = endTime - startTime
  if (diffMs < 0) return "00:00:00"

  const hours = Math.floor(diffMs / (1000 * 60 * 60))
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60))
  const seconds = Math.floor((diffMs % (1000 * 60)) / 1000)
  const pad = (num) => num.toString().padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

// Helper konversi total milidetik ke string "JJ:MM:DD"
const msToTimeStr = (duration) => {
    const seconds = Math.floor((duration / 1000) % 60)
    const minutes = Math.floor((duration / (1000 * 60)) % 60)
    const hours = Math.floor((duration / (1000 * 60 * 60)))
  
    const pad = (num) => num.toString().padStart(2, '0')
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

// ---------------------------------------------------------
// 1. GET /Kinerja -> Total Jam Kerja Karyawan Per Bulan
// ---------------------------------------------------------
router.get("/Kinerja", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || ""
    const { idperusahaan, month } = req.query

    // 1. Auth Check
    if (!authHeader.startsWith("Bearer ")) {
      // Di sini kita return 401/203 sesuai kebutuhan, saya samakan dengan logic sebelumnya
      return res.status(203).send("Unauthorized")
    }

    // 2. Validation
    if (!idperusahaan || !month) {
      return res.status(400).json({ message: "Missing required parameters: idperusahaan, month (YYYY-MM)" })
    }

    // 3. Parse Date Range (Start of Month - End of Month)
    const [year, monthStr] = month.split("-")
    const y = parseInt(year)
    const m = parseInt(monthStr) - 1 // Javascript Month is 0-indexed (0 = Jan, 8 = Sept)

    const startDate = new Date(y, m, 1) // Tanggal 1 bulan tersebut
    const endDate = new Date(y, m + 1, 0, 23, 59, 59) // Tanggal terakhir bulan tersebut

    // 4. Fetch Data Absensi
    const snapshot = await db
      .collection("absensi")
      .where("idPerusahaan", "==", idperusahaan)
      .where("tanggal", ">=", startDate)
      .where("tanggal", "<=", endDate)
      .get()

    if (snapshot.empty) {
      return res.status(200).json([])
    }

    // 5. Agregasi Data
    const kinerjaMap = {}

    snapshot.forEach((doc) => {
      const data = doc.data()
      const idKaryawan = data.idKaryawan
      
      // Pastikan data checkout ada untuk menghitung durasi
      if (data.waktuCheckIn && data.waktuCheckOut) {
        const start = data.waktuCheckIn.toDate ? data.waktuCheckIn.toDate() : new Date(data.waktuCheckIn)
        const end = data.waktuCheckOut.toDate ? data.waktuCheckOut.toDate() : new Date(data.waktuCheckOut)
        
        const diffMs = end - start

        // Jika perhitungan valid (tidak minus)
        if (diffMs > 0) {
          if (!kinerjaMap[idKaryawan]) {
            kinerjaMap[idKaryawan] = {
              namaKaryawan: data.namaKaryawan || "No Name",
              totalMs: 0,
              jumlahKehadiran: 0
            }
          }
          
          kinerjaMap[idKaryawan].totalMs += diffMs
          kinerjaMap[idKaryawan].jumlahKehadiran += 1
        }
      }
    })

    // 6. Format Response
    const responseData = Object.keys(kinerjaMap).map(key => {
      const item = kinerjaMap[key]
      return {
        namaKaryawan: item.namaKaryawan,
        totalKehadiran: item.jumlahKehadiran,
        totalDurasiKinerja: msToTimeStr(item.totalMs) // Format JJ:MM:DD
      }
    })

    return res.status(200).json(responseData)

  } catch (e) {
    console.error("Get Kinerja error:", e)
    return res.status(500).json({ message: "Gagal mengambil data kinerja", error: e.message })
  }
})

// ---------------------------------------------------------
// 2. GET /statlaporan -> Kirim Email Laporan Perizinan (+ Tombol Download)
// ---------------------------------------------------------
router.get("/statlaporan", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || ""
    // Ambil parameter raw dari query untuk dipassing ke link download
    const { idperusahaan, tglstart, tglend, emailrep } = req.query

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(203).send("Only accesisble by admin")
    }

    if (!idperusahaan || !tglstart || !tglend || !emailrep) {
      return res.status(400).json({ message: "Missing required parameters" })
    }

    const startDate = new Date(tglstart)
    const endDate = new Date(tglend)

    // Get Company Info
    const companyRef = db.collection("companies").doc(idperusahaan)
    const companySnap = await companyRef.get()
    let namaPerusahaanDisplay = idperusahaan
    if (companySnap.exists && companySnap.data().namaPerusahaan) {
      namaPerusahaanDisplay = companySnap.data().namaPerusahaan
    }

    // Fetch Leaves
    const snapshot = await companyRef
      .collection("leaves")
      .where("startDate", ">=", startDate)
      .where("startDate", "<=", endDate)
      .get()

    let reportData = []
    if (!snapshot.empty) {
      reportData = snapshot.docs.map((doc) => {
        const data = doc.data()
        return {
          userName: data.userName || data.userId || "-", 
          tipeIzin: data.tipeIzin || "-",
          keterangan: data.keterangan || "-",
          status: data.status || "pending",
          startDate: data.startDate,
          endDate: data.endDate,
          attachmentUrl: data.attachmentUrl || null,
        }
      })
    }

    // Generate HTML Table
    let tableRows = ""
    if (reportData.length > 0) {
      reportData.forEach((row, index) => {
        const buktiLink = row.attachmentUrl
          ? `<a href="${row.attachmentUrl}" style="color: #007bff;">Lihat Bukti</a>`
          : "-"
        
        let statusColor = "#555"
        if (row.status.toLowerCase() === "approved") statusColor = "green"
        if (row.status.toLowerCase() === "rejected") statusColor = "red"

        tableRows += `
          <tr style="border-bottom: 1px solid #ddd;">
            <td style="padding: 8px;">${index + 1}</td>
            <td style="padding: 8px;">${row.userName}</td>
            <td style="padding: 8px;">${row.tipeIzin}</td>
            <td style="padding: 8px;">${formatDateIndo(row.startDate)}</td>
            <td style="padding: 8px;">${row.keterangan}</td>
            <td style="padding: 8px; font-weight: bold; color: ${statusColor};">${row.status}</td>
            <td style="padding: 8px;">${buktiLink}</td>
          </tr>`
      })
    } else {
      tableRows = `<tr><td colspan="7" style="padding: 20px; text-align: center;">Tidak ada data.</td></tr>`
    }

    // --- TOMBOL EXPORT ---
    // Link ini mengarah ke endpoint /export/laporan
    const exportLink = `${BASE_URL}/export/laporan?idperusahaan=${idperusahaan}&tglstart=${tglstart}&tglend=${tglend}`

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2 style="color: #2c3e50;">Laporan Rekap Perizinan</h2>
        <p>Perusahaan: <strong>${namaPerusahaanDisplay}</strong></p>
        <p>Periode: ${formatDateIndo(startDate)} s/d ${formatDateIndo(endDate)}</p>
        
        <!-- BUTTON EXPORT -->
        <div style="margin: 20px 0;">
          <a href="${exportLink}" target="_blank" 
             style="background-color: #28a745; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">
             Download Laporan Excel (.xlsx)
          </a>
        </div>

        <table style="width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 13px;">
          <thead>
            <tr style="background-color: #f2f2f2; text-align: left;">
              <th style="padding: 8px; border-bottom: 2px solid #ddd;">No</th>
              <th style="padding: 8px; border-bottom: 2px solid #ddd;">Karyawan</th>
              <th style="padding: 8px; border-bottom: 2px solid #ddd;">Tipe</th>
              <th style="padding: 8px; border-bottom: 2px solid #ddd;">Tanggal</th>
              <th style="padding: 8px; border-bottom: 2px solid #ddd;">Keterangan</th>
              <th style="padding: 8px; border-bottom: 2px solid #ddd;">Status</th>
              <th style="padding: 8px; border-bottom: 2px solid #ddd;">Lampiran</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
        <p style="margin-top: 20px; font-size: 11px; color: #777;">Generated by Hora App.</p>
      </div>
    `

    await db.collection("mail").add({
      to: [emailrep],
      message: {
        subject: `Laporan Perizinan - ${namaPerusahaanDisplay}`,
        html: htmlContent,
      },
      createdAt: new Date(),
    })

    return res.status(200).send("Report has been emailed")
  } catch (e) {
    console.error("Statistik Laporan error:", e)
    return res.status(500).json({ message: "Error", error: e.message })
  }
})

// ---------------------------------------------------------
// 3. GET /statkehadiran -> Kirim Email Kehadiran (+ Tombol Download)
// ---------------------------------------------------------
router.get("/statkehadiran", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || ""
    const { idperusahaan, tglstart, tglend, emailrep } = req.query

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(203).send("Only accesisble by admin")
    }

    if (!idperusahaan || !tglstart || !tglend || !emailrep) {
      return res.status(400).json({ message: "Missing required parameters" })
    }

    const startDate = new Date(tglstart)
    const endDate = new Date(tglend)

    const companyDoc = await db.collection("companies").doc(idperusahaan).get()
    let namaPerusahaanDisplay = idperusahaan
    if (companyDoc.exists && companyDoc.data().namaPerusahaan) {
      namaPerusahaanDisplay = companyDoc.data().namaPerusahaan
    }

    const snapshot = await db
      .collection("absensi")
      .where("idPerusahaan", "==", idperusahaan)
      .where("tanggal", ">=", startDate)
      .where("tanggal", "<=", endDate)
      .orderBy("tanggal", "desc")
      .get()

    let reportData = []
    if (!snapshot.empty) {
      reportData = snapshot.docs.map((doc) => {
        const data = doc.data()
        return {
          namaKaryawan: data.namaKaryawan || "-",
          tanggal: data.tanggal,
          waktuCheckIn: data.waktuCheckIn,
          waktuCheckOut: data.waktuCheckOut,
          fotoCheckIn: data.fotoCheckIn,
          fotoCheckOut: data.fotoCheckOut,
          durasiString: calculateDuration(data.waktuCheckIn, data.waktuCheckOut)
        }
      })
    }

    let tableRows = ""
    if (reportData.length > 0) {
      reportData.forEach((row, index) => {
        const renderPhoto = (url) => url ? `<a href="${url}">Foto</a>` : "-"
        tableRows += `
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 8px;">${index + 1}</td>
            <td style="padding: 8px;">${row.namaKaryawan}</td>
            <td style="padding: 8px;">${formatDateIndo(row.tanggal)}</td>
            <td style="padding: 8px;">${formatTime(row.waktuCheckIn)}</td>
            <td style="padding: 8px;">${renderPhoto(row.fotoCheckIn)}</td>
            <td style="padding: 8px;">${formatTime(row.waktuCheckOut)}</td>
            <td style="padding: 8px;">${renderPhoto(row.fotoCheckOut)}</td>
            <td style="padding: 8px; font-weight: bold;">${row.durasiString}</td>
          </tr>`
      })
    } else {
      tableRows = `<tr><td colspan="8" style="padding: 20px; text-align: center;">Tidak ada data.</td></tr>`
    }

    // --- TOMBOL EXPORT ---
    const exportLink = `${BASE_URL}/export/kehadiran?idperusahaan=${idperusahaan}&tglstart=${tglstart}&tglend=${tglend}`

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2 style="color: #2c3e50;">Laporan Kehadiran Bulanan</h2>
        <p>Perusahaan: <strong>${namaPerusahaanDisplay}</strong></p>
        <p>Periode: ${formatDateIndo(startDate)} s/d ${formatDateIndo(endDate)}</p>
        
        <!-- BUTTON EXPORT -->
        <div style="margin: 20px 0;">
          <a href="${exportLink}" target="_blank" 
             style="background-color: #28a745; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">
             Download Laporan Excel (.xlsx)
          </a>
        </div>

        <table style="width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 12px;">
          <thead>
            <tr style="background-color: #2c3e50; color: #fff;">
              <th style="padding: 10px;">No</th>
              <th style="padding: 10px;">Nama</th>
              <th style="padding: 10px;">Hari/Tanggal</th>
              <th style="padding: 10px;">In</th>
              <th style="padding: 10px;">Foto</th>
              <th style="padding: 10px;">Out</th>
              <th style="padding: 10px;">Foto</th>
              <th style="padding: 10px;">Durasi</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    `

    await db.collection("mail").add({
      to: [emailrep],
      message: {
        subject: `Laporan Kehadiran - ${namaPerusahaanDisplay}`,
        html: htmlContent,
      },
      createdAt: new Date(),
    })

    return res.status(200).send("Report has been emailed")
  } catch (e) {
    console.error("Statistik Kehadiran error:", e)
    return res.status(500).json({ message: "Error", error: e.message })
  }
})

// ---------------------------------------------------------
// 4. GET /export/laporan - DOWNLOAD Excel Perizinan (Stream)
// ---------------------------------------------------------
router.get("/export/laporan", async (req, res) => {
  try {
    const { idperusahaan, tglstart, tglend } = req.query

    if (!idperusahaan || !tglstart || !tglend) {
      return res.status(400).send("Parameter tidak lengkap")
    }

    const startDate = new Date(tglstart)
    const endDate = new Date(tglend)

    const snapshot = await db
      .collection("companies")
      .doc(idperusahaan)
      .collection("leaves")
      .where("startDate", ">=", startDate)
      .where("startDate", "<=", endDate)
      .get()

    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet("Laporan Perizinan")

    worksheet.columns = [
      { header: "No", key: "no", width: 5 },
      { header: "Nama Karyawan", key: "userName", width: 25 },
      { header: "Tipe Izin", key: "tipe", width: 15 },
      { header: "Tanggal Mulai", key: "start", width: 20 },
      { header: "Tanggal Selesai", key: "end", width: 20 },
      { header: "Keterangan", key: "keterangan", width: 30 },
      { header: "Status", key: "status", width: 15 },
      { header: "Link Lampiran", key: "link", width: 40 },
    ]
    worksheet.getRow(1).font = { bold: true }

    let index = 1
    snapshot.forEach((doc) => {
      const data = doc.data()
      const row = worksheet.addRow({
        no: index++,
        userName: data.userName || data.userId || "-",
        tipe: data.tipeIzin || "-",
        start: formatDateIndo(data.startDate),
        end: formatDateIndo(data.endDate),
        keterangan: data.keterangan || "-",
        status: data.status || "Pending",
        link: data.attachmentUrl ? "Klik Disini" : "-",
      })
      if (data.attachmentUrl) {
        row.getCell("link").value = { text: "Buka Lampiran", hyperlink: data.attachmentUrl }
        row.getCell("link").font = { color: { argb: "FF0000FF" }, underline: true }
      }
    })

    // STREAM DOWNLOAD LANGSUNG
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    res.setHeader("Content-Disposition", `attachment; filename=Laporan_Perizinan_${idperusahaan}.xlsx`)

    await workbook.xlsx.write(res)
    res.end()

  } catch (e) {
    console.error("Export Laporan error:", e)
    res.status(500).send("Gagal download excel")
  }
})

// ---------------------------------------------------------
// 5. GET /export/kehadiran - DOWNLOAD Excel Kehadiran (Stream)
// ---------------------------------------------------------
router.get("/export/kehadiran", async (req, res) => {
  try {
    const { idperusahaan, tglstart, tglend } = req.query

    if (!idperusahaan || !tglstart || !tglend) {
      return res.status(400).send("Parameter tidak lengkap")
    }

    const startDate = new Date(tglstart)
    const endDate = new Date(tglend)

    const snapshot = await db
      .collection("absensi")
      .where("idPerusahaan", "==", idperusahaan)
      .where("tanggal", ">=", startDate)
      .where("tanggal", "<=", endDate)
      .orderBy("tanggal", "desc")
      .get()

    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet("Laporan Kehadiran")

    worksheet.columns = [
      { header: "No", key: "no", width: 5 },
      { header: "Nama Karyawan", key: "nama", width: 25 },
      { header: "Hari/Tanggal", key: "tanggal", width: 25 },
      { header: "Jam Masuk", key: "in", width: 15 },
      { header: "Foto Masuk", key: "fotoIn", width: 15 },
      { header: "Jam Pulang", key: "out", width: 15 },
      { header: "Foto Pulang", key: "fotoOut", width: 15 },
      { header: "Durasi (JJ:MM:DD)", key: "durasi", width: 20 },
    ]
    worksheet.getRow(1).font = { bold: true }

    let index = 1
    snapshot.forEach((doc) => {
      const data = doc.data()
      const row = worksheet.addRow({
        no: index++,
        nama: data.namaKaryawan || "-",
        tanggal: formatDateIndo(data.tanggal),
        in: formatTime(data.waktuCheckIn),
        fotoIn: data.fotoCheckIn ? "Link" : "-",
        out: formatTime(data.waktuCheckOut),
        fotoOut: data.fotoCheckOut ? "Link" : "-",
        durasi: calculateDuration(data.waktuCheckIn, data.waktuCheckOut),
      })
      if (data.fotoCheckIn) {
        row.getCell("fotoIn").value = { text: "Lihat", hyperlink: data.fotoCheckIn }
        row.getCell("fotoIn").font = { color: { argb: "FF0000FF" }, underline: true }
      }
      if (data.fotoCheckOut) {
        row.getCell("fotoOut").value = { text: "Lihat", hyperlink: data.fotoCheckOut }
        row.getCell("fotoOut").font = { color: { argb: "FF0000FF" }, underline: true }
      }
    })

    // STREAM DOWNLOAD LANGSUNG
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    res.setHeader("Content-Disposition", `attachment; filename=Laporan_Kehadiran_${idperusahaan}.xlsx`)

    await workbook.xlsx.write(res)
    res.end()

  } catch (e) {
    console.error("Export Kehadiran error:", e)
    res.status(500).send("Gagal download excel")
  }
})

module.exports = router