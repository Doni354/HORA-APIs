/* eslint-disable */
const express = require("express");
const { db } = require("../config/firebase");
const { verifyToken } = require("../middleware/token");
const { uploadFile } = require("../helper/uploadFile");
const router = express.Router();
const { Timestamp } = require("firebase-admin/firestore");
const { logCompanyActivity } = require("../helper/logCompanyActivity");
// =========================================================
// EMPLOYEE MANAGEMENT
// =========================================================

// 1. GET LIST PEGAWAI (Dari kode lama kamu)
router.get("/list-employees", verifyToken, async (req, res) => {
  try {
    const myCompanyId = req.user.idCompany;
    const myEmail = req.user.email;

    if (!myCompanyId) {
      return res
        .status(400)
        .json({ message: "User tidak terikat dengan perusahaan manapun." });
    }

    const snapshot = await db
      .collection("users")
      .where("idCompany", "==", myCompanyId)
      .orderBy("createdAt", "desc")
      .get();

    if (snapshot.empty) {
      return res
        .status(200)
        .json({ message: "Belum ada pegawai lain", data: [] });
    }

    const allUsers = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      allUsers.push({
        email: doc.id,
        username: data.username,
        photoUrl: data.photoUrl || null, // Tambahan: biar fotonya muncul di list
        noTelp: data.noTelp,
        role: data.role,
        status: data.status,
        joinedAt: data.createdAt,
        isMe: doc.id === myEmail,
      });
    });

    return res.status(200).json({
      message: "Data pegawai berhasil diambil",
      requestor: myEmail,
      data: allUsers,
    });
  } catch (e) {
    console.error("Get Employees Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

// =========================================================
// COMPANY PROFILE
// =========================================================

// ---------------------------------------------------------
// 1. GET COMPANY PROFILE (Sesuai Format Request)
// ---------------------------------------------------------
router.get("/company-profile", verifyToken, async (req, res) => {
  try {
    const user = req.user;

    // Validasi user harus punya company
    if (!user.idCompany) {
      return res
        .status(400)
        .json({ message: "User tidak terikat dengan perusahaan manapun." });
    }

    const companyDoc = await db
      .collection("companies")
      .doc(user.idCompany)
      .get();

    if (!companyDoc.exists) {
      return res
        .status(404)
        .json({ message: "Data perusahaan tidak ditemukan" });
    }

    const data = companyDoc.data();

    // MAPPING DATA (Agar sesuai key JSON yang diminta)
    const formattedProfile = {
      namaPerusahaan: data.namaPerusahaan || "",
      idperusahaan: data.idCompany || "", // Mapping: idCompany DB -> idperusahaan JSON
      logoPerusahaan: data.logoUrl || "", // Default kosong jika belum di-upload
      alamatLoc: data.alamatLoc || "",
      noWA: data.noWA || "",
      noTelp: data.noTelp || "",
      logo: data.logoUrl || "",
      // Pastikan tipe data string sesuai contoh request ("98.63...")
      alamatLongtitude: data.longitude ? data.longitude.toString() : "0.0",
      alamatLatitude: data.latitude ? data.latitude.toString() : "0.0",
      totalLike: data.totalLike || 0,
    };

    // Return dalam bentuk Array [...] sesuai request
    return res.status(200).json([formattedProfile]);
  } catch (e) {
    console.error("Get Company Profile Error:", e);
    return res.status(500).json({ message: "Error fetch company profile" });
  }
});

// ---------------------------------------------------------
// 2. UPDATE DATA TEXT (Nama, Alamat, Telp, Koordinat)
// ---------------------------------------------------------
router.put("/company-profile", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    const {
      namaPerusahaan,
      alamatLoc,
      noTelp,
      noWA,
      alamatLatitude,
      alamatLongtitude,
    } = req.body;

    // Security: Hanya Admin yang boleh edit
    if (user.role !== "admin") {
      return res
        .status(403)
        .json({
          message: "Hanya Admin yang boleh mengedit profil perusahaan.",
        });
    }

    if (!user.idCompany) {
      return res.status(400).json({ message: "ID Company tidak valid." });
    }

    const companyRef = db.collection("companies").doc(user.idCompany);

    // Siapkan object update (Hanya update field yang dikirim saja/Partial Update)
    const updateData = {};
    if (namaPerusahaan) updateData.namaPerusahaan = namaPerusahaan;
    if (alamatLoc) updateData.alamatLoc = alamatLoc;
    if (noTelp) updateData.noTelp = noTelp;
    if (noWA) updateData.noWA = noWA;
    if (alamatLatitude) updateData.latitude = alamatLatitude; // Mapping ke field DB: latitude
    if (alamatLongtitude) updateData.longitude = alamatLongtitude; // Mapping ke field DB: longitude

    // Lakukan update
    await companyRef.update(updateData);

    // LOG AKTIVITAS (Company Level)
    await logCompanyActivity(user.idCompany, {
      actorEmail: user.email,
      actorName: user.nama || "Admin",
      target: user.idCompany,
      action: "UPDATE_PROFILE",
      description: `Admin ${
        user.nama || "Admin"
      } memperbarui profil perusahaan.`,
    });

    return res.status(200).json({
      message: "Data perusahaan berhasil diperbarui.",
      updatedFields: updateData,
    });
  } catch (e) {
    console.error("Update Text Profile Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

// ---------------------------------------------------------
// 3. UPDATE LOGO PERUSAHAAN (Upload + Delete Old)
// ---------------------------------------------------------
router.post("/company-logo", verifyToken, async (req, res) => {
  try {
    const user = req.user;

    if (user.role !== "admin") {
      return res.status(403).json({ message: "Hanya Admin yang boleh mengubah logo." });
    }

    if (!user.idCompany) {
      return res.status(400).json({ message: "ID Company tidak valid." });
    }

    // A. Ambil Data Lama Dulu
    const companyRef = db.collection("companies").doc(user.idCompany);
    const companyDoc = await companyRef.get();
    const oldLogoUrl = companyDoc.exists ? companyDoc.data().logoUrl : null;

    // B. Upload File Baru
    const generateFileName = (fileExt) => {
        const timestamp = Date.now();
        return `logo_${user.idCompany}_${timestamp}${fileExt}`;
    };

    // Upload ke folder 'company_logos'
    const publicUrl = await uploadFile(req, "company_logos", generateFileName);

    // C. Hapus File Lama (Jika Ada)
    if (oldLogoUrl) {
        try {
            // Cek apakah URL-nya dari storage kita (bukan link external sembarang)
            // Format URL: https://storage.googleapis.com/BUCKET_NAME/FOLDER/FILE
            if (oldLogoUrl.includes("storage.googleapis.com")) {
                // Ambil path file dari URL
                // Kita split berdasarkan nama bucket agar aman
                const filePath = oldLogoUrl.split(`/${bucket.name}/`)[1];
                if (filePath) {
                    await bucket.file(decodeURIComponent(filePath)).delete();
                    console.log("Deleted old logo:", filePath);
                }
            }
        } catch (err) {
            console.error("Gagal menghapus logo lama (abaikan):", err.message);
            // Jangan throw error, biarkan proses update lanjut
        }
    }

    // D. Update URL Baru di Firestore
    await companyRef.update({
        logoUrl: publicUrl
    });

    await logCompanyActivity(user.idCompany, {
      actorEmail: user.email,
      actorName: user.nama || "Admin",
      target: user.idCompany,
      action: "UPDATE_LOGO",
      description: `Admin ${user.nama || "Admin"} memperbarui logo perusahaan.`
    });

    return res.status(200).json({ 
        message: "Logo perusahaan berhasil diperbarui.", 
        logoPerusahaan: publicUrl 
    });

  } catch (e) {
    console.error("Update Logo Error:", e);
    return res.status(500).json({ 
        message: "Gagal mengupload logo.", 
        error: e.message 
    });
  }
});
// =========================================================
// USER PROFILE (ME)
// =========================================================

// ---------------------------------------------------------
// 1. GET MY PROFILE (Format Sesuai Request Legacy)
// ---------------------------------------------------------
// Endpoint: GET /api/user-profile
// Endpoint: GET /api/user-profile/:email
// Contoh akses: /api/user-profile/doni.smpn1@gmail.com
router.get("/user-profile/:email", verifyToken, async (req, res) => {
  try {
    // 1. Ambil email dari Parameter URL
    const targetEmail = req.params.email;
    
    // 2. Ambil idCompany pengakses dari middleware verifyToken (req.user)
    const requesterIdCompany = req.user.idCompany;

    if (!targetEmail) {
      return res.status(400).json({ message: "Parameter email tidak valid." });
    }

    // 3. Ambil Data User Target dari Firestore
    const userDoc = await db.collection("users").doc(targetEmail).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ message: "Data user tidak ditemukan di database." });
    }

    const userData = userDoc.data();

    // 4. KONDISI: Cek idCompany pengakses vs idCompany target
    // User hanya boleh lihat profile jika berada di perusahaan yang sama
    if (userData.idCompany !== requesterIdCompany) {
      return res.status(403).json({ 
        message: "Akses dilarang. Anda tidak memiliki izin untuk melihat profil di luar perusahaan Anda." 
      });
    }

    // 5. Ambil Data Company (untuk Longitude/Latitude kantor)
    let companyData = {};
    if (userData.idCompany) {
        const compDoc = await db.collection("companies").doc(userData.idCompany).get();
        if (compDoc.exists) {
            companyData = compDoc.data();
        }
    }

    // 6. Logic Formatting Status
    const statusString = `${userData.status ? userData.status.charAt(0).toUpperCase() + userData.status.slice(1) : "Inactive"} & ${userData.verified ? "Verified" : "Unverified"}`;

    // 7. MAPPING DATA (Custom Format sesuai Request)
    const formattedProfile = {
      namaKaryawan: userData.username || "",
      liked: "yes", 
      alamatEmail: userData.alamatEmail || targetEmail,
      noHP: userData.noTelp || null,
      noWA: userData.noWA || null,
      
      namaPerusahaan: userData.companyName || companyData.namaPerusahaan || "",
      idPerusahaan: userData.idCompany || "",
      alamatLongtitude: companyData.longitude ? companyData.longitude.toString() : "0.0",
      alamatLatitude: companyData.latitude ? companyData.latitude.toString() : "0.0",
      alamatLoc: userData.alamatLoc || companyData.alamatLoc || "", 
      
      foto: userData.photoURL || null,
      
      joinDate: userData.createdAt 
        ? (userData.createdAt.toDate ? userData.createdAt.toDate().toISOString().split('.')[0] : userData.createdAt)
        : new Date().toISOString().split('.')[0],
      
      status: statusString,
      
      fcmToken: userData.fcmToken || "ABC001K001", 
      id: 1, 
      idKaryawan: userData.uid || "", 
      gender: userData.gender || "Male", 
      jabatan: userData.role ? userData.role.charAt(0).toUpperCase() + userData.role.slice(1) : "Staff",
      statusAds: "Free"
    };

    // Return array sesuai format awal kamu
    return res.status(200).json([formattedProfile]);

  } catch (e) {
    console.error("Get User Profile Error:", e);
    return res.status(500).json({ message: "Server Error", error: e.message });
  }
});

// ---------------------------------------------------------
// 2. UPDATE USER PROFILE (Data Teks)
// ---------------------------------------------------------
// Endpoint: PUT /api/user-profile
router.put("/user-profile", verifyToken, async (req, res) => {
  try {
    const email = req.user.email;
    const { username, noTelp, noWA, alamatLoc } = req.body;

    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ message: "User tidak ditemukan." });
    }

    // Siapkan data update (Partial Update)
    const updateData = {};
    if (username) updateData.username = username;
    if (noTelp) updateData.noTelp = noTelp;
    if (noWA) updateData.noWA = noWA;
    if (alamatLoc) updateData.alamatLoc = alamatLoc; // User bisa punya alamat sendiri beda sama kantor

    await userRef.update(updateData);

    return res.status(200).json({
      message: "Profil berhasil diperbarui.",
      updatedFields: updateData
    });

  } catch (e) {
    console.error("Update User Profile Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

// ---------------------------------------------------------
// 3. UPDATE USER PHOTO (Upload + Delete Old)
// ---------------------------------------------------------
router.post("/upload-avatar", verifyToken, async (req, res) => {
  try {
    const email = req.user.email;
    const uid = req.user.uid || email;

    // A. Ambil Data Lama
    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();
    const oldPhotoUrl = userDoc.exists ? userDoc.data().photoURL : null;

    // B. Upload Foto Baru
    const generateFileName = (fileExt) => {
        const timestamp = Date.now();
        const cleanId = uid.replace(/[^a-zA-Z0-9]/g, ""); 
        return `profile_${cleanId}_${timestamp}${fileExt}`;
    };

    // Upload ke folder 'user_profiles'
    const publicUrl = await uploadFile(req, "user_profiles", generateFileName);

    // C. Hapus Foto Lama (Jika Ada dan BUKAN FOTO GOOGLE)
    if (oldPhotoUrl) {
        try {
            // PENTING: Hanya hapus jika file ada di bucket kita
            // Jangan hapus jika URL-nya 'lh3.googleusercontent.com' (Foto bawaan Gmail)
            if (oldPhotoUrl.includes("storage.googleapis.com")) {
                const filePath = oldPhotoUrl.split(`/${bucket.name}/`)[1];
                if (filePath) {
                    await bucket.file(decodeURIComponent(filePath)).delete();
                    console.log("Deleted old user photo:", filePath);
                }
            }
        } catch (err) {
            console.error("Gagal menghapus foto lama (abaikan):", err.message);
        }
    }

    // D. Update URL di Firestore
    await userRef.update({
        photoURL: publicUrl
    });

    return res.status(200).json({ 
        message: "Foto profil berhasil diperbarui.", 
        photoURL: publicUrl 
    });

  } catch (e) {
    console.error("Update Photo Error:", e);
    return res.status(500).json({ 
        message: "Gagal mengupload foto.", 
        error: e.message 
    });
  }
});


// =========================================================
// USER PROFILE Optional
// =========================================================

// 8. CHANGE EMAIL (COMPLEX) - NEW!
router.put("/change-email", verifyToken, async (req, res) => {
  try {
    const oldEmail = req.user.email;
    const { newEmail } = req.body;

    if (!newEmail || !newEmail.includes("@")) {
      return res.status(400).json({ message: "Email baru tidak valid" });
    }

    if (oldEmail === newEmail) {
      return res
        .status(400)
        .json({ message: "Email baru sama dengan yang lama" });
    }

    await db.runTransaction(async (transaction) => {
      // A. Cek Email Baru
      const newEmailRef = db.collection("users").doc(newEmail);
      const newEmailDoc = await transaction.get(newEmailRef);
      if (newEmailDoc.exists) {
        throw new Error("EMAIL_ALREADY_EXISTS");
      }

      // B. Ambil Data Lama
      const oldEmailRef = db.collection("users").doc(oldEmail);
      const oldEmailDoc = await transaction.get(oldEmailRef);
      if (!oldEmailDoc.exists) {
        throw new Error("USER_NOT_FOUND");
      }

      const oldData = oldEmailDoc.data();

      // C. Clone Data ke Email Baru
      const newData = {
        ...oldData,
        alamatEmail: newEmail,
        emailChangedAt: Timestamp.now(),
        verified: false,
        otp: null,
      };

      // D. Simpan Baru & Hapus Lama
      transaction.set(newEmailRef, newData);
      transaction.delete(oldEmailRef);
    });

    return res.status(200).json({
      message: "Email berhasil diubah. Silakan login ulang.",
      action: "LOGOUT_REQUIRED",
    });
  } catch (e) {
    console.error("Change Email Error:", e);
    if (e.message === "EMAIL_ALREADY_EXISTS") {
      return res
        .status(400)
        .json({ message: "Email sudah digunakan user lain." });
    }
    return res.status(500).json({ message: "Gagal mengubah email" });
  }
});

// 9. DELETE ACCOUNT
router.delete("/account", verifyToken, async (req, res) => {
  try {
    const email = req.user.email;
    const role = req.user.role;

    if (role === "admin") {
      return res.status(400).json({
        message:
          "Admin tidak bisa hapus akun sembarangan. Transfer kepemilikan dulu.",
      });
    }

    await db.collection("users").doc(email).delete();

    return res
      .status(200)
      .json({ message: "Akun Anda berhasil dihapus selamanya." });
  } catch (e) {
    return res.status(500).json({ message: "Gagal menghapus akun" });
  }
});

module.exports = router;
