/* eslint-disable */

/**
 * APPLE SUBSCRIPTION SERVICE
 * ==========================
 * Menangani seluruh logic subscription Apple (StoreKit 2 + Server Notifications v2).
 *
 * Exports:
 *   verifyApplePurchase(transactionId, productId, user)  → result object
 *   handleAppleWebhook(signedPayload)                    → result object
 */

const { Timestamp } = require("firebase-admin/firestore");
const { db } = require("../config/firebase");
const { PRODUCT_BENEFITS } = require("../config/products");
const appleHelper = require("../helper/applestore");
const { resolveBenefits, isActiveState, recalculateLimits } = require("../helper/subscriptionService");

// ──────────────────────────────────────────────
// verifyApplePurchase
// ──────────────────────────────────────────────
/**
 * Verifikasi dan aktivasi subscription Apple.
 *
 * @param {string} transactionId - Transaction ID dari StoreKit
 * @param {string} productId     - e.g. "vorce_basic_month"
 * @param {object} user          - req.user dari JWT middleware { email, role, idCompany }
 *
 * @returns {{ ok: true, data: object } | { ok: false, status: number, message: string }}
 */
async function verifyApplePurchase(transactionId, productId, user) {
  // ─── A. VALIDASI PRODUCT ───
  const productConfig = PRODUCT_BENEFITS[productId];
  if (!productConfig) {
    return { ok: false, status: 400, message: `Product '${productId}' tidak dikenali.` };
  }

  // ─── B. CEK COMPANY ───
  const companyId = user.idCompany;
  if (!companyId) {
    return { ok: false, status: 403, message: "Anda belum terdaftar di perusahaan manapun." };
  }
  if (user.role !== "admin") {
    return { ok: false, status: 403, message: "Hanya Admin yang bisa membeli subscription." };
  }

  // ─── C. FRAUD CHECK: TRANSACTION ID REUSE ───
  const tokenDoc = await db
    .collection("subscription_tokens")
    .doc(`apple_${transactionId}`)
    .get();
  if (tokenDoc.exists) {
    return { ok: false, status: 409, message: "Transaksi ini sudah pernah diverifikasi." };
  }

  // ─── D. VERIFIKASI KE APPLE APP STORE SERVER API ───
  let transactionData;
  try {
    transactionData = await appleHelper.verifyAppleTransaction(transactionId);
  } catch (apiError) {
    console.error("[AppleSubscriptionService] API Error:", apiError.message);
    if (apiError.code === 404 || apiError.code === 400) {
      return { ok: false, status: 400, message: "Transaction ID tidak valid atau tidak ditemukan." };
    }
    throw apiError;
  }

  // ─── E. EXTRACT & VALIDATE ───
  const appleProductId        = transactionData.productId;
  const expiresDateMs         = transactionData.expiresDate;
  const originalTransactionId = transactionData.originalTransactionId || transactionId;
  const bundleId              = transactionData.bundleId;

  // Cegah subscription sama didaftarkan 2x
  const existingAppleSub = await db
    .collection("companies").doc(companyId)
    .collection("subscriptions")
    .where("originalTransactionId", "==", originalTransactionId)
    .where("platform", "==", "apple")
    .where("status", "in", ["active", "grace_period"])
    .limit(1).get();
  if (!existingAppleSub.empty) {
    return { ok: false, status: 409, message: "Transaksi ini sudah pernah diproses." };
  }

  // Validasi bundle ID
  if (bundleId && bundleId !== appleHelper.APPLE_BUNDLE_ID) {
    console.error(
      `[AppleSubscriptionService] Bundle ID mismatch: expected ${appleHelper.APPLE_BUNDLE_ID}, got ${bundleId}`
    );
    return { ok: false, status: 400, message: "Bundle ID tidak sesuai." };
  }

  if (appleProductId && appleProductId !== productId) {
    console.warn(`[AppleSubscriptionService] Product ID mismatch: client=${productId}, apple=${appleProductId}`);
  }

  const expiryTime = expiresDateMs ? new Date(expiresDateMs) : null;
  if (expiryTime && expiryTime < new Date()) {
    return { ok: false, status: 400, message: "Subscription sudah expired." };
  }

  // ─── F. SIMPAN KE FIRESTORE ───
  const appleSubPeriod = transactionData.subscriptionPeriod || "";
  const isYearly = appleSubPeriod.includes("year") || appleSubPeriod.includes("P1Y");
  const periodKey = isYearly ? "yearly" : "monthly";

  const benefits = resolveBenefits(productId, periodKey);
  if (!benefits) {
    return { ok: false, status: 400, message: `Tidak dapat resolve benefit untuk ${productId}/${periodKey}.` };
  }

  const now            = Timestamp.now();
  const subscriptionId = `${productId}_apple_${Date.now()}`;

  const batch = db.batch();
  batch.set(
    db.collection("companies").doc(companyId).collection("subscriptions").doc(subscriptionId),
    {
      productId, productType: benefits.type, billingPeriod: benefits.billingPeriod,
      transactionId, originalTransactionId, status: "active", platform: "apple",
      startedAt: now, expiresAt: expiryTime ? Timestamp.fromDate(expiryTime) : null,
      lastRenewedAt: now, cancelledAt: null, autoRenewing: true,
      addedStorage: benefits.addedStorage, addedKaryawan: benefits.addedKaryawan,
      maxDevices: benefits.maxDevices, purchasedBy: user.email, createdAt: now,
    }
  );
  batch.set(
    db.collection("subscription_tokens").doc(`apple_${transactionId}`),
    { companyId, subscriptionId, productId, platform: "apple", originalTransactionId, createdAt: now }
  );
  await batch.commit();

  // ─── G. RECALCULATE LIMITS ───
  await recalculateLimits(companyId);

  console.log(`[AppleSubscriptionService] ✅ Activated: ${productId} for ${companyId} by ${user.email}`);

  return {
    ok: true,
    data: {
      subscriptionId, productId, plan: benefits.name,
      productType: benefits.type, billingPeriod: benefits.billingPeriod,
      platform: "apple", status: "active",
      expiresAt: expiryTime ? expiryTime.toISOString() : null,
      addedStorage: benefits.addedStorage, addedKaryawan: benefits.addedKaryawan,
      maxDevices: benefits.maxDevices,
    },
  };
}

