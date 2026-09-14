/* eslint-disable */
/**
 * Migration Script: Migrate Employees from users collection to companies/{companyId}/employees/{userEmail}
 * 
 * Usage:
 *   Dry-run (preview only):
 *     node functions/scripts/migrateEmployeesToSubcollection.js --dry-run
 * 
 *   Live execution:
 *     node functions/scripts/migrateEmployeesToSubcollection.js
 */

const path = require("path");
const fs = require("fs");

// Load local Firebase service account if running locally outside Cloud Functions
const serviceAccountPath = path.resolve(__dirname, "../FirebaseServiceKey.json");
if (fs.existsSync(serviceAccountPath)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = serviceAccountPath;
}

const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");

const isDryRun = process.argv.includes("--dry-run");

const capitalize = (str) => {
  if (!str || typeof str !== "string") return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
};

const mapStatus = (rawStatus, rawRole) => {
  if (rawRole === "candidate") return "applicant";
  if (rawStatus === "fired" || rawStatus === "rejected" || rawRole === "rejected") return "terminated";
  if (rawStatus === "resigned") return "resigned";
  if (rawStatus === "active" || rawRole === "admin" || rawRole === "staff") return "active";
  return "active";
};

const mapRole = (rawRole, isOwner) => {
  if (isOwner) return "owner";
  if (rawRole === "admin") return "admin";
  return "staff";
};

async function runMigration() {
  console.log("================================================================");
  console.log(`[MIGRATION] Employee Subcollection Migration Starting...`);
  console.log(`[MIGRATION] Mode: ${isDryRun ? "DRY-RUN (Simulasi saja, tidak ada data diubah)" : "LIVE EXECUTION"}`);
  console.log("================================================================\n");

  const stats = {
    totalCompaniesScanned: 0,
    totalUsersScanned: 0,
    migrated: 0,
    skippedAlreadyExists: 0,
    skippedInvalid: 0,
    errors: [],
  };

  try {
    // 1. Ambil seluruh data companies
    const companiesSnap = await db.collection("companies").get();
    stats.totalCompaniesScanned = companiesSnap.size;
    console.log(`[INFO] Ditemukan ${stats.totalCompaniesScanned} perusahaan terdaftar.\n`);

    for (const compDoc of companiesSnap.docs) {
      const companyId = compDoc.id;
      const companyData = compDoc.data();
      const companyName = companyData.namaPerusahaan || companyId;
      const ownerEmail = companyData.createdBy;
      const ownerUid = companyData.ownerUid;

      console.log(`--- Memproses Perusahaan: ${companyName} (${companyId}) ---`);

      // 2. Query seluruh user yang terafiliasi dengan companyId
      const usersSnap = await db.collection("users")
        .where("idCompany", "==", companyId)
        .get();

      console.log(`    Ditemukan ${usersSnap.size} user terafiliasi.`);

      const processedEmails = new Set();

      // 3. Pastikan Owner Perusahaan juga tercatat di subcollection employees
      if (ownerEmail) {
        processedEmails.add(ownerEmail);
        const ownerEmpRef = db.collection("companies").doc(companyId).collection("employees").doc(ownerEmail);
        const ownerEmpSnap = await ownerEmpRef.get();

        if (ownerEmpSnap.exists) {
          stats.skippedAlreadyExists++;
          console.log(`    [SKIP] Owner ${ownerEmail} sudah terdaftar di subcollection.`);
        } else {
          const ownerUserDoc = await db.collection("users").doc(ownerEmail).get();
          const ownerUserData = ownerUserDoc.exists ? ownerUserDoc.data() : {};

          const ownerPayload = {
            userEmail: ownerEmail,
            role: "owner",
            jabatan: "Pemilik Perusahaan (Owner)",
            status: "active",
            joinDate: companyData.createdAt || (ownerUserData.createdAt || Timestamp.now()),
            leaveBalance: 12,
            shiftQuota: 0,
            config: { isOwner: true },
            createdAt: companyData.createdAt || Timestamp.now(),
            updatedAt: Timestamp.now(),
            migratedAt: Timestamp.now(),
          };

          if (!isDryRun) {
            await ownerEmpRef.set(ownerPayload, { merge: true });
          }
          stats.migrated++;
          console.log(`    [MIGRATE] Owner ${ownerEmail} berhasil dipetakan.`);
        }
      }

      // 4. Proses seluruh user terafiliasi
      for (const userDoc of usersSnap.docs) {
        stats.totalUsersScanned++;
        const email = userDoc.id;
        const userData = userDoc.data();

        // Lewati jika email tidak valid
        if (!email || !email.includes("@")) {
          stats.skippedInvalid++;
          console.warn(`    [WARN] Dokumen user ID bukan email yang valid: ${email}`);
          continue;
        }

        // Hindari duplikasi jika sudah diproses di owner step
        if (processedEmails.has(email)) {
          continue;
        }
        processedEmails.add(email);

        // Cek apakah sudah ada di subcollection
        const empRef = db.collection("companies").doc(companyId).collection("employees").doc(email);
        const empSnap = await empRef.get();

        if (empSnap.exists) {
          stats.skippedAlreadyExists++;
          console.log(`    [SKIP] Karyawan ${email} sudah ada di subcollection.`);
          continue;
        }

        const isOwner = email === ownerEmail || (ownerUid && userData.uid === ownerUid);
        const assignedRole = mapRole(userData.role, isOwner);
        const assignedStatus = mapStatus(userData.status, userData.role);
        const defaultJabatan = isOwner ? "Pemilik Perusahaan (Owner)" : capitalize(assignedRole);

        const employeePayload = {
          userEmail: email,
          role: assignedRole,
          jabatan: userData.jabatan || defaultJabatan,
          status: assignedStatus,
          joinDate: userData.createdAt || Timestamp.now(),
          leaveBalance: 12,
          shiftQuota: 0,
          config: {},
          createdAt: userData.createdAt || Timestamp.now(),
          updatedAt: Timestamp.now(),
          migratedAt: Timestamp.now(),
        };

        if (!isDryRun) {
          await empRef.set(employeePayload, { merge: true });
        }
        stats.migrated++;
        console.log(`    [MIGRATE] ${email} -> role: ${assignedRole}, status: ${assignedStatus}`);
      }

      console.log("");
    }

    console.log("================================================================");
    console.log("             MIGRATION SUMMARY REPORT                           ");
    console.log("================================================================");
    console.log(`Mode Operasi           : ${isDryRun ? "DRY-RUN (Simulasi)" : "LIVE EXECUTION"}`);
    console.log(`Perusahaan Dipindai    : ${stats.totalCompaniesScanned}`);
    console.log(`User Dipindai          : ${stats.totalUsersScanned}`);
    console.log(`Berhasil Dimigrasi     : ${stats.migrated}`);
    console.log(`Dilewati (Sudah Ada)   : ${stats.skippedAlreadyExists}`);
    console.log(`Dilewati (Tidak Valid) : ${stats.skippedInvalid}`);
    console.log(`Total Error            : ${stats.errors.length}`);
    console.log("================================================================\n");

    if (isDryRun) {
      console.log("💡 Jalankan tanpa flag --dry-run untuk menerapkan migrasi ke database riil.");
    } else {
      console.log("✅ Migrasi selesai secara aman dan idempotent.");
    }

    return stats;
  } catch (err) {
    console.error("[FATAL ERROR] Migrasi gagal:", err);
    throw err;
  }
}

// Jalankan jika dipanggil via CLI
if (require.main === module) {
  runMigration()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { runMigration };
