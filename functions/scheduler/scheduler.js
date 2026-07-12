/* eslint-disable */
const admin = require("firebase-admin");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { db } = require("../config/firebase");
const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { r2 } = require("../config/r2");
const BUCKET_NAME = "vorce";

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
          // 1. Log ke company (jika user punya perusahaan)
          const companyId = userData.previousCompany || userData.idCompany;
          if (companyId) {
            try {
              const { Timestamp: FsTimestamp } = require("firebase-admin/firestore");
              await db
                .collection("companies")
                .doc(companyId)
                .collection("logs")
                .add({
                  actorEmail: "system",
                  actorName: "Sistem Otomatis",
                  target: email,
                  action: "EMPLOYEE_PERMANENT_DELETE",
                  description: `Akun karyawan ${userData.username || email} telah dihapus permanen oleh sistem (90 hari setelah request).`,
                  createdAt: FsTimestamp.now(),
                });
            } catch (logErr) {
              console.error(`[Scheduler] ⚠️ Failed to log company activity for ${email}:`, logErr.message);
            }
          }

          // 2. Hapus dari Firebase Auth (jika uid ada)
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

          // 3. Hapus document user dari Firestore
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

/**
 * ORPHAN UPLOAD CLEANUP
 * Jalan otomatis setiap jam.
 *
 * Strategi: Upload Registry (Firestore collection _upload_pending)
 * ------------------------------------------------------------------
 * Saat FE memanggil POST /berkas/presign, API menulis doc ke
 * _upload_pending/{uuid} dengan field expiresAt = now + 15 menit.
 *
 * Skenario orphan:
 *   - FE crash / network error setelah upload ke R2 tapi sebelum /confirm-upload
 *   - FE tidak pernah memanggil /confirm-upload (expired)
 *
 * Job ini:
 *   1. Query _upload_pending dimana expiresAt <= now
 *   2. Untuk setiap entry expired: delete objectKey dari R2 (best-effort)
 *   3. Delete doc dari _upload_pending
 *
 * Trade-off:
 *   - Lebih simpel dari R2 Event Notification (tidak perlu Cloudflare Worker/Queue)
 *   - Ada jeda max 1 jam sebelum orphan dibersihkan (acceptable)
 *   - Tidak perlu listing R2 bucket (hemat R2 API calls)
 */
const cleanupOrphanUploads = onSchedule(
  {
    schedule: "0 * * * *", // Setiap jam
    region: "asia-southeast2",
    timeZone: "UTC",
    memory: "256MiB",
    timeoutSeconds: 120,
  },
  async (event) => {
    console.log("[OrphanCleanup] Starting orphan upload cleanup...");

    try {
      const now = admin.firestore.Timestamp.now();

      const snapshot = await db
        .collection("_upload_pending")
        .where("expiresAt", "<=", now)
        .limit(100) // Batasi per-run agar tidak timeout
        .get();

      if (snapshot.empty) {
        console.log("[OrphanCleanup] No orphan uploads found.");
        return;
      }

      console.log(`[OrphanCleanup] Found ${snapshot.size} expired pending upload(s).`);

      let deletedFromR2 = 0;
      let notFoundInR2 = 0;
      let failCount = 0;

      for (const doc of snapshot.docs) {
        const { objectKey } = doc.data();
        try {
          // Hapus dari R2 (best-effort: jika sudah tidak ada, tetap lanjut)
          await r2.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: objectKey }));
          deletedFromR2++;
          console.log(`[OrphanCleanup] ✅ R2 deleted: ${objectKey}`);
        } catch (r2Err) {
          // NoSuchKey berarti file memang tidak ada (user gagal upload), tetap hapus registry
          if (r2Err.Code === "NoSuchKey" || r2Err.$metadata?.httpStatusCode === 404) {
            notFoundInR2++;
            console.log(`[OrphanCleanup] ⚠️ Not in R2 (already gone): ${objectKey}`);
          } else {
            failCount++;
            console.error(`[OrphanCleanup] ❌ R2 delete failed for ${objectKey}:`, r2Err.message);
          }
        }

        // Hapus registry doc (apapun hasil R2 delete)
        await doc.ref.delete();
      }

      console.log(
        `[OrphanCleanup] Done. R2 deleted: ${deletedFromR2}, not in R2: ${notFoundInR2}, errors: ${failCount}`
      );
    } catch (error) {
      console.error("[OrphanCleanup] Critical error:", error);
    }
  }
);

module.exports = { scheduledAccountCleanup, cleanupOrphanUploads };


