/* eslint-disable */
const express = require("express");

const { db } = require("../config/firebase");
const { verifyToken } = require("../middleware/token");
const { uploadFile } = require("../helper/uploadFile");
const router = express.Router();
const { Timestamp } = require("firebase-admin/firestore");
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

// 2. VIEW COMPANY PROFILE
router.get("/company-profile", verifyToken, async (req, res) => {
  try {
    const companyId = req.user.idCompany;

    const companyDoc = await db.collection("companies").doc(companyId).get();
    if (!companyDoc.exists) {
      return res
        .status(404)
        .json({ message: "Data perusahaan tidak ditemukan" });
    }

    return res.status(200).json(companyDoc.data());
  } catch (e) {
    return res.status(500).json({ message: "Error fetch company profile" });
  }
});

// 3. EDIT COMPANY PROFILE (TEXT DATA)
router.put("/company-profile", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res
        .status(403)
        .json({
          message: "Hanya Admin yang boleh mengedit profil perusahaan.",
        });
    }

    const { namaPerusahaan, alamatLoc, deskripsi } = req.body;
    const companyId = req.user.idCompany;

    await db
      .collection("companies")
      .doc(companyId)
      .update({
        namaPerusahaan: namaPerusahaan,
        alamatLoc: alamatLoc,
        deskripsi: deskripsi || "",
        updatedAt: Timestamp.now(),
        updatedBy: req.user.email,
      });

    return res
      .status(200)
      .json({ message: "Profil Perusahaan berhasil diupdate" });
  } catch (e) {
    return res.status(500).json({ message: "Gagal update profil perusahaan" });
  }
});

// 4. UPLOAD COMPANY LOGO (IMAGE DATA) - NEW!
router.post("/upload-company-logo", verifyToken, async (req, res) => {
  try {
    const { role, idCompany } = req.user;

    if (role !== "admin") {
      return res
        .status(403)
        .json({ message: "Hanya Admin yang boleh mengganti logo perusahaan" });
    }

    const publicUrl = await uploadFile(req, "company_logos", (ext) => {
      // Format nama file: IDCompany_Timestamp.ext
      return `${idCompany}_${Date.now()}${ext}`;
    });

    await db.collection("companies").doc(idCompany).update({
      logoUrl: publicUrl,
      updatedAt: Timestamp.now(),
    });

    return res.status(200).json({
      message: "Logo perusahaan berhasil diperbarui",
      url: publicUrl,
    });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ message: "Gagal upload logo", error: e.message });
  }
});

// =========================================================
// USER PROFILE (ME)
// =========================================================

// 5. VIEW MY PROFILE
router.get("/user-profile", verifyToken, async (req, res) => {
  try {
    const userDoc = await db.collection("users").doc(req.user.email).get();

    if (!userDoc.exists)
      return res.status(404).json({ message: "User not found" });

    const userData = userDoc.data();
    // Hapus data sensitif
    delete userData.otp;
    delete userData.otpExpires;

    return res.status(200).json(userData);
  } catch (e) {
    return res.status(500).json({ message: "Error fetch user profile" });
  }
});

// 6. EDIT MY PROFILE (TEXT DATA)
router.put("/user-profile", verifyToken, async (req, res) => {
  try {
    const { username, noTelp, noWA } = req.body;
    const email = req.user.email;

    const updateData = {};
    if (username) updateData.username = username;
    if (noTelp) updateData.noTelp = noTelp;
    if (noWA) updateData.noWA = noWA;
    updateData.updatedAt = Timestamp.now();

    await db.collection("users").doc(email).update(updateData);

    return res.status(200).json({ message: "Profil Anda berhasil diupdate" });
  } catch (e) {
    return res.status(500).json({ message: "Gagal update profil" });
  }
});

// 7. UPLOAD AVATAR (IMAGE DATA) - NEW!
router.post("/upload-avatar", verifyToken, async (req, res) => {
  try {
    const email = req.user.email;

    const publicUrl = await uploadFile(req, "avatars", (ext) => {
      // Sanitasi email agar aman jadi nama file
      const sanitizedEmail = email.replace(/[^a-zA-Z0-9]/g, "_");
      return `${sanitizedEmail}_${Date.now()}${ext}`;
    });

    await db.collection("users").doc(email).update({
      photoUrl: publicUrl,
      updatedAt: Timestamp.now(),
    });

    return res.status(200).json({
      message: "Foto profil berhasil diperbarui",
      url: publicUrl,
    });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ message: "Gagal upload gambar", error: e.message });
  }
});

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
