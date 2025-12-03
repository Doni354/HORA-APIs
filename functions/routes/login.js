/* eslint-disable */
const express = require("express")
const jwt = require("jsonwebtoken")
const Busboy = require("busboy")
const path = require("path")
const { Timestamp } = require("firebase-admin/firestore")

const { db, bucket } = require("../config/firebase")

const router = express.Router()

const JWT_SECRET = "SECRET_TEMP"
const OTP_EXPIRE = 300 // 5 minutes

// ---------------------------------------------------------
// Utility
// ---------------------------------------------------------
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

// ---------------------------------------------------------
// SEND OTP
// ---------------------------------------------------------
router.put("/sendlink", async (req, res) => {
  try {
    const email = req.query.email
    if (!email) return res.status(400).send("Email required")

    const userRef = db.collection("users").doc(email)
    const userDoc = await userRef.get()

    if (!userDoc.exists || !userDoc.data().invited) {
      return res.status(404).send("Belum Ada Invite")
    }

    const now = Date.now()
    const prevExpire = userDoc.data().otpExpires?.toMillis?.() || 0
    if (prevExpire > now) return res.status(400).send("Mohon tunggu timer selesai")

    const otp = generateOTP()
    const otpExpires = Timestamp.fromMillis(now + OTP_EXPIRE * 1000)

    await userRef.update({ otp, otpExpires })
    console.log(`OTP for ${email}: ${otp}`)

    await db.collection("mail").add({
      to: email,
      message: {
        subject: "Kode OTP Masuk Akun Anda",
        html: `
          <p>Halo,</p>
          <p>Berikut adalah kode OTP Anda:</p>
          <h2 style="font-size: 32px; letter-spacing: 4px;">${otp}</h2>
          <p>Kode ini berlaku selama <b>${OTP_EXPIRE / 60} menit</b>.</p>
          <p>Jika Anda tidak meminta kode ini, abaikan saja.</p>
        `,
      },
    })

    return res.status(200).send("OTP Terkirim ke Email")
  } catch (e) {
    console.error(e)
    return res.status(500).send("Server Error")
  }
})

// ---------------------------------------------------------
// VERIFY OTP
// ---------------------------------------------------------
router.get("/verifyOTP", async (req, res) => {
  try {
    const email = req.query.email
    const otp = req.query.otp

    if (!email || !otp) return res.status(400).send("Email & OTP required")

    const userRef = db.collection("users").doc(email)
    const userDoc = await userRef.get()

    if (!userDoc.exists) return res.status(404).send("User tidak ditemukan")

    const data = userDoc.data()
    if (data.otp !== otp) return res.status(400).send("OTP salah")
    if (data.otpExpires.toMillis() < Date.now()) return res.status(400).send("OTP expired")

    const token = jwt.sign({ id: email }, JWT_SECRET, { expiresIn: "30d" })

    return res.status(200).json({ message: "OTP benar", token })
  } catch (e) {
    console.error(e)
    return res.status(500).send("Server Error")
  }
})

// ---------------------------------------------------------
// VERIFY ACCOUNT [internal]
// ---------------------------------------------------------
router.get("/verifyaccount", async (req, res) => {
  try {
    const horauser = req.query.horauser
    if (!horauser) return res.status(400).json({ message: "'horauser' wajib diisi" })

    return res.status(200).json({ message: "Akun terverifikasi" })
  } catch (e) {
    console.error(e)
    return res.status(500).json({ message: "Server error" })
  }
})

// ---------------------------------------------------------
// PILIH PAKET
// ---------------------------------------------------------
router.post("/pilihpaket", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || ""
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ message: "Token tidak valid" })

    const data = req.body
    if (!data.idperusahaan) return res.status(400).json({ message: "idperusahaan wajib diisi" })

    await db.collection("packages").doc(data.idperusahaan).set(data, { merge: true })

    return res.status(200).json("Upload Bukti Bayar")
  } catch (e) {
    console.error(e)
    return res.status(500).json({ message: "Gagal menyimpan paket", error: e.message })
  }
})