// ──────────────────────────────────────────────
// handleAppleWebhook
// ──────────────────────────────────────────────
/**
 * Proses Apple Server Notification v2.
 * @param {string} signedPayload - JWS payload dari Apple
 * @returns {{ ok: true, message: string } | { ok: false, status: number, message: string }}
 */
async function handleAppleWebhook(signedPayload) {
  // ─── A. DECODE NOTIFICATION PAYLOAD ───
  let notification;
  try {
    notification = await appleHelper.decodeAppleJWS(signedPayload);
  } catch (decodeError) {
    console.error("[AppleSubscriptionService] Failed to decode payload:", decodeError.message);
    return { ok: false, status: 400, message: "Invalid payload" };
  }

  const { notificationType, subtype, data } = notification;
  console.log(`[AppleSubscriptionService] Received: type=${notificationType}, subtype=${subtype || "none"}`);

  // ─── B. TEST NOTIFICATION ───
  if (notificationType === "TEST") {
    return { ok: true, message: "Test received" };
  }

  // ─── C. DECODE TRANSACTION INFO ───
  if (!data || !data.signedTransactionInfo) {
    return { ok: true, message: "No action needed" };
  }

  let transactionInfo;
  try {
    transactionInfo = await appleHelper.decodeAppleJWS(data.signedTransactionInfo);
  } catch {
    return { ok: true, message: "Decode failed, acknowledged" };
  }

  const { transactionId, originalTransactionId, productId, expiresDate } = transactionInfo;
  console.log(`[AppleSubscriptionService] Transaction: id=${transactionId}, product=${productId}`);

  // ─── D. LOOKUP SUBSCRIPTION ───
  const tokensQuery = await db
    .collection("subscription_tokens")
    .where("originalTransactionId", "==", originalTransactionId)
    .where("platform", "==", "apple")
    .limit(1).get();

  if (tokensQuery.empty) {
    console.warn("[AppleSubscriptionService] Transaction not in registry:", originalTransactionId);
    return { ok: true, message: "Transaction not tracked, acknowledged" };
  }

  const { companyId, subscriptionId: subDocId } = tokensQuery.docs[0].data();

  // ─── E. UPDATE STATUS ───
  const action     = appleHelper.getNotificationAction(notificationType);
  const expiryTime = expiresDate ? new Date(expiresDate) : null;
  const now        = Timestamp.now();

  const updateData = {
    lastAppleNotifAt: now,
    lastAppleNotifType: notificationType,
    lastAppleNotifSubtype: subtype || null,
  };

  switch (action) {
    case "activate":
    case "renew":
      updateData.status = "active";
      updateData.lastRenewedAt = now;
      if (expiryTime) updateData.expiresAt = Timestamp.fromDate(expiryTime);
      break;
    case "expire":
      updateData.status = "expired";
      updateData.expiredAt = now;
      break;
    case "revoke":
      updateData.status = "expired";
      updateData.revokedAt = now;
      break;
    case "billing_issue":
      updateData.status = subtype === "GRACE_PERIOD" ? "grace_period" : "on_hold";
      break;
    case "status_change":
      if (subtype === "AUTO_RENEW_DISABLED") {
        updateData.autoRenewing = false;
        updateData.status = "cancelled";
      } else if (subtype === "AUTO_RENEW_ENABLED") {
        updateData.autoRenewing = true;
        updateData.status = "active";
      }
      break;
    case "extend":
      updateData.status = "active";
      if (expiryTime) updateData.expiresAt = Timestamp.fromDate(expiryTime);
      break;
    default:
      console.log(`[AppleSubscriptionService] Unhandled action: ${action} for type: ${notificationType}`);
  }

  const subRef = db.collection("companies").doc(companyId).collection("subscriptions").doc(subDocId);
  const subDoc = await subRef.get();
  if (!subDoc.exists) {
    console.warn(`[AppleSubscriptionService] Sub doc ${subDocId} not found under ${companyId}`);
    return { ok: true, message: "Subscription doc not found" };
  }

  await subRef.update(updateData);

  // ─── F. RECALCULATE LIMITS ───
  await recalculateLimits(companyId);

  console.log(`[AppleSubscriptionService] ✅ Updated ${subDocId} → action: ${action}`);
  return { ok: true, message: "OK" };
}

module.exports = { verifyApplePurchase, handleAppleWebhook };
