/* eslint-disable */
const admin = require("firebase-admin");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { db } = require("../config/firebase");

/**
 * SCHEDULED ACCOUNT CLEANUP
 * Jalan otomatis setiap hari jam 02:00 WIB (19:00 UTC)
 * Menghapus akun yang sudah melewati 90 hari sejak request deletion.
 *
 * Yang dihapus:
 * 1. Document user di Firestore (collection "users")
 * 2. Akun di Firebase Auth (admin.auth().deleteUser)
 */
const scheduledAccountCleanup = onSchedule(
  {
    schedule: "0 19 * * *", // UTC 19:00 = WIB 02:00
    region: "asia-southeast2",
    timeZone: "UTC",
    memory: "256MiB",
    timeoutSeconds: 120,
  },
  async (event) => {
    console.log("[Scheduler] Starting account cleanup job...");

    try {
      const now = admin.firestore.Timestamp.now();

      // Query semua user yang pending_deletion DAN sudah lewat jadwal
      const snapshot = await db
        .collection("users")
        .where("status", "==", "pending_deletion")
        .where("deletionScheduledAt", "<=", now)
        .get();

      if (snapshot.empty) {
        console.log("[Scheduler] No accounts to delete. Job done.");
        return;
      }

      console.log(
        `[Scheduler] Found ${snapshot.size} account(s) to permanently delete.`
      );

      let successCount = 0;
      let failCount = 0;

      for (const doc of snapshot.docs) {
        const email = doc.id;
        const userData = doc.data();
        const uid = userData.uid;

        try {
          // 1. Hapus dari Firebase Auth (jika uid ada)
          if (uid) {
            try {
              await admin.auth().deleteUser(uid);
              console.log(`[Scheduler] ✅ Auth deleted: ${email} (uid: ${uid})`);
            } catch (authErr) {
              // Jika user tidak ditemukan di Auth, lanjut aja (mungkin sudah dihapus manual)
              if (authErr.code === "auth/user-not-found") {
                console.log(
                  `[Scheduler] ⚠️ Auth user not found (skip): ${email}`
                );
              } else {
                throw authErr;
              }
            }
          }

          // 2. Hapus document user dari Firestore
          await db.collection("users").doc(email).delete();
          console.log(`[Scheduler] ✅ Firestore deleted: ${email}`);

          successCount++;
        } catch (err) {
          console.error(
            `[Scheduler] ❌ Failed to delete ${email}:`,
            err.message
          );
          failCount++;
        }
      }

      console.log(
        `[Scheduler] Job complete. Success: ${successCount}, Failed: ${failCount}`
      );
    } catch (error) {
      console.error("[Scheduler] Critical error in cleanup job:", error);
    }
  }
);

module.exports = { scheduledAccountCleanup };