// ---------------------------------------------------------
// UPLOAD BUKTI BAYAR
// ---------------------------------------------------------
router.put("/uploadbukti", (req, res) => {
  const busboy = Busboy({ headers: req.headers })

  const fields = {}
  let fileBuffer = null
  let fileMime = null
  let fileName = null

  busboy.on("field", (fieldname, val) => {
    fields[fieldname] = val
  })

  busboy.on("file", (fieldname, file, info) => {
    const { mimeType, filename } = info
    fileMime = mimeType
    fileName = filename
    const chunks = []

    file.on("data", (data) => chunks.push(data))
    file.on("end", () => {
      fileBuffer = Buffer.concat(chunks)
    })
  })

  busboy.on("error", (err) => {
    console.error("Busboy Error:", err)
    return res.status(500).json({ message: "Gagal mengurai form data", error: err.message })
  })

  busboy.on("finish", async () => {
    try {
      const NamaPerusahaan = fields.NamaPerusahaan
      const IDPerusahaan = fields.IDPerusahaan

      if (!NamaPerusahaan) return res.status(400).json({ message: "NamaPerusahaan wajib diisi" })
      if (!IDPerusahaan) return res.status(400).json({ message: "IDPerusahaan wajib diisi" })
      if (!fileBuffer) return res.status(400).json({ message: "Foto wajib diupload" })
      if (!fileMime.startsWith("image/")) return res.status(400).json({ message: "Harus file gambar" })

      const timestamp = Date.now()
      const ext = path.extname(fileName || "").toLowerCase() || `.${fileMime.split("/")[1]}`
      const filePath = `bukti-bayar/${IDPerusahaan}_${timestamp}${ext}`

      const fileStorage = bucket.file(filePath)
      await fileStorage.save(fileBuffer, {
        metadata: { contentType: fileMime },
        public: true,
      })
      const url = fileStorage.publicUrl()

      await db.collection("bukti_bayar").doc(IDPerusahaan).set(
        {
          idPerusahaan: IDPerusahaan,
          namaPerusahaan: NamaPerusahaan,
          fotoURL: url,
          filename: filePath,
          uploadedAt: Timestamp.now(),
          status: "pending",
        },
        { merge: true },
      )

      return res.status(200).json({
        message: "Bukti bayar berhasil diupload",
        fotoURL: url,
      })
    } catch (err) {
      console.error("Upload process error:", err)
      return res.status(500).json({ message: "Gagal upload", error: err.message })
    }
  })

  busboy.end(req.rawBody)
})

// ---------------------------------------------------------
// REGISTRASI (Company Registration)
// ---------------------------------------------------------
router.post("/registrasi", async (req, res) => {
  try {
    const data = req.body

    const requiredFields = ["namaPerusahaan", "alamatEmail", "noTelp", "noWA", "alamatLoc"]
    const missingFields = requiredFields.filter((field) => !data[field])

    if (missingFields.length > 0) {
      return res.status(400).json({
        message: `Field wajib diisi: ${missingFields.join(", ")}`,
      })
    }

    const existingUser = await db.collection("users").doc(data.alamatEmail).get()
    if (existingUser.exists) {
      return res.status(400).json({ message: "Email sudah terdaftar" })
    }

    const userData = {
      ...data,
      createdAt: Timestamp.now(),
      invited: true,
      verified: false,
      status: "pending",
      totalLike: data.totalLike || 0,
    }

    await db.collection("users").doc(data.alamatEmail).set(userData)

    return res.status(200).json("Mohon utk Login & verify email anda")
  } catch (e) {
    console.error("Registrasi error:", e)
    return res.status(500).json({
      message: "Gagal melakukan registrasi",
      error: e.message,
    })
  }
})

// ---------------------------------------------------------
// GET PAKET (List All Available Packages)
// ---------------------------------------------------------
router.get("/getpaket", async (req, res) => {
  try {
    const packagesSnapshot = await db.collection("packages").get()

    if (packagesSnapshot.empty) {
      return res.status(200).json([])
    }

    const packages = packagesSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))

    return res.status(200).json(packages)
  } catch (e) {
    console.error("Get paket error:", e)
    return res.status(500).json({
      message: "Gagal mengambil data paket",
      error: e.message,
    })
  }
})

module.exports = router
