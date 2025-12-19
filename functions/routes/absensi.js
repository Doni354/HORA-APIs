/* eslint-disable */
const express = require("express")
const Busboy = require("busboy")
const path = require("path")
const { Timestamp } = require("firebase-admin/firestore")

const { db, bucket } = require("../config/firebase")

const router = express.Router()

// ---------------------------------------------------------
// GET /absensi/HomeA - View Absensi Data
// ---------------------------------------------------------
router.get("/HomeA", async (req, res) => {
  try {
    const idPerusahaan = req.query.IDPerusahaan || req.query.idperusahaan
    const tglstart = req.query.tglstart
    const tglend = req.query.tglend

    if (!idPerusahaan) {
      return res.status(400).json({ message: "IDPerusahaan wajib diisi" })
    }

    if (!tglstart || !tglend) {
      return res.status(400).json({ message: "tglstart dan tglend wajib diisi (format UTC)" })
    }

    const startDate = new Date(tglstart)
    const endDate = new Date(tglend)

    // Query absensi records within the date range
    const snapshot = await db
      .collection("absensi")
      .where("idPerusahaan", "==", idPerusahaan)
      .where("tanggal", ">=", startDate)
      .where("tanggal", "<=", endDate)
      .get()

    if (snapshot.empty) {
      return res.status(200).json([])
    }

    const absensiData = snapshot.docs.map((doc) => {
      const data = doc.data()
      return {
        id: doc.id,
        IDKaryawan: data.idKaryawan,
        NamaKaryawan: data.namaKaryawan,
        tanggal: data.tanggal,
        waktuCheckIn: data.waktuCheckIn,
        waktuCheckOut: data.waktuCheckOut || null,
        bluetoothID: data.bluetoothID || null,
        AlamatLongtitude: data.alamatLongtitude,
        AlamatLatitude: data.alamatLatitude,
        AlamatLoc: data.alamatLoc,
        telat: data.telat || null,
        Foto: data.fotoCheckIn || null,
        IDPerusahaan: data.idPerusahaan,
        NamaPerusahaan: data.namaPerusahaan,
        FotoCheckOut: data.fotoCheckOut || null,
        LatitudeCheckOut: data.latitudeCheckOut || null,
        LongtitudeCheckOut: data.longtitudeCheckOut || null,
        durasi: data.durasi || null,
        AlamatLocCheckOut: data.alamatLocCheckOut || null,
      }
    })

    return res.status(200).json(absensiData)
  } catch (e) {
    console.error("Get Absensi error:", e)
    return res.status(500).json({
      message: "Gagal mengambil data absensi",
      error: e.message,
    })
  }
})

// ---------------------------------------------------------
// GET /absensi/indie - Individual View Absensi
// ---------------------------------------------------------
router.get("/indie", async (req, res) => {
  try {
    const idkaryawan = req.query.idkaryawan
    const tglstart = req.query.tglstart
    const tglend = req.query.tglend

    if (!idkaryawan) {
      return res.status(400).json({ message: "idkaryawan wajib diisi" })
    }

    if (!tglstart || !tglend) {
      return res.status(400).json({ message: "tglstart dan tglend wajib diisi (format YYYY-MM-DD)" })
    }

    const startDate = new Date(tglstart)
    const endDate = new Date(tglend)
    // Set endDate to end of the day to ensure full coverage if needed, 
    // or keep strictly as provided if time component is included in input.
    // Assuming standard date string "YYYY-MM-DD" which defaults to 00:00:00.
    // Ideally, endDate should probably cover the full day.
    // endDate.setHours(23, 59, 59, 999); 

    // Query absensi records for specific employee
    const snapshot = await db
      .collection("absensi")
      .where("idKaryawan", "==", idkaryawan)
      .where("tanggal", ">=", startDate)
      .where("tanggal", "<=", endDate)
      .get()

    if (snapshot.empty) {
      return res.status(200).json([])
    }

    const absensiData = snapshot.docs.map((doc) => {
      const data = doc.data()
      // Mapping response to match the requested format
      return {
        idKaryawan: data.idKaryawan,
        namaKaryawan: data.namaKaryawan,
        tanggal: data.tanggal, // Firestore Timestamp or Date
        waktuCheckIn: data.waktuCheckIn,
        waktuCheckOut: data.waktuCheckOut || null,
        bluetoothID: data.bluetoothID || null,
        alamatLongtitude: data.alamatLongtitude,
        alamatLatitude: data.alamatLatitude,
        alamatLoc: data.alamatLoc,
        telat: data.telat || null,
        id: doc.id,
        foto: null, // Placeholder based on example request
        fotoKaryawan: data.fotoCheckIn || null, // Mapping CheckIn photo to fotoKaryawan
        idPerusahaan: data.idPerusahaan,
        namaperusahaan: data.namaPerusahaan,
        tanggalAbsensi: data.tanggal,
        fotoPulang: data.fotoCheckOut || null,
        latitudePulang: data.latitudeCheckOut || null,
        longtitudePulang: data.longtitudeCheckOut || null,
        durasi: data.durasi || null,
        alamatPulang: data.alamatLocCheckOut || null
      }
    })

    return res.status(200).json(absensiData)
  } catch (e) {
    console.error("Get Individual Absensi error:", e)
    return res.status(500).json({
      message: "Gagal mengambil data absensi individu",
      error: e.message,
    })
  }
})

