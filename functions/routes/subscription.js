/* eslint-disable */

/**
 * SUBSCRIPTION ROUTES
 * ====================
 * Thin router — hanya menangani HTTP layer (validasi input, response).
 * Semua business logic didelegasikan ke service modules:
 *
 *   helper/googlePlayService.js      → POST /verify
 *   helper/subscriptionService.js    → GET  /status  (isActiveState, BASE_MAX_STORAGE)
 *   helper/appleSubscriptionService.js → POST /verify-apple, POST /apple-webhook
 *   helper/iapService.js             → POST /verify-iap
 *
 * Untuk menambah produk baru → edit config/products.js
 * Untuk mengubah logika suatu platform → edit service-nya masing-masing
 */

const express = require("express");
const { db } = require("../config/firebase");
const { verifyToken } = require("../middleware/token");
const { BASE_MAX_STORAGE } = require("../helper/playstore");
const { isActiveState } = require("../helper/subscriptionService");
const { verifyGooglePlayPurchase } = require("../helper/googlePlayService");
const { verifyApplePurchase, handleAppleWebhook } = require("../helper/appleSubscriptionService");
const { processIAPPurchase } = require("../helper/iapService");

const router = express.Router();

// ==================================================================
// 1. VERIFY SUBSCRIPTION — Google Play
// ==================================================================
/**
 * POST /api/subscription/verify
 * Body: { purchaseToken, productId }
 */
router.post("/verify", verifyToken, async (req, res) => {
  try {
    const { purchaseToken, productId } = req.body;
    if (!purchaseToken || !productId) {
      return res.status(400).json({ message: "purchaseToken dan productId wajib diisi." });
    }

    const result = await verifyGooglePlayPurchase(purchaseToken, productId, req.user);

    if (!result.ok) return res.status(result.status).json({ message: result.message });
    return res.status(200).json({ message: "Subscription berhasil diaktifkan!", data: result.data });
  } catch (e) {
    console.error("[Route/verify] Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

// ==================================================================
// 2. STATUS SUBSCRIPTION
// ==================================================================
/**
 * GET /api/subscription/status
 * Response: { subscriptions, totalAddedStorage, baseLimits }
 */
router.get("/status", verifyToken, async (req, res) => {
  try {
    const companyId = req.user.idCompany;
    if (!companyId) {
      return res.status(403).json({ message: "Anda belum terdaftar di perusahaan manapun." });
    }

    const subsSnapshot = await db
      .collection("companies").doc(companyId)
      .collection("subscriptions")
      .orderBy("createdAt", "desc").get();

    const subscriptions = [];
    let totalAddedStorage = 0;

    subsSnapshot.forEach((doc) => {
      const data = doc.data();
      subscriptions.push({
        id: doc.id,
        productId: data.productId,
        productType: data.productType || null,
        billingPeriod: data.billingPeriod || null,
        status: data.status,
        autoRenewing: data.autoRenewing,
        expiresAt: data.expiresAt?.toDate?.()?.toISOString() || null,
        addedStorage: data.addedStorage,
        addedKaryawan: data.addedKaryawan,
        startedAt: data.startedAt?.toDate?.()?.toISOString() || null,
      });

      if (isActiveState(data.status)) totalAddedStorage += data.addedStorage || 0;
    });

    return res.status(200).json({
      subscriptions,
      totalAddedStorage,
      baseLimits: { maxStorage: BASE_MAX_STORAGE },
    });
  } catch (e) {
    console.error("[Route/status] Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

// ==================================================================
// 3. VERIFY SUBSCRIPTION — Apple (StoreKit 2)
// ==================================================================
/**
 * POST /api/subscription/verify-apple
 * Body: { transactionId, productId }
 */
router.post("/verify-apple", verifyToken, async (req, res) => {
  try {
    const { transactionId, productId } = req.body;
    if (!transactionId || !productId) {
      return res.status(400).json({ message: "transactionId dan productId wajib diisi." });
    }

    const result = await verifyApplePurchase(transactionId, productId, req.user);

    if (!result.ok) return res.status(result.status).json({ message: result.message });
    return res.status(200).json({ message: "Subscription Apple berhasil diaktifkan!", data: result.data });
  } catch (e) {
    console.error("[Route/verify-apple] Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

// ==================================================================
// 4. APPLE SERVER NOTIFICATION v2 WEBHOOK
// ==================================================================
/**
 * POST /api/subscription/apple-webhook
 * Body: { signedPayload }
 *
 * Apple selalu expects 200 — jangan return 4xx/5xx atau Apple akan retry terus.
 */
router.post("/apple-webhook", async (req, res) => {
  try {
    const { signedPayload } = req.body;
    if (!signedPayload) {
      console.warn("[Route/apple-webhook] Empty payload");
      return res.status(400).json({ message: "Missing signedPayload" });
    }

    const result = await handleAppleWebhook(signedPayload);

    // Apple expects 200 regardless of internal result
    return res.status(result.ok ? 200 : 200).json({ message: result.message });
  } catch (e) {
    console.error("[Route/apple-webhook] Error:", e);
    return res.status(200).json({ message: "Error processed" });
  }
});

// ==================================================================
// 5. VERIFY IAP — One-Time Purchase (Google Play & Apple)
// ==================================================================
/**
 * POST /api/subscription/verify-iap
 * Body: { transactionId, productId, platform? }
 *
 * Produk tersedia: mitsu_ai_token_1 s/d mitsu_ai_token_5
 * Dikelola di config/products.js
 */
router.post("/verify-iap", verifyToken, async (req, res) => {
  try {
    const { transactionId, productId, platform } = req.body;
    if (!transactionId || !productId) {
      return res.status(400).json({ message: "transactionId dan productId wajib diisi." });
    }

    const result = await processIAPPurchase(transactionId, productId, platform, req.user);

    if (!result.ok) return res.status(result.status).json({ message: result.message });
    return res.status(200).json({ message: "Pembelian token berhasil diproses!", data: result.data });
  } catch (e) {
    console.error("[Route/verify-iap] Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

module.exports = router;
