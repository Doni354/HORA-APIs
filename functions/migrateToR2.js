const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const admin = require("firebase-admin");
require("dotenv").config();
process.env.GOOGLE_APPLICATION_CREDENTIALS = './GoogleApiKey.json';

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    storageBucket: "hora-7394b.firebasestorage.app",
  });
}
const bucket = admin.storage().bucket();

// Initialize R2
const r2 = new S3Client({
  region: "auto",
  endpoint: "https://609723b5d7cc16b02d6454eebea06c5a.r2.cloudflarestorage.com",
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const BUCKET_NAME = "vorce";

async function migrateFiles() {
  console.log("Starting file migration from Firebase Storage to R2...");
  
  try {
    const [files] = await bucket.getFiles();
    console.log(`Found ${files.length} files to migrate.`);

    let successCount = 0;
    let failCount = 0;

    // We process in small batches to not overwhelm memory or network
    const BATCH_SIZE = 10;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      
      await Promise.all(batch.map(async (file) => {
        try {
          const filePath = file.name;
          const [metadata] = await file.getMetadata();
          const contentType = metadata.contentType || "application/octet-stream";

          // Download from Firebase
          const [buffer] = await file.download();

          // Upload to R2
          await r2.send(
            new PutObjectCommand({
              Bucket: BUCKET_NAME,
              Key: filePath,
              Body: buffer,
              ContentType: contentType,
            })
          );
          
          successCount++;
          console.log(`[OK] Migrated: ${filePath}`);
        } catch (err) {
          failCount++;
          console.error(`[FAIL] Failed to migrate ${file.name}:`, err.message);
        }
      }));
    }

    console.log(`\nMigration completed!`);
    console.log(`Successful: ${successCount}`);
    console.log(`Failed: ${failCount}`);

  } catch (err) {
    console.error("Error during migration:", err);
  }
}

migrateFiles();
