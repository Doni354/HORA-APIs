/* eslint-disable */

/**
 * GOOGLE PLAY SERVICE
 * ====================
 * Menangani seluruh logic verifikasi subscription Google Play.
 * Dipanggil oleh route POST /api/subscription/verify
 *
 * Exports:
 *   verifyGooglePlayPurchase(purchaseToken, productId, user) → result object
 */

const { Timestamp } = require("firebase-admin/firestore");
const { db } = require("../config/firebase");
const { PRODUCT_BENEFITS } = require("../config/products");
const { verifySubscription, acknowledgeSubscription } = require("../helper/playstore");
const { resolveBenefits, mapSubscriptionState, isActiveState, recalculateLimits } = require("../helper/subscriptionService");

/**
 * Verifikasi dan aktivasi subscription Google Play.
 *
 * @param {string} purchaseToken  - Token dari Google Play
 * @param {string} productId      - e.g. "vorce_basic"
 * @param {object} user           - req.user dari JWT middleware
 *   { email, role, idCompany }
 *
 * @returns {{ ok: true, data: object } | { ok: false, status: number, message: string }}
 */
async function verifyGooglePlayPurchase(purchaseToken, productId, user) {
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

  // ─── C. FRAUD CHECK: TOKEN REUSE ───
  const tokenDoc = await db.collection("subscription_tokens").doc(purchaseToken).get();
  if (tokenDoc.exists) {
    return { ok: false, status: 409, message: "Token ini sudah pernah diverifikasi." };
  }

  // ─── D. VERIFIKASI KE GOOGLE PLAY API ───
  let subscriptionData;
  try {
    subscriptionData = await verifySubscription(purchaseToken);
  } catch (apiError) {
    console.error("[GooglePlayService] API Error:", apiError.message);
    if (apiError.code === 404 || apiError.code === 400) {
      return { ok: false, status: 400, message: "Purchase token tidak valid atau sudah kadaluarsa." };
    }
    throw apiError;
  }

  // ─── E. CEK STATUS ───
  const status = mapSubscriptionState(subscriptionData.subscriptionState);
  if (!isActiveState(status)) {
    return { ok: false, status: 400, message: `Subscription tidak aktif. Status: ${status}` };
  }

  // ─── F. EXTRACT DATA ───
  const lineItem    = subscriptionData.lineItems?.[0] || {};
  const expiryTime  = lineItem.expiryTime ? new Date(lineItem.expiryTime) : null;
  const autoRenewing = !!lineItem.autoRenewingPlan;
  const basePlanId  = lineItem.offerDetails?.basePlanId || "monthly";
  const orderId     = subscriptionData.latestOrderId || null;

  const benefits = resolveBenefits(productId, basePlanId);
  if (!benefits) {
    return { ok: false, status: 400, message: `Tidak dapat resolve benefit untuk ${productId}/${basePlanId}.` };
  }

  // ─── FRAUD CHECK: ORDER ID REUSE ───
  if (orderId) {
    const existingOrder = await db
      .collection("companies").doc(companyId)
      .collection("subscriptions")
      .where("orderId", "==", orderId).limit(1).get();
    if (!existingOrder.empty) {
      return { ok: false, status: 409, message: "Order ini sudah pernah diproses." };
    }
  }

  // ─── G. ACKNOWLEDGE ───
  const ackState = subscriptionData.acknowledgementState;
  if (ackState !== "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED") {
    try {
      const actualProductId = lineItem.productId || productId;
      await acknowledgeSubscription(purchaseToken, actualProductId);
      console.log(`[GooglePlayService] Acknowledged: ${purchaseToken.substring(0, 20)}...`);
    } catch (ackError) {
      console.error("[GooglePlayService] Acknowledge failed:", ackError.message);
    }
  }

  // ─── H. SIMPAN KE FIRESTORE ───
  const now            = Timestamp.now();
  const subscriptionId = `${productId}_${Date.now()}`;

  const subscriptionDoc = {
    productId, productType: benefits.type, billingPeriod: benefits.billingPeriod,
    basePlanId, purchaseToken, status, platform: "google_play",
    startedAt: now, expiresAt: expiryTime ? Timestamp.fromDate(expiryTime) : null,
    lastRenewedAt: now, cancelledAt: null, autoRenewing, orderId,
    addedStorage: benefits.addedStorage, addedKaryawan: benefits.addedKaryawan,
    maxDevices: benefits.maxDevices, acknowledgedAt: now,
    purchasedBy: user.email, createdAt: now,
  };

  const batch = db.batch();
  batch.set(
    db.collection("companies").doc(companyId).collection("subscriptions").doc(subscriptionId),
    subscriptionDoc
  );
  batch.set(db.collection("subscription_tokens").doc(purchaseToken), {
    companyId, subscriptionId, productId, createdAt: now,
  });
  await batch.commit();

  // ─── I. RECALCULATE LIMITS ───
  await recalculateLimits(companyId);

  console.log(`[GooglePlayService] ✅ Activated: ${productId} for ${companyId} by ${user.email}`);

  return {
    ok: true,
    data: {
      subscriptionId, productId, plan: benefits.name,
      productType: benefits.type, billingPeriod: benefits.billingPeriod,
      status, expiresAt: expiryTime ? expiryTime.toISOString() : null,
      addedStorage: benefits.addedStorage, addedKaryawan: benefits.addedKaryawan,
      maxDevices: benefits.maxDevices,
    },
  };
}

module.exports = { verifyGooglePlayPurchase };
