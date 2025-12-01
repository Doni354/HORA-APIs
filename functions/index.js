/* eslint-disable */
const { onRequest } = require("firebase-functions/v2/https")
const { setGlobalOptions } = require("firebase-functions/v2/options")
const admin = require("firebase-admin")
const express = require("express")
const cors = require("cors")
const jwt = require("jsonwebtoken")
const fs = require("fs")
const { Timestamp } = require("firebase-admin/firestore")

// ---------------------------------------------------------
// Firebase Admin
// ---------------------------------------------------------
admin.initializeApp({
  storageBucket: "hora-7394b.firebasestorage.app",
})
const db = admin.firestore()
const bucket = admin.storage().bucket()

// ---------------------------------------------------------
// Cloud Functions Global Config
// ---------------------------------------------------------
setGlobalOptions({
  region: "asia-southeast2",
  memory: "256MiB",
  timeoutSeconds: 30,
})

// ---------------------------------------------------------
// ENV / Config
// ---------------------------------------------------------
const JWT_SECRET = "SECRET_TEMP"
const OTP_EXPIRE = 60

// ---------------------------------------------------------
// Utility
// ---------------------------------------------------------
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

// ---------------------------------------------------------
// Express App
// ---------------------------------------------------------
const app = express()
app.use(cors({ origin: true }))
app.use(express.json()) // removed conditional middleware, formidable handles raw body

// ---------------------------------------------------------
// TEST
// ---------------------------------------------------------
app.get("/test", (req, res) => {
  console.log("[v0] Test endpoint called - method:", req.method, "origin:", req.headers.origin)
  res
    .status(200)
    .header("Access-Control-Allow-Origin", "*")
    .header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    .header("Access-Control-Allow-Headers", "Content-Type, Authorization")
    .send("Function is working!")
})

app.options("*", cors())

// ---------------------------------------------------------
// SEND OTP
// ---------------------------------------------------------
app.put("/Login/sendlink", async (req, res) => {
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

    return res.status(200).send("OTP Terkirim")
  } catch (e) {
    console.error(e)
    return res.status(500).send("Server Error")
  }
})

// ---------------------------------------------------------
// VERIFY OTP
// ---------------------------------------------------------
app.get("/Login/verifyOTP", async (req, res) => {
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
app.get("/Login/verifyaccount", async (req, res) => {
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
app.post("/Login/pilihpaket", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || ""
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ message: "Token tidak valid" })

    const token = authHeader.split(" ")[1]

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
app.put("/Login/uploadbukti", async (req, res) => {
  try {
    // Get metadata from query params
    const idPerusahaan = req.query.idperusahaan
    const namaPerusahaan = req.query.namaPerusahaan

    // Validasi required params
    if (!idPerusahaan) {
      return res.status(400).json({ message: "idperusahaan wajib diisi" })
    }
    if (!namaPerusahaan) {
      return res.status(400).json({ message: "namaPerusahaan wajib diisi" })
    }

    // Get file from raw body
    const fileBuffer = req.body

    // Validate file exists and size
    if (!fileBuffer || fileBuffer.length === 0) {
      return res.status(400).json({ message: "File wajib diupload" })
    }

    // Get content type from header
    const contentType = req.headers["content-type"] || "image/jpeg"

    // Validate is image
    if (!contentType.startsWith("image/")) {
      return res.status(400).json({ message: "Hanya file gambar yang diperbolehkan" })
    }

    // Generate unique filename
    const timestamp = Date.now()
    const fileExtension = contentType.split("/")[1] || "jpg"
    const filename = `bukti-bayar/${idPerusahaan}_${timestamp}.${fileExtension}`

    // Upload to Firebase Storage
    const firebaseFile = bucket.file(filename)
    await firebaseFile.save(fileBuffer, {
      metadata: {
        contentType: contentType,
      },
    })

    // Generate download URL
    const downloadURL = `https://storage.googleapis.com/${bucket.name}/${filename}`

    // Simpan ke Firestore
    await db.collection("bukti_bayar").doc(idPerusahaan).set(
      {
        idPerusahaan,
        namaPerusahaan,
        fotoURL: downloadURL,
        filename,
        uploadedAt: Timestamp.now(),
        status: "pending",
      },
      { merge: true },
    )

    return res.status(200).json({
      message: "Bukti bayar berhasil diupload",
      data: {
        idPerusahaan,
        namaPerusahaan,
        fotoURL: downloadURL,
      },
    })
  } catch (e) {
    console.error("Upload bukti bayar error:", e)
    return res.status(500).json({
      message: "Gagal mengupload bukti bayar",
      error: e.message,
    })
  }
})

// ---------------------------------------------------------
// REGISTRASI (Company Registration)
// ---------------------------------------------------------
app.post("/Login/registrasi", async (req, res) => {
  try {
    const data = req.body

    // Validasi required fields
    const requiredFields = ["namaPerusahaan", "alamatEmail", "noTelp", "noWA", "alamatLoc"]
    const missingFields = requiredFields.filter((field) => !data[field])

    if (missingFields.length > 0) {
      return res.status(400).json({
        message: `Field wajib diisi: ${missingFields.join(", ")}`,
      })
    }

    // Check if email already exists in users collection
    const existingUser = await db.collection("users").doc(data.alamatEmail).get()
    if (existingUser.exists) {
      return res.status(400).json({ message: "Email sudah terdaftar" })
    }

    // Create new user document with registration data
    const userData = {
      ...data,
      createdAt: Timestamp.now(),
      invited: true,
      verified: false,
      status: "pending",
      totalLike: data.totalLike || 0,
    }

    // Save to Firestore
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
app.get("/Login/getpaket", async (req, res) => {
  try {
    // Fetch all documents from packages collection
    const packagesSnapshot = await db.collection("packages").get()

    if (packagesSnapshot.empty) {
      return res.status(200).json([])
    }

    // Map documents to array with id included
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

// ---------------------------------------------------------
// EXPORT SINGLE FUNCTION (Gen2)
// ---------------------------------------------------------
exports.api = onRequest(app)
