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
// 3. UPDATE LOGO PERUSAHAAN (Upload File)
// ---------------------------------------------------------
router.post("/company-logo", verifyToken, async (req, res) => {
  try {
    const user = req.user;

    // Security: Hanya Admin
    if (user.role !== "admin") {
      return res
        .status(403)
        .json({ message: "Hanya Admin yang boleh mengubah logo." });
    }

    if (!user.idCompany) {
      return res.status(400).json({ message: "ID Company tidak valid." });
    }

    // Fungsi penamaan file unik
    // Format: logo_IDCOMPANY_TIMESTAMP.jpg
    const generateFileName = (fileExt) => {
      const timestamp = Date.now();
      return `logo_${user.idCompany}_${timestamp}${fileExt}`;
    };

    // Panggil Helper uploadFile
    // Folder di storage: 'company_logos'
    const publicUrl = await uploadFile(req, "company_logos", generateFileName);

    // Update URL Logo di Firestore
    await db.collection("companies").doc(user.idCompany).update({
      logoUrl: publicUrl,
    });

    // LOG AKTIVITAS (Company Level)
    await logCompanyActivity(user.idCompany, {
      actorEmail: user.email,
      actorName: user.nama || "Admin",
      target: user.idCompany,
      action: "UPDATE_LOGO",
      description: `Admin ${user.nama || "Admin"} memperbarui logo perusahaan.`,
    });

    return res.status(200).json({
      message: "Logo perusahaan berhasil diperbarui.",
      logoPerusahaan: publicUrl,
    });
  } catch (e) {
    console.error("Update Logo Error:", e);
    return res.status(500).json({
      message: "Gagal mengupload logo.",
      error: e.message,
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
router.get("/user-profile", verifyToken, async (req, res) => {
  try {
    const email = req.user.email; // Ambil dari Token Middleware

    // 1. Ambil Data User
    const userDoc = await db.collection("users").doc(email).get();
    if (!userDoc.exists) {
      return res.status(404).json({ message: "Data user tidak ditemukan." });
    }
    const userData = userDoc.data();

    // 2. Ambil Data Company (Karena butuh Longitude/Latitude/Alamat Kantor)
    let companyData = {};
    if (userData.idCompany) {
        const compDoc = await db.collection("companies").doc(userData.idCompany).get();
        if (compDoc.exists) {
            companyData = compDoc.data();
        }
    }

    // 3. Logic Formatting Status
    const statusString = `${userData.status ? userData.status.charAt(0).toUpperCase() + userData.status.slice(1) : "Inactive"} & ${userData.verified ? "Verified" : "Unverified"}`;

    // 4. MAPPING DATA (Custom Format sesuai Request)
    const formattedProfile = {
      namaKaryawan: userData.username || "",
      liked: "yes", 
      alamatEmail: userData.alamatEmail || email,
      noHP: userData.noTelp || null,
      noWA: userData.noWA || null,
      
      // Data dari Collection Company
      namaPerusahaan: userData.companyName || companyData.namaPerusahaan || "",
      idPerusahaan: userData.idCompany || "",
      alamatLongtitude: companyData.longitude ? companyData.longitude.toString() : "0.0",
      alamatLatitude: companyData.latitude ? companyData.latitude.toString() : "0.0",
      alamatLoc: userData.alamatLoc || companyData.alamatLoc || "", // Prioritas alamat user, fallback ke kantor
      
      foto: userData.photoURL || null,
      
      joinDate: userData.createdAt ? userData.createdAt.toDate().toISOString().split('.')[0] : new Date().toISOString().split('.')[0],
      
      status: statusString,
      
      fcmToken: userData.fcmToken || "ABC001K001", 
      id: 1, 
      idKaryawan: userData.uid || "", 
      gender: userData.gender || "Male", 
      jabatan: userData.role ? userData.role.charAt(0).toUpperCase() + userData.role.slice(1) : "Staff",
      statusAds: "Free"
    };

    return res.status(200).json([formattedProfile]);

  } catch (e) {
    console.error("Get User Profile Error:", e);
    return res.status(500).json({ message: "Server Error" });
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
// 3. UPDATE USER PHOTO (Upload File)
// ---------------------------------------------------------
// Endpoint: POST /api/user-profile/photo
router.post("/upload-avatar", verifyToken, async (req, res) => {
  try {
    const email = req.user.email;
    const uid = req.user.uid || email; // Fallback UID

    // Fungsi penamaan file unik: profile_UID_TIMESTAMP.jpg
    const generateFileName = (fileExt) => {
        const timestamp = Date.now();
        // Bersihkan email dari karakter aneh jika dipakai sebagai ID
        const cleanId = uid.replace(/[^a-zA-Z0-9]/g, ""); 
        return `profile_${cleanId}_${timestamp}${fileExt}`;
    };

    // Panggil Helper uploadFile
    // Folder di storage: 'user_profiles'
    const publicUrl = await uploadFile(req, "user_profiles", generateFileName);

    // Update URL di Firestore
    await db.collection("users").doc(email).update({
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

// // 5. VIEW MY PROFILE
// router.get("/user-profile", verifyToken, async (req, res) => {
//   try {
//     const userDoc = await db.collection("users").doc(req.user.email).get();

//     if (!userDoc.exists)
//       return res.status(404).json({ message: "User not found" });

//     const userData = userDoc.data();
//     // Hapus data sensitif
//     delete userData.otp;
//     delete userData.otpExpires;

//     return res.status(200).json(userData);
//   } catch (e) {
//     return res.status(500).json({ message: "Error fetch user profile" });
//   }
// });

// // 6. EDIT MY PROFILE (TEXT DATA)
// router.put("/user-profile", verifyToken, async (req, res) => {
//   try {
//     const { username, noTelp, noWA } = req.body;
//     const email = req.user.email;

//     const updateData = {};
//     if (username) updateData.username = username;
//     if (noTelp) updateData.noTelp = noTelp;
//     if (noWA) updateData.noWA = noWA;
//     updateData.updatedAt = Timestamp.now();

//     await db.collection("users").doc(email).update(updateData);

//     return res.status(200).json({ message: "Profil Anda berhasil diupdate" });
//   } catch (e) {
//     return res.status(500).json({ message: "Gagal update profil" });
//   }
// });

// // 7. UPLOAD AVATAR (IMAGE DATA) - NEW!
// router.post("/upload-avatar", verifyToken, async (req, res) => {
//   try {
//     const email = req.user.email;

//     const publicUrl = await uploadFile(req, "avatars", (ext) => {
//       // Sanitasi email agar aman jadi nama file
//       const sanitizedEmail = email.replace(/[^a-zA-Z0-9]/g, "_");
//       return `${sanitizedEmail}_${Date.now()}${ext}`;
//     });

//     await db.collection("users").doc(email).update({
//       photoUrl: publicUrl,
//       updatedAt: Timestamp.now(),
//     });

//     return res.status(200).json({
//       message: "Foto profil berhasil diperbarui",
//       url: publicUrl,
//     });
//   } catch (e) {
//     console.error(e);
//     return res
//       .status(500)
//       .json({ message: "Gagal upload gambar", error: e.message });
//   }
// });

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
