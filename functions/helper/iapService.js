/* eslint-disable */

/**
 * IAP SERVICE
 * ===========
 * Menangani one-time IAP (consumable) purchase — token AI, dll.
 * Dipanggil oleh route POST /api/subscription/verify-iap
 *
 * Exports:
 *   processIAPPurchase(transactionId, productId, platform, user) → result object
 */

const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const { db } = require("../config/firebase");
const { IAP_PRODUCTS } = require("../config/products");

/**
 * Proses pembelian IAP one-time (consumable).
 *
 * @param {string} transactionId - ID transaksi dari Google Play / Apple
 * @param {string} productId     - e.g. "mitsu_ai_token_1"
 * @param {string} platform      - "google_play" | "apple"
 * @param {object} user          - req.user dari JWT middleware { email }
 *
 * @returns {{ ok: true, data: object } | { ok: false, status: number, message: string }}
 */
async function processIAPPurchase(transactionId, productId, platform, user) {
  const resolvedPlatform = platform || "google_play";

  // ─── A. VALIDASI PRODUCT ───
  const iapConfig = IAP_PRODUCTS[productId];
  if (!iapConfig) {
    return { ok: false, status: 400, message: `Product IAP '${productId}' tidak dikenali.` };
  }

  // ─── B. FRAUD CHECK: TRANSACTION REUSE ───
  const iapTokenRef = db.collection("iap_tokens").doc(`${resolvedPlatform}_${transactionId}`);
  const iapTokenDoc = await iapTokenRef.get();
  if (iapTokenDoc.exists) {
    return { ok: false, status: 409, message: "Transaksi ini sudah pernah diproses." };
  }

  // ─── C. LOOKUP USER ───
  const email = user.email;
  if (!email) {
    return { ok: false, status: 403, message: "Email user tidak ditemukan di token." };
  }

  const userRef = db.collection("users").doc(email);
  const userDoc = await userRef.get();
  if (!userDoc.exists) {
    return { ok: false, status: 404, message: "User tidak ditemukan di database." };
  }

  const uid = userDoc.data().uid || email;

  // ─── D. ATOMIC WRITE: CREDITS + LOG + FRAUD REGISTRY ───
  const now    = Timestamp.now();
  const logRef = userRef.collection("log_token").doc(); // auto-ID

  const batch = db.batch();

  // 1. Tambah paid_credits_remaining (dibuat otomatis kalau belum ada)
  batch.set(userRef, {
    paid_credits_remaining: FieldValue.increment(iapConfig.creditAmount),
  }, { merge: true });

  // 2. Log transaksi
  batch.set(logRef, {
    amount: iapConfig.creditAmount,
    createdAt: now,
    receivedTo: uid,
    timestamp: now,
    transactionId,
    type: "purchase",
    productId,
    platform: resolvedPlatform,
  });

  // 3. Fraud registry
  batch.set(iapTokenRef, {
    uid, email, productId,
    creditAmount: iapConfig.creditAmount,
    platform: resolvedPlatform,
    processedAt: now,
  });

  await batch.commit();

  console.log(
    `[IAPService] ✅ Purchase processed: ${productId} for email=${email} uid=${uid}, ` +
      `+${iapConfig.creditAmount} credits, txId=${transactionId}`
  );

  return {
    ok: true,
    data: {
      productId,
      description: iapConfig.description,
      creditAdded: iapConfig.creditAmount,
      transactionId,
      type: "purchase",
    },
  };
}

module.exports = { processIAPPurchase };
