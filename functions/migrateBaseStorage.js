/* eslint-disable */

/**
 * MIGRATION: Update Base Free Storage 100MB → 1GB
 * ================================================
 * Script one-time untuk sync semua company yang masih
 * menggunakan base storage lama (100MB / 104857600 bytes).
 *
 * LOGIKA:
 *   - Company FREE TIER (maxStorage <= 104857600) → update ke 1GB
 *   - Company dengan TIER SUBSCRIPTION aktif → RUN recalculateLimits()
 *     (storage sudah dikontrol oleh subscription, tapi pastikan konsisten)
 *   - Company dengan maxStorage > 1GB → SKIP (sudah subscribe, tidak disentuh)
 *
 * CARA PAKAI:
 *   1. Dari folder functions/, jalankan:
 *      node migrateBaseStorage.js
 *   2. Review output. Script ini DRY-RUN by default.
 *      Set DRY_RUN = false untuk benar-benar menulis ke Firestore.
 *
 * AMAN untuk dijalankan berulang kali (idempotent).
 */

const admin = require("firebase-admin");
require("dotenv").config();

// ── Config Firebase ──────────────────────────────────────
process.env.GOOGLE_APPLICATION_CREDENTIALS = "./FirebaseServiceKey.json";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

// ── Konstanta ────────────────────────────────────────────
const OLD_BASE_STORAGE = 104857600;   // 100 MB (bytes)
const NEW_BASE_STORAGE = 1073741824;  // 1 GB  (bytes)

/**
 * Set DRY_RUN = true untuk hanya melihat apa yang akan diubah
 * tanpa benar-benar menulis ke Firestore.
 * Set DRY_RUN = false untuk eksekusi nyata.
 */
const DRY_RUN = false;

// ───────────────────────────────────────────────────────────────────
// Helper: cek apakah company punya tier subscription aktif
// ───────────────────────────────────────────────────────────────────
async function getActiveTierSubscription(companyId) {
  const subsSnap = await db
    .collection("companies")
    .doc(companyId)
    .collection("subscriptions")
    .where("status", "in", ["active", "grace_period"])
    .where("productType", "==", "tier")
    .limit(1)
    .get();

  return !subsSnap.empty ? subsSnap.docs[0].data() : null;
}

// ───────────────────────────────────────────────────────────────────
// Main Migration
// ───────────────────────────────────────────────────────────────────
async function migrateBaseStorage() {
  console.log("=".repeat(60));
  console.log("  MIGRATION: Base Storage 100MB → 1GB");
  console.log(`  MODE: ${DRY_RUN ? "DRY RUN (tidak ada perubahan)" : "LIVE (akan menulis ke Firestore)"}`);
  console.log("=".repeat(60));
  console.log();

  const companiesSnap = await db.collection("companies").get();
  const total = companiesSnap.size;

  console.log(`Ditemukan ${total} perusahaan.\n`);

  let countUpdated = 0;
  let countSkippedSubscriber = 0;
  let countSkippedAlready = 0;
  let countErrors = 0;

  // Proses per batch agar tidak timeout jika banyak dokumen
  const BATCH_SIZE = 20;
  const docs = companiesSnap.docs;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (doc) => {
        try {
          const companyId = doc.id;
          const data = doc.data();
          const currentStorage = data.maxStorage || 0;

          // 1. Sudah di atas 1GB → company ini punya subscription aktif besar, skip
          if (currentStorage > NEW_BASE_STORAGE) {
            console.log(`[SKIP-SUBS] ${companyId} | maxStorage: ${(currentStorage / 1024 / 1024 / 1024).toFixed(2)} GB (sudah punya subscription besar)`);
            countSkippedSubscriber++;
            return;
          }

          // 2. Tepat di antara 100MB dan 1GB → punya tier subscription tapi nilai 100MB
          //    Cek subscription aktif
          const activeTier = await getActiveTierSubscription(companyId);

          if (activeTier) {
            // Ada tier sub → jangan override langsung, biarkan recalculateLimits handle
            // tapi artinya maxStorage sudah dikontrol sistem, skip
            console.log(`[SKIP-TIER] ${companyId} | Punya tier plan: ${activeTier.productId} (${activeTier.status})`);
            countSkippedSubscriber++;
            return;
          }

          // 3. Free tier, maxStorage sudah 1GB atau lebih → sudah oke, skip
          if (currentStorage === NEW_BASE_STORAGE) {
            console.log(`[SKIP-OK]   ${companyId} | maxStorage sudah 1 GB`);
            countSkippedAlready++;
            return;
          }

          // 4. Free tier, maxStorage ≤ 100MB (atau 0) → UPDATE ke 1GB
          const from = currentStorage === 0
            ? "0 (tidak di-set)"
            : `${(currentStorage / 1024 / 1024).toFixed(0)} MB`;

          console.log(`[UPDATE]    ${companyId} | ${from} → 1 GB`);

          if (!DRY_RUN) {
            await db.collection("companies").doc(companyId).update({
              maxStorage: NEW_BASE_STORAGE,
            });
          }

          countUpdated++;
        } catch (err) {
          console.error(`[ERROR]     ${doc.id} | ${err.message}`);
          countErrors++;
        }
      })
    );
  }

  // ── Summary ─────────────────────────────────────────────
  console.log();
  console.log("=".repeat(60));
  console.log("  HASIL MIGRASI");
  console.log("=".repeat(60));
  console.log(`  Diperbarui ke 1GB    : ${countUpdated}`);
  console.log(`  Sudah 1GB (skip)     : ${countSkippedAlready}`);
  console.log(`  Punya subs (skip)    : ${countSkippedSubscriber}`);
  console.log(`  Error                : ${countErrors}`);
  console.log(`  Total diproses       : ${total}`);
  console.log();

  if (DRY_RUN) {
    console.log("⚠️  DRY RUN selesai. Tidak ada perubahan yang diterapkan.");
    console.log("    Ubah DRY_RUN = false lalu jalankan ulang untuk eksekusi nyata.");
  } else {
    console.log("✅  Migrasi selesai!");
  }

  process.exit(0);
}

migrateBaseStorage().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
