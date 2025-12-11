/* eslint-disable */
const express = require("express");
const router = express.Router();
const { db } = require("../config/firebase");
const { verifyToken } = require("../middleware/token");
const { Timestamp } = require("firebase-admin/firestore");

// ---------------------------------------------------------
// 1. SYNC KONTAK (Upload Banyak Sekaligus / Batch)
// ---------------------------------------------------------
router.post("/sync", verifyToken, async (req, res) => {
  try {
    const user = req.user;

    // DEBUG: Cek isi token yang diterima server
    console.log(">>> [DEBUG] Token Decoded:", JSON.stringify(user));

    const { contacts } = req.body;

    // 1. Validasi Token Payload (Support 'id' atau 'email')
    // Kita cari email/id user untuk dijadikan referensi Doc ID
    const userEmail = user.id || user.email;

    if (!userEmail) {
      console.error(">>> ERROR: Field ID/Email tidak ditemukan di token.");
      return res
        .status(401)
        .json({ message: "Token tidak valid (Identitas tidak ditemukan)." });
    }

    // 2. Validasi Body
    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
      return res
        .status(400)
        .json({ message: "Data kontak (array) wajib diisi." });
    }

    // 3. Ambil UID Asli dari Database (Opsional, untuk kelengkapan data)
    // Kita cari dokumen User berdasarkan 'userEmail' (ID Doc)
    let karyawanUid = user.uid; // Cek kalau di token udah ada uid

    if (!karyawanUid) {
      const userDocRef = db.collection("users").doc(userEmail);
      const userDoc = await userDocRef.get();

      if (userDoc.exists) {
        // Ambil field 'uid' di dalam dokumen (ykKSExz...)
        karyawanUid = userDoc.data().uid;
      }
    }

    // Fallback: Jika UID tetap gak ketemu, pake email aja sebagai ID Karyawan
    if (!karyawanUid) {
      karyawanUid = userEmail;
    }

    // 4. Proses Batching
    const BATCH_SIZE = 400;
    const chunks = [];

    for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
      chunks.push(contacts.slice(i, i + BATCH_SIZE));
    }

    let totalSaved = 0;

    for (const chunk of chunks) {
      const batch = db.batch();

      chunk.forEach((contact) => {
        const cId = contact.contactId ? String(contact.contactId) : "";
        const cName = contact.namaKontak ? String(contact.namaKontak) : "";

        if (cId && cName) {
          // Path: users/{email}/saved_contacts/{contactId}
          const docRef = db
            .collection("users")
            .doc(userEmail)
            .collection("saved_contacts")
            .doc(cId);

          batch.set(
            docRef,
            {
              contactId: cId,
              namaKontak: cName,
              noHP: contact.noHP || "",
              idKaryawan: karyawanUid, // Disimpan biar data kontak terikat ke UID User
              syncedAt: Timestamp.now(),
            },
            { merge: true }
          );
        }
      });

      await batch.commit();
      totalSaved += chunk.length;
    }

    return res.status(200).json({
      message: "Sinkronisasi kontak berhasil.",
      totalSynced: totalSaved,
    });
  } catch (e) {
    console.error("Sync Contacts Error:", e);
    return res.status(500).json({
      message: "Server Error saat sync kontak.",
      error: e.message,
    });
  }
});

// ---------------------------------------------------------
// 2. GET CONTACTS (Ambil Semua Kontak User Ini)
// ---------------------------------------------------------
router.get("/list", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    const userEmail = user.id || user.email; // Support 'id' atau 'email'

    if (!userEmail)
      return res.status(400).json({ message: "User Email invalid." });

    const snapshot = await db
      .collection("users")
      .doc(userEmail)
      .collection("saved_contacts")
      .orderBy("namaKontak", "asc")
      .get();

    if (snapshot.empty) {
      return res
        .status(200)
        .json({ message: "Belum ada kontak tersimpan.", data: [] });
    }

    const contacts = [];
    snapshot.forEach((doc) => {
      contacts.push(doc.data());
    });

    return res.status(200).json({
      message: "Data kontak berhasil diambil.",
      total: contacts.length,
      data: contacts,
    });
  } catch (e) {
    console.error("Get Contacts Error:", e);
    return res.status(500).json({ message: "Server Error." });
  }
});

// ---------------------------------------------------------
// 3. DELETE CONTACT (Hapus Satu Kontak)
// ---------------------------------------------------------
router.delete("/:contactId", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    const userEmail = user.id || user.email;
    const { contactId } = req.params;

    if (!contactId)
      return res.status(400).json({ message: "Contact ID harus diisi." });

    const docRef = db
      .collection("users")
      .doc(userEmail)
      .collection("saved_contacts")
      .doc(contactId);

    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: "Kontak tidak ditemukan." });
    }

    await docRef.delete();

    return res.status(200).json({ message: "Kontak berhasil dihapus." });
  } catch (e) {
    console.error("Delete Contact Error:", e);
    return res.status(500).json({ message: "Server Error." });
  }
});

module.exports = router;