// ---------------------------------------------------------
// POST /absensi - Check In Absensi
// ---------------------------------------------------------
router.post("/", (req, res) => {
  const busboy = Busboy({ headers: req.headers })

  const fields = {}
  let fileBuffer = null
  let fileMime = null
  let fileName = null

  busboy.on("field", (fieldname, val) => {
    fields[fieldname] = val
  })

  busboy.on("file", (fieldname, file, info) => {
    if (fieldname === "Foto") {
      const { mimeType, filename } = info
      fileMime = mimeType
      fileName = filename
      const chunks = []

      file.on("data", (data) => chunks.push(data))
      file.on("end", () => {
        fileBuffer = Buffer.concat(chunks)
      })
    } else {
      file.resume()
    }
  })

  busboy.on("error", (err) => {
    console.error("Busboy Error:", err)
    return res.status(500).json({ message: "Gagal mengurai form data", error: err.message })
  })

  busboy.on("finish", async () => {
    try {
      const idKaryawan = fields.IDKaryawan
      const namaKaryawan = fields.NamaKaryawan
      const alamatLongtitude = fields.AlamatLongtitude
      const alamatLatitude = fields.AlamatLatitude
      const alamatLoc = fields.AlamatLoc || ""
      const idPerusahaan = fields.IDPerusahaan
      const namaPerusahaan = fields.NamaPerusahaan
      const zone = fields.zone || "Asia/Jakarta"

      // Validasi required fields
      if (!idKaryawan) return res.status(400).json({ message: "IDKaryawan wajib diisi" })
      if (!namaKaryawan) return res.status(400).json({ message: "NamaKaryawan wajib diisi" })
      if (!alamatLongtitude) return res.status(400).json({ message: "AlamatLongtitude wajib diisi" })
      if (!alamatLatitude) return res.status(400).json({ message: "AlamatLatitude wajib diisi" })
      if (!idPerusahaan) return res.status(400).json({ message: "IDPerusahaan wajib diisi" })
      if (!namaPerusahaan) return res.status(400).json({ message: "NamaPerusahaan wajib diisi" })
      if (!fileBuffer) return res.status(400).json({ message: "Photo is empty" })

      // Check if already checked in today
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const tomorrow = new Date(today)
      tomorrow.setDate(tomorrow.getDate() + 1)

      const existingCheckIn = await db
        .collection("absensi")
        .where("idKaryawan", "==", idKaryawan)
        .where("idPerusahaan", "==", idPerusahaan)
        .where("tanggal", ">=", today)
        .where("tanggal", "<", tomorrow)
        .limit(1)
        .get()

      if (!existingCheckIn.empty) {
        return res.status(400).json({ message: "Sudah check in hari ini" })
      }

      // Upload photo
      const timestamp = Date.now()
      const ext = path.extname(fileName || "").toLowerCase() || ".jpg"
      const photoPath = `absensi/checkin/${idPerusahaan}/${idKaryawan}_${timestamp}${ext}`

      const photoStorage = bucket.file(photoPath)
      await photoStorage.save(fileBuffer, {
        metadata: { contentType: fileMime || "image/jpeg" },
        public: true,
      })
      const photoURL = photoStorage.publicUrl()

      // Save to Firestore
      const absensiData = {
        idKaryawan,
        namaKaryawan,
        alamatLongtitude,
        alamatLatitude,
        alamatLoc,
        idPerusahaan,
        namaPerusahaan,
        tanggal: Timestamp.now(),
        waktuCheckIn: Timestamp.now(),
        waktuCheckOut: null,
        fotoCheckIn: photoURL,
        fotoCheckOut: null,
        latitudeCheckOut: null,
        longtitudeCheckOut: null,
        durasi: null,
        alamatLocCheckOut: null,
        zone,
        status: "checked-in",
        createdAt: Timestamp.now(),
      }

      const docRef = await db.collection("absensi").add(absensiData)

      return res.status(200).json({
        message: "Absensi Created!",
        id: docRef.id,
        fotoURL: photoURL,
      })
    } catch (err) {
      console.error("Check in error:", err)
      return res.status(500).json({ message: "Gagal menyimpan absensi", error: err.message })
    }
  })

  busboy.end(req.rawBody)
})

