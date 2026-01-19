/* eslint-disable */
const express = require("express")
const { Timestamp } = require("firebase-admin/firestore")
const { db } = require("../config/firebase")

const router = express.Router()

// ---------------------------------------------------------
// HELPER: Get File URL by ID
// ---------------------------------------------------------
const getFileUrlById = async (idPerusahaan, idBerkas) => {
  if (!idPerusahaan || !idBerkas) return null;

  try {
    const fileDoc = await db
      .collection("companies")
      .doc(idPerusahaan)
      .collection("files")
      .doc(idBerkas)
      .get();

    if (!fileDoc.exists) return null;
    return fileDoc.data().downloadUrl;
  } catch (error) {
    console.error("Error fetching file:", error);
    return null;
  }
};

// ---------------------------------------------------------
// GET /absensi/HomeA - View Absensi Data (Per Company)
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

    // PERUBAHAN: Query ke Sub-Collection companies/{id}/absensi
    const snapshot = await db
      .collection("companies")
      .doc(idPerusahaan)
      .collection("absensi")
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
        AlamatLongtitude: data.alamatLongtitude,
        AlamatLatitude: data.alamatLatitude,
        AlamatLoc: data.alamatLoc,
        telat: data.telat || null,
        Foto: data.fotoCheckIn || null,
        IDPerusahaan: data.idPerusahaan, // Tetap disimpan di doc utk referensi
        NamaPerusahaan: data.namaPerusahaan,
        FotoCheckOut: data.fotoCheckOut || null,
        LatitudeCheckOut: data.latitudeCheckOut || null,
        LongtitudeCheckOut: data.longtitudeCheckOut || null,
        durasi: data.durasi || null,
        AlamatLocCheckOut: data.alamatLocCheckOut || null,
        shift: data.shift
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
    // PERUBAHAN: Wajib ada idPerusahaan karena skrg sub-collection
    const idPerusahaan = req.query.idPerusahaan || req.query.idperusahaan 
    const tglstart = req.query.tglstart
    const tglend = req.query.tglend

    if (!idkaryawan) {
      return res.status(400).json({ message: "idkaryawan wajib diisi" })
    }
    if (!idPerusahaan) {
      return res.status(400).json({ message: "idPerusahaan wajib diisi untuk mencari data" })
    }

    if (!tglstart || !tglend) {
      return res.status(400).json({ message: "tglstart dan tglend wajib diisi (format YYYY-MM-DD)" })
    }

    const startDate = new Date(tglstart)
    const endDate = new Date(tglend)

    // PERUBAHAN: Query ke Sub-Collection
    const snapshot = await db
      .collection("companies")
      .doc(idPerusahaan)
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
      return {
        idKaryawan: data.idKaryawan,
        namaKaryawan: data.namaKaryawan,
        tanggal: data.tanggal,
        waktuCheckIn: data.waktuCheckIn,
        waktuCheckOut: data.waktuCheckOut || null,
        alamatLongtitude: data.alamatLongtitude,
        alamatLatitude: data.alamatLatitude,
        alamatLoc: data.alamatLoc,
        telat: data.telat || null,
        id: doc.id,
        foto: null,
        fotoKaryawan: data.fotoCheckIn || null,
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
// POST /absensi - Check In Absensi (Sub-Collection)
// ---------------------------------------------------------
router.post("/", async (req, res) => {
  try {
    const {
      IDKaryawan,
      NamaKaryawan,
      AlamatLongtitude,
      AlamatLatitude,
      AlamatLoc,
      IDPerusahaan,
      NamaPerusahaan,
      zone = "Asia/Jakarta",
      idBerkasFoto 
    } = req.body;

    // 1. Validasi Input
    if (!IDKaryawan) return res.status(400).json({ message: "IDKaryawan wajib diisi" });
    if (!NamaKaryawan) return res.status(400).json({ message: "NamaKaryawan wajib diisi" });
    if (!AlamatLongtitude) return res.status(400).json({ message: "AlamatLongtitude wajib diisi" });
    if (!AlamatLatitude) return res.status(400).json({ message: "AlamatLatitude wajib diisi" });
    if (!IDPerusahaan) return res.status(400).json({ message: "IDPerusahaan wajib diisi" });
    if (!NamaPerusahaan) return res.status(400).json({ message: "NamaPerusahaan wajib diisi" });
    if (!idBerkasFoto) return res.status(400).json({ message: "idBerkasFoto wajib diisi (Upload foto terlebih dahulu)" });

    // 2. Ambil URL Foto
    const photoURL = await getFileUrlById(IDPerusahaan, idBerkasFoto);
    if (!photoURL) {
      return res.status(404).json({ message: "File foto tidak ditemukan di database perusahaan." });
    }

    // 3. Logic Shift
    const now = new Date();
    const currentHour = parseInt(
      now.toLocaleString("en-US", {
        timeZone: "Asia/Jakarta",
        hour: "numeric",
        hour12: false,
      })
    );

    let detectedShift = "";
    if (currentHour >= 7 && currentHour < 15) {
      detectedShift = "Pagi";
    } else if (currentHour >= 15 && currentHour < 23) {
      detectedShift = "Siang";
    } else {
      detectedShift = "Malam";
    }

    // 4. Cek Double Check-in (Sub-Collection)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // PERUBAHAN: Cek di Sub-Collection
    const existingCheckIn = await db
      .collection("companies")
      .doc(IDPerusahaan)
      .collection("absensi")
      .where("idKaryawan", "==", IDKaryawan)
      .where("tanggal", ">=", today)
      .where("tanggal", "<", tomorrow)
      .limit(1)
      .get();

    if (!existingCheckIn.empty) {
      return res.status(400).json({ message: "Sudah check in hari ini" });
    }

    // 5. Save to Firestore (Sub-Collection)
    const absensiData = {
      idKaryawan: IDKaryawan,
      namaKaryawan: NamaKaryawan,
      alamatLongtitude: AlamatLongtitude,
      alamatLatitude: AlamatLatitude,
      alamatLoc: AlamatLoc || "",
      idPerusahaan: IDPerusahaan,
      namaPerusahaan: NamaPerusahaan,
      shift: detectedShift,
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
    };

    // PERUBAHAN: Simpan ke Sub-Collection
    const docRef = await db
      .collection("companies")
      .doc(IDPerusahaan)
      .collection("absensi")
      .add(absensiData);

    return res.status(200).json({
      message: `Absensi Berhasil (Shift ${detectedShift})`,
      id: docRef.id,
      fotoURL: photoURL,
      shift: detectedShift
    });

  } catch (err) {
    console.error("Check in error:", err);
    return res.status(500).json({ message: "Gagal menyimpan absensi", error: err.message });
  }
});

// ---------------------------------------------------------
// PUT /absensi/pulang - Check Out Absensi (Sub-Collection)
// ---------------------------------------------------------
router.put("/pulang", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const id = req.query.id; // ID Dokumen Absensi
    
    const {
      LatitudePulang,
      LongtitudePulang,
      AlamatPulang,
      NamaKaryawan, 
      zone = "Asia/Jakarta",
      idBerkasFoto,
      IDPerusahaan // <--- PERUBAHAN: Wajib kirim ID Perusahaan di Body
    } = req.body;

    // Validasi
    if (!id) return res.status(400).json({ message: "Query id wajib diisi" });
    if (!LatitudePulang) return res.status(400).json({ message: "LatitudePulang wajib diisi" });
    if (!LongtitudePulang) return res.status(400).json({ message: "LongtitudePulang wajib diisi" });
    if (!AlamatPulang) return res.status(400).json({ message: "AlamatPulang wajib diisi" });
    if (!idBerkasFoto) return res.status(400).json({ message: "idBerkasFoto wajib diisi" });
    
    // Validasi ID Perusahaan sangat penting untuk menemukan path dokumen
    if (!IDPerusahaan) return res.status(400).json({ message: "IDPerusahaan wajib diisi di body untuk verifikasi lokasi data" });

    // 1. Get existing absensi record (Sub-Collection Path)
    const docRef = db
      .collection("companies")
      .doc(IDPerusahaan)
      .collection("absensi")
      .doc(id);
      
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({ message: "Absensi record not found di perusahaan ini" });
    }

    const absensiData = docSnap.data();

    // 2. Ambil URL Foto Pulang
    const photoURL = await getFileUrlById(IDPerusahaan, idBerkasFoto);
    if (!photoURL) {
      return res.status(404).json({ message: "File foto pulang tidak ditemukan di database perusahaan." });
    }

    // 3. Calculate duration
    const checkInTime = absensiData.waktuCheckIn.toDate();
    const checkOutTime = new Date();
    const durationMs = checkOutTime - checkInTime;
    const durationHours = (durationMs / (1000 * 60 * 60)).toFixed(2);

    // 4. Update absensi record
    await docRef.update({
      waktuCheckOut: Timestamp.now(),
      fotoCheckOut: photoURL,
      latitudeCheckOut: LatitudePulang,
      longtitudeCheckOut: LongtitudePulang,
      alamatLocCheckOut: AlamatPulang,
      durasi: durationHours,
      status: "checked-out",
      updatedAt: Timestamp.now(),
    });

    return res.status(200).send("updated");

  } catch (err) {
    console.error("Check out error:", err);
    return res.status(500).json({ message: "Gagal mengupdate absensi", error: err.message });
  }
});

module.exports = router;