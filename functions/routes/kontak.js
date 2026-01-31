/* eslint-disable */
const express = require("express");
const router = express.Router();
const { db } = require("../config/firebase");
const { verifyToken } = require("../middleware/token");
const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto"); // Untuk generate share token random

// ---------------------------------------------------------
// 1. SYNC KONTAK (Batch Upload)
// ---------------------------------------------------------
router.post("/sync", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    const { contacts } = req.body;
    const userEmail = user.id || user.email;

    if (!userEmail) return res.status(401).json({ message: "Invalid Token" });
    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ message: "Data kontak wajib diisi." });
    }

    // Cari UID Karyawan
    let karyawanUid = user.uid || userEmail;
    if (!user.uid) {
      const userDoc = await db.collection("users").doc(userEmail).get();
      if (userDoc.exists) karyawanUid = userDoc.data().uid || userEmail;
    }

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
        const noHP = contact.noHP || "";

        if (cId && cName) {
          const docRef = db
            .collection("users")
            .doc(userEmail)
            .collection("saved_contacts")
            .doc(cId);

          // Data dasar saat sinkronisasi awal
          const baseData = {
            contactId: cId,
            namaKontak: cName,
            noHP: noHP,
            noWA: contact.noWA || noHP,
            idKaryawan: karyawanUid,
            syncedAt: Timestamp.now(),
            // Default value untuk field yang belum ada
            fotoKontak: null,
            lokasi: null,
            size: "1 KB", // Estimasi awal (Text only)
          };

          // Logic: Jika sync ulang, kita hanya update data dasar.
          // Tapi jika field foto/lokasi sudah ada sebelumnya di DB, jangan ditimpa null.
          // Firestore merge: true akan menangani ini (field yg tidak dikirim tidak akan terhapus).
          batch.set(
            docRef,
            {
              ...baseData,
              updatedAt: Timestamp.now(),
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
    console.error("Sync Error:", e);
    return res.status(500).json({ message: "Server Error", error: e.message });
  }
});

// ---------------------------------------------------------
// 2. GET LIST KONTAK
// ---------------------------------------------------------
router.get("/list", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    const userEmail = user.id || user.email;

    const snapshot = await db
      .collection("users")
      .doc(userEmail)
      .collection("saved_contacts")
      .orderBy("namaKontak", "asc")
      .get();

    const contacts = [];
    snapshot.forEach((doc) => contacts.push(doc.data()));

    return res.status(200).json({
      message: "Data kontak berhasil diambil.",
      total: contacts.length,
      data: contacts,
    });
  } catch (e) {
    return res.status(500).json({ message: "Server Error" });
  }
});

// ---------------------------------------------------------
// 3. GET DETAIL KONTAK
// ---------------------------------------------------------
router.get("/detail/:contactId", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    const userEmail = user.id || user.email;
    const { contactId } = req.params;

    // SECURITY: Path ini dikunci berdasarkan userEmail dari token.
    // User A tidak akan bisa melihat detail kontak User B meskipun tau contactId-nya.
    const docRef = db
      .collection("users")
      .doc(userEmail)
      .collection("saved_contacts")
      .doc(contactId);

    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: "Kontak tidak ditemukan." });
    }

    return res.status(200).json({
      message: "Detail kontak ditemukan.",
      data: doc.data(),
    });
  } catch (e) {
    return res.status(500).json({ message: "Server Error", error: e.message });
  }
});

// ---------------------------------------------------------
// 4. UPDATE KONTAK (Edit Foto, Lokasi, Size)
// ---------------------------------------------------------
router.put("/:contactId", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    const userEmail = user.id || user.email;
    const { contactId } = req.params;

    // Data yang bisa diupdate
    // size: dikirim oleh frontend (hasil kalkulasi size foto + text)
    const { namaKontak, noHP, noWA, fotoKontak, lokasi, size } = req.body;

    const docRef = db
      .collection("users")
      .doc(userEmail)
      .collection("saved_contacts")
      .doc(contactId);

    // Cek keberadaan dokumen (sekalian validasi kepemilikan)
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ message: "Kontak tidak ditemukan." });
    }

    // Siapkan object update
    const updateData = {
      updatedAt: Timestamp.now(),
    };

    if (namaKontak) updateData.namaKontak = namaKontak;
    if (noHP) updateData.noHP = noHP;
    if (noWA) updateData.noWA = noWA;
    if (fotoKontak) updateData.fotoKontak = fotoKontak; // URL Gambar
    if (lokasi) updateData.lokasi = lokasi; // Object { lat, long, address }
    if (size) updateData.size = size; // String (e.g., "2.5 MB")

    await docRef.update(updateData);

    return res.status(200).json({
      message: "Kontak berhasil diperbarui.",
      data: {
        contactId,
        ...doc.data(),
        ...updateData,
      },
    });
  } catch (e) {
    console.error("Update Contact Error:", e);
    return res.status(500).json({ message: "Server Error", error: e.message });
  }
});

// ---------------------------------------------------------
// 5. DELETE KONTAK
// ---------------------------------------------------------
router.delete("/:contactId", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    const userEmail = user.id || user.email;
    const { contactId } = req.params;

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
    return res.status(500).json({ message: "Server Error" });
  }
});

// ---------------------------------------------------------
// 6. SHARE KONTAK (Generate Share Token)
// ---------------------------------------------------------
router.post("/share", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    const userEmail = user.id || user.email;
    const { contactId } = req.body;

    if (!contactId)
      return res.status(400).json({ message: "Contact ID diperlukan." });

    // 1. Ambil data kontak original milik user
    const originalDocRef = db
      .collection("users")
      .doc(userEmail)
      .collection("saved_contacts")
      .doc(contactId);

    const originalDoc = await originalDocRef.get();
    if (!originalDoc.exists) {
      return res
        .status(404)
        .json({
          message: "Kontak asal tidak ditemukan atau bukan milik Anda.",
        });
    }

    const contactData = originalDoc.data();

    // 2. Buat Share Token Unik
    const shareToken = crypto.randomBytes(16).toString("hex");

    // 3. Simpan ke koleksi temporary 'shared_contacts_pool'
    // Snapshot disimpan. Tidak ada expiration sesuai request.
    await db
      .collection("shared_contacts_pool")
      .doc(shareToken)
      .set({
        sharedBy: userEmail,
        sharedByName: user.nama || "User",
        originalContactId: contactId,
        contactData: contactData, // Menyimpan seluruh object kontak (termasuk foto, dll)
        createdAt: Timestamp.now(),
        // expiresAt dihapus sesuai request
      });

    // 4. Return Token
    return res.status(201).json({
      message: "Link share berhasil dibuat.",
      shareToken: shareToken,
      // Frontend bisa pakai token ini untuk link: app://share/claim?token=...
    });
  } catch (e) {
    console.error("Share Contact Error:", e);
    return res.status(500).json({ message: "Gagal membagikan kontak." });
  }
});

// ---------------------------------------------------------
// 7. CLAIM / SAVE SHARED CONTACT (Penerima menyimpan kontak)
// ---------------------------------------------------------
router.post("/claim-share/:shareToken", verifyToken, async (req, res) => {
  try {
    const user = req.user; // User yang MENERIMA/MENYIMPAN kontak
    const userEmail = user.id || user.email;
    const { shareToken } = req.params;

    // 1. Cari data di pool
    const shareDocRef = db.collection("shared_contacts_pool").doc(shareToken);
    const shareDoc = await shareDocRef.get();

    if (!shareDoc.exists) {
      return res.status(404).json({ message: "Link share tidak valid." });
    }

    const sharedData = shareDoc.data();

    // 2. Cegah menyimpan kontak milik sendiri
    if (sharedData.sharedBy === userEmail) {
      return res
        .status(400)
        .json({
          message:
            "Anda tidak bisa menyimpan kontak yang Anda bagikan sendiri.",
        });
    }

    // 3. Persiapkan data untuk disimpan ke user penerima
    const contactToSave = sharedData.contactData;

    // Generate ID baru agar tidak bentrok jika penerima sudah punya ID yg sama dr sumber lain
    const newContactId = crypto.randomUUID();

    // PENTING: Update 'idKaryawan' menjadi milik Penerima, bukan Pengirim
    let penerimaUid = user.uid || userEmail;

    const targetDocRef = db
      .collection("users")
      .doc(userEmail)
      .collection("saved_contacts")
      .doc(newContactId);

    // 4. Simpan ke koleksi user penerima
    await targetDocRef.set(
      {
        ...contactToSave,
        contactId: newContactId, // Override ID lama
        idKaryawan: penerimaUid, // Override UID pemilik (jadi milik penerima)
        savedFromShare: true, // Flag penanda
        sharedBy: sharedData.sharedBy, // Info pengirim
        syncedAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      },
      { merge: true }
    );

    return res.status(200).json({
      message: "Kontak berhasil disimpan ke daftar Anda.",
      data: {
        namaKontak: contactToSave.namaKontak,
        newId: newContactId,
      },
    });
  } catch (e) {
    console.error("Claim Share Error:", e);
    return res.status(500).json({ message: "Gagal menyimpan kontak." });
  }
});

module.exports = router;