// ---------------------------------------------------------
// PUT /absensi/pulang - Check Out Absensi
// ---------------------------------------------------------
router.put("/pulang", (req, res) => {
  const authHeader = req.headers.authorization || ""

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" })
  }

  const busboy = Busboy({ headers: req.headers })

  const fields = {}
  let fileBuffer = null
  let fileMime = null
  let fileName = null

  busboy.on("field", (fieldname, val) => {
    fields[fieldname] = val
  })

  busboy.on("file", (fieldname, file, info) => {
    if (fieldname === "Foto") {
      const { mimeType, filename } = info
      fileMime = mimeType
      fileName = filename
      const chunks = []

      file.on("data", (data) => chunks.push(data))
      file.on("end", () => {
        fileBuffer = Buffer.concat(chunks)
      })
    } else {
      file.resume()
    }
  })

  busboy.on("error", (err) => {
    console.error("Busboy Error:", err)
    return res.status(500).json({ message: "Gagal mengurai form data", error: err.message })
  })

  busboy.on("finish", async () => {
    try {
      const tanggal = req.query.tanggal
      const id = req.query.id
      const latitudePulang = fields.LatitudePulang
      const longtitudePulang = fields.LongtitudePulang
      const alamatPulang = fields.AlamatPulang
      const namaKaryawan = fields.NamaKaryawan
      const zone = fields.zone || "Asia/Jakarta"

      // Validasi required fields
      if (!tanggal) return res.status(400).json({ message: "tanggal wajib diisi" })
      if (!id) return res.status(400).json({ message: "id wajib diisi" })
      if (!latitudePulang) return res.status(400).json({ message: "LatitudePulang wajib diisi" })
      if (!longtitudePulang) return res.status(400).json({ message: "LongtitudePulang wajib diisi" })
      if (!alamatPulang) return res.status(400).json({ message: "AlamatPulang wajib diisi" })
      if (!fileBuffer) return res.status(400).json({ message: "Photo is empty" })

      // Get existing absensi record
      const docRef = db.collection("absensi").doc(id)
      const docSnap = await docRef.get()

      if (!docSnap.exists) {
        return res.status(404).json({ message: "Absensi record not found" })
      }

      // Upload checkout photo
      const timestamp = Date.now()
      const ext = path.extname(fileName || "").toLowerCase() || ".jpg"
      const photoPath = `absensi/checkout/${docSnap.data().idPerusahaan}/${docSnap.data().idKaryawan}_${timestamp}${ext}`

      const photoStorage = bucket.file(photoPath)
      await photoStorage.save(fileBuffer, {
        metadata: { contentType: fileMime || "image/jpeg" },
        public: true,
      })
      const photoURL = photoStorage.publicUrl()

      // Calculate duration from check-in to check-out
      const checkInTime = docSnap.data().waktuCheckIn.toDate()
      const checkOutTime = new Date()
      const durationMs = checkOutTime - checkInTime
      const durationHours = (durationMs / (1000 * 60 * 60)).toFixed(2)

      // Update absensi record
      await docRef.update({
        waktuCheckOut: Timestamp.now(),
        fotoCheckOut: photoURL,
        latitudeCheckOut: latitudePulang,
        longtitudeCheckOut: longtitudePulang,
        alamatLocCheckOut: alamatPulang,
        durasi: durationHours,
        status: "checked-out",
        updatedAt: Timestamp.now(),
      })

      return res.status(200).send("updated")
    } catch (err) {
      console.error("Check out error:", err)
      return res.status(500).json({ message: "Gagal mengupdate absensi", error: err.message })
    }
  })

  busboy.end(req.rawBody)
})

module.exports = router