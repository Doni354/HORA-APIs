/* eslint-disable */

/**
 * SUBSCRIPTION ROUTES
 * ====================
 * Module ini menangani operasi subscription Google Play dari client (Flutter):
 *
 * 1. POST /verify     — Verifikasi & aktivasi subscription dari purchaseToken
 * 2. GET  /status     — Cek status subscription aktif untuk company
 *
 * NOTE: RTDN (Real-time Developer Notifications) di-handle terpisah
 * oleh Pub/Sub trigger di scheduler/subscription.js — bukan di sini.
 *
 * FLOW UTAMA (verify):
 * Flutter kirim purchaseToken → Backend verifikasi ke Google Play API
 * → Cek fraud → Acknowledge → Simpan ke Firestore → Update company limits
 */

const express = require("express");
const { Timestamp } = require("firebase-admin/firestore");
const { db } = require("../config/firebase");
const { verifyToken } = require("../middleware/token");
const {
  verifySubscription,
  acknowledgeSubscription,
  BASE_MAX_STORAGE,
  BASE_MAX_KARYAWAN,
} = require("../helper/playstore");

const router = express.Router();

// ──────────────────────────────────────────────
// PRODUCT CONFIG
// ──────────────────────────────────────────────
// Mapping productId → benefit yang diberikan
// Ini menentukan berapa storage dan karyawan yang ditambahkan
// saat subscription aktif.
//
// Kenapa hardcode di sini dan bukan di Firestore?
// → Untuk fase awal ini lebih simpel. Nanti kalau produk semakin banyak,
//   bisa dipindah ke collection `subscription_products` di Firestore.
//
// PENTING: Tambahkan entry baru di sini setiap kali buat subscription
// baru di Google Play Console / App Store Connect.
//
// TYPE:
//   "tier"  = Plan utama (exclusive, 1 aktif). MENGGANTIKAN free tier.
//   "addon" = Storage tambahan (stackable, bisa banyak bareng).
//
// GOOGLE PLAY: 1 productId + basePlanId (monthly/yearly) → resolve via resolveBenefits()
// APPLE: productId terpisah per period (e.g. vorce_basic_month, vorce_basic_year)
//
// ──────────────────────────────────────────────
// A. GOOGLE PLAY PRODUCT IDS
//    basePlanId ("monthly"/"yearly") dari lineItems[0].offerDetails.basePlanId
// ──────────────────────────────────────────────
const PRODUCT_BENEFITS = {
  // ── TIER PLANS (Google Play) ──
  vorce_basic: {
    name: "Basic Plan", type: "tier",
    monthly: { addedStorage: 1073741824, addedKaryawan: 10 },       // 1 GB
    yearly:  { addedStorage: 12884901888, addedKaryawan: 10 },      // 12 GB
  },
  vorce_team: {
    name: "Team Plan", type: "tier",
    monthly: { addedStorage: 3221225472, addedKaryawan: 30 },       // 3 GB
    yearly:  { addedStorage: 38654705664, addedKaryawan: 30 },      // 36 GB
  },
  vorce_business: {
    name: "Business Plan", type: "tier",
    monthly: { addedStorage: 10737418240, addedKaryawan: 100 },     // 10 GB
    yearly:  { addedStorage: 128849018880, addedKaryawan: 100 },    // 120 GB
  },
  vorce_enterprise: {
    name: "Enterprise Plan", type: "tier",
    monthly: { addedStorage: 32212254720, addedKaryawan: 300 },     // 30 GB
    yearly:  { addedStorage: 386547056640, addedKaryawan: 300 },    // 360 GB
  },
  // ── STORAGE ADDONS (Google Play) ──
  vorce_storage_1: {
    name: "Storage Addon 3GB", type: "addon",
    monthly: { addedStorage: 3221225472, addedKaryawan: 0 },        // 3 GB
    yearly:  { addedStorage: 38654705664, addedKaryawan: 0 },       // 36 GB
  },
  vorce_storage_2: {
    name: "Storage Addon 10GB", type: "addon",
    monthly: { addedStorage: 10737418240, addedKaryawan: 0 },       // 10 GB
    yearly:  { addedStorage: 128849018880, addedKaryawan: 0 },      // 120 GB
  },
  vorce_storage_3: {
    name: "Storage Addon 30GB", type: "addon",
    monthly: { addedStorage: 32212254720, addedKaryawan: 0 },       // 30 GB
    yearly:  { addedStorage: 386547056640, addedKaryawan: 0 },      // 360 GB
  },
  vorce_storage_4: {
    name: "Storage Addon 60GB", type: "addon",
    monthly: { addedStorage: 64424509440, addedKaryawan: 0 },       // 60 GB
    yearly:  { addedStorage: 773094113280, addedKaryawan: 0 },      // 720 GB
  },

  // ──────────────────────────────────────────────
  // B. APPLE PRODUCT IDS
  //    Apple pakai productId terpisah per period (bukan basePlanId)
  //    Setiap entry hanya punya 1 period key
  // ──────────────────────────────────────────────

  // ── TIER PLANS (Apple) ──
  vorce_basic_month:      { name: "Basic Plan", type: "tier",
    monthly: { addedStorage: 1073741824, addedKaryawan: 10 } },       // 1 GB
  vorce_basic_year:       { name: "Basic Plan", type: "tier",
    yearly:  { addedStorage: 12884901888, addedKaryawan: 10 } },      // 12 GB
  vorce_team_month:       { name: "Team Plan", type: "tier",
    monthly: { addedStorage: 3221225472, addedKaryawan: 30 } },       // 3 GB
  vorce_team_year:        { name: "Team Plan", type: "tier",
    yearly:  { addedStorage: 38654705664, addedKaryawan: 30 } },      // 36 GB
  vorce_business_month:   { name: "Business Plan", type: "tier",
    monthly: { addedStorage: 10737418240, addedKaryawan: 100 } },     // 10 GB
  vorce_business_year:    { name: "Business Plan", type: "tier",
    yearly:  { addedStorage: 128849018880, addedKaryawan: 100 } },    // 120 GB
  vorce_enterprise_month: { name: "Enterprise Plan", type: "tier",
    monthly: { addedStorage: 32212254720, addedKaryawan: 300 } },     // 30 GB
  vorce_enterprise_year:  { name: "Enterprise Plan", type: "tier",
    yearly:  { addedStorage: 386547056640, addedKaryawan: 300 } },    // 360 GB

  // ── STORAGE ADDONS (Apple) ──
  vorce_storage_1_month:  { name: "Storage Addon 3GB", type: "addon",
    monthly: { addedStorage: 3221225472, addedKaryawan: 0 } },        // 3 GB
  vorce_storage_1_year:   { name: "Storage Addon 3GB", type: "addon",
    yearly:  { addedStorage: 38654705664, addedKaryawan: 0 } },       // 36 GB
  vorce_storage_2_month:  { name: "Storage Addon 10GB", type: "addon",
    monthly: { addedStorage: 10737418240, addedKaryawan: 0 } },       // 10 GB
  vorce_storage_2_year:   { name: "Storage Addon 10GB", type: "addon",
    yearly:  { addedStorage: 128849018880, addedKaryawan: 0 } },      // 120 GB
  vorce_storage_3_month:  { name: "Storage Addon 30GB", type: "addon",
    monthly: { addedStorage: 32212254720, addedKaryawan: 0 } },       // 30 GB
  vorce_storage_3_year:   { name: "Storage Addon 30GB", type: "addon",
    yearly:  { addedStorage: 386547056640, addedKaryawan: 0 } },      // 360 GB
  vorce_storage_4_month:  { name: "Storage Addon 60GB", type: "addon",
    monthly: { addedStorage: 64424509440, addedKaryawan: 0 } },       // 60 GB
  vorce_storage_4_year:   { name: "Storage Addon 60GB", type: "addon",
    yearly:  { addedStorage: 773094113280, addedKaryawan: 0 } },      // 720 GB
};

/**
 * Resolve benefit dari productId + basePlanId.
 * Tier plans punya monthly/yearly, addons hanya monthly.
 *
 * @param {string} productId - e.g. "vorce_basic"
 * @param {string} basePlanId - e.g. "monthly" atau "yearly"
 * @returns {{ name, type, addedStorage, addedKaryawan, billingPeriod }} atau null
 */
function resolveBenefits(productId, basePlanId) {
  const product = PRODUCT_BENEFITS[productId];
  if (!product) return null;

  // Determine billing period
  const period = (basePlanId || "").toLowerCase().includes("year") ? "yearly" : "monthly";
  const benefits = product[period] || product.monthly; // fallback ke monthly

  if (!benefits) return null;

  return {
    name: product.name,
    type: product.type,
    addedStorage: benefits.addedStorage,
    addedKaryawan: benefits.addedKaryawan,
    billingPeriod: period,
  };
}

// ──────────────────────────────────────────────
// HELPER: Map Google Play subscription state
// ──────────────────────────────────────────────

/**
 * Konversi subscriptionState dari Google Play API ke status internal kita.
 *
 * Google Play API v2 mengembalikan state seperti:
 * - SUBSCRIPTION_STATE_ACTIVE
 * - SUBSCRIPTION_STATE_CANCELED   (user cancel, tapi masih aktif sampai period habis)
 * - SUBSCRIPTION_STATE_IN_GRACE_PERIOD
 * - SUBSCRIPTION_STATE_ON_HOLD    (payment gagal, akses dihentikan sementara)
 * - SUBSCRIPTION_STATE_PAUSED
 * - SUBSCRIPTION_STATE_EXPIRED
 *
 * Kita map ke status yang lebih sederhana untuk Firestore.
 */
function mapSubscriptionState(googleState) {
  const stateMap = {
    SUBSCRIPTION_STATE_ACTIVE: "active",
    SUBSCRIPTION_STATE_CANCELED: "cancelled",
    SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "grace_period",
    SUBSCRIPTION_STATE_ON_HOLD: "on_hold",
    SUBSCRIPTION_STATE_PAUSED: "paused",
    SUBSCRIPTION_STATE_EXPIRED: "expired",
    SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: "expired",
  };
  return stateMap[googleState] || "unknown";
}

/**
 * Cek apakah subscription state dianggap "aktif" (masih boleh pakai benefit).
 * Grace period dianggap masih aktif — memberi waktu user memperbaiki payment.
 */
function isActiveState(status) {
  return ["active", "grace_period"].includes(status);
}

// ──────────────────────────────────────────────
// HELPER: Recalculate Company Limits
// ──────────────────────────────────────────────

/**
 * Hitung ulang maxStorage dan maxKaryawan berdasarkan semua subscription aktif.
 *
 * FORMULA (REVISED):
 *   Jika ada tier plan aktif → tier plan MENGGANTIKAN free tier:
 *     maxStorage  = tierPlan.addedStorage + Σ(addon.addedStorage)
 *     maxKaryawan = tierPlan.addedKaryawan
 *   Jika TIDAK ada tier plan (free):
 *     maxStorage  = BASE (100MB) + Σ(addon.addedStorage)
 *     maxKaryawan = BASE (3)
 *
 * Fungsi ini IDEMPOTENT — bisa dipanggil berulang kali tanpa efek samping.
 *
 * @param {string} companyId - ID company yang subscription-nya berubah
 */
async function recalculateLimits(companyId) {
  // 1. Ambil semua subscription aktif
  const activeSubs = await db
    .collection("companies")
    .doc(companyId)
    .collection("subscriptions")
    .where("status", "in", ["active", "grace_period"])
    .get();

  // 2. Pisahkan tier plan vs addons
  let tierStorage = 0;
  let tierKaryawan = 0;
  let hasTierPlan = false;
  let addonStorage = 0;

  activeSubs.forEach((doc) => {
    const data = doc.data();
    if (data.productType === "tier") {
      // Tier plan: ambil yang tertinggi jika ada multiple (seharusnya cuma 1)
      if (!hasTierPlan || data.addedStorage > tierStorage) {
        tierStorage = data.addedStorage || 0;
        tierKaryawan = data.addedKaryawan || 0;
      }
      hasTierPlan = true;
    } else {
      // Addon: stack semua
      addonStorage += data.addedStorage || 0;
    }
  });

  // 3. Hitung final limits
  const finalStorage = hasTierPlan
    ? tierStorage + addonStorage              // Tier REPLACES free tier
    : BASE_MAX_STORAGE + addonStorage;        // Free tier + addons
  const finalKaryawan = hasTierPlan
    ? tierKaryawan                            // Tier's max karyawan
    : BASE_MAX_KARYAWAN;                      // Free tier default

  // 4. Update company document
  await db
    .collection("companies")
    .doc(companyId)
    .update({
      maxStorage: finalStorage,
      maxKaryawan: finalKaryawan,
    });

  console.log(
    `[Subscription] Recalculated limits for ${companyId}: ` +
      `maxStorage=${finalStorage} (tier=${hasTierPlan}), ` +
      `maxKaryawan=${finalKaryawan}, addonStorage=${addonStorage}`
  );
}

// ==================================================================
// 1. VERIFY SUBSCRIPTION (Endpoint utama dari Flutter)
// ==================================================================
/**
 * POST /api/subscription/verify
 *
 * Endpoint ini dipanggil Flutter setelah user berhasil membeli subscription.
 *
 * Body yang diharapkan:
 * {
 *   "purchaseToken": "token-dari-google-play",
 *   "productId": "vorce_basic"
 * }
 *
 * companyId diambil dari JWT token (req.user.idCompany),
 * jadi tidak perlu dikirim dari client — lebih aman.
 *
 * Flow:
 * 1. Validasi input
 * 2. Cek apakah user punya company
 * 3. Cek fraud: apakah token sudah pernah dipakai
 * 4. Verifikasi ke Google Play API
 * 5. Cek status subscription
 * 6. Acknowledge ke Google Play
 * 7. Simpan subscription ke Firestore
 * 8. Recalculate company limits
 */
router.post("/verify", verifyToken, async (req, res) => {
  try {
    const { purchaseToken, productId } = req.body;
    const user = req.user;

    // ─── A. VALIDASI INPUT ───
    if (!purchaseToken || !productId) {
      return res.status(400).json({
        message: "purchaseToken dan productId wajib diisi.",
      });
    }

    // Cek apakah productId valid (ada di config kita)
    const productConfig = PRODUCT_BENEFITS[productId];
    if (!productConfig) {
      return res.status(400).json({
        message: `Product '${productId}' tidak dikenali.`,
      });
    }

    // ─── B. CEK COMPANY ───
    // companyId diambil dari JWT token, bukan dari body request.
    // Ini mencegah user mengklaim subscription untuk company orang lain.
    const companyId = user.idCompany;
    if (!companyId) {
      return res.status(403).json({
        message: "Anda belum terdaftar di perusahaan manapun.",
      });
    }

    // Hanya admin/owner yang bisa membeli subscription untuk company
    if (user.role !== "admin") {
      return res.status(403).json({
        message: "Hanya Admin yang bisa membeli subscription.",
      });
    }

    // ─── C. FRAUD CHECK: TOKEN REUSE ───
    // Cek apakah purchaseToken ini sudah pernah diverifikasi sebelumnya.
    // Ini mencegah user mengirim token yang sama berulang kali
    // untuk mendapatkan benefit ganda.
    const tokenDoc = await db
      .collection("subscription_tokens")
      .doc(purchaseToken)
      .get();

    if (tokenDoc.exists) {
      return res.status(409).json({
        message: "Token ini sudah pernah diverifikasi.",
      });
    }

    // ─── D. VERIFIKASI KE GOOGLE PLAY API ───
    // Ini langkah krusial — satu-satunya cara memastikan pembelian benar-benar valid.
    // Tanpa ini, user bisa memalsukan purchaseToken dan klaim free subscription.
    let subscriptionData;
    try {
      subscriptionData = await verifySubscription(purchaseToken);
    } catch (apiError) {
      console.error("[Subscription] Google Play API Error:", apiError.message);

      // Error dari Google API biasanya berarti token invalid/expired
      if (apiError.code === 404 || apiError.code === 400) {
        return res.status(400).json({
          message: "Purchase token tidak valid atau sudah kadaluarsa.",
        });
      }
      throw apiError; // Re-throw untuk error lain (server error, network, dll)
    }

    // ─── E. CEK STATUS SUBSCRIPTION ───
    // subscriptionState dari Google Play API v2
    const googleState = subscriptionData.subscriptionState;
    const status = mapSubscriptionState(googleState);

    if (!isActiveState(status)) {
      return res.status(400).json({
        message: `Subscription tidak aktif. Status: ${status}`,
      });
    }

    // ─── F. EXTRACT DATA DARI RESPONSE ───
    // lineItems berisi detail produk yang dibeli
    // Di subscription v2, selalu ada minimal 1 lineItem
    const lineItem = subscriptionData.lineItems?.[0] || {};
    const expiryTime = lineItem.expiryTime
      ? new Date(lineItem.expiryTime)
      : null;
    const autoRenewing = lineItem.autoRenewingPlan ? true : false;

    // Detect basePlanId untuk menentukan monthly/yearly
    const basePlanId = lineItem.offerDetails?.basePlanId || "monthly";

    // Resolve benefits berdasarkan productId + basePlanId
    const benefits = resolveBenefits(productId, basePlanId);
    if (!benefits) {
      return res.status(400).json({
        message: `Tidak dapat resolve benefit untuk ${productId}/${basePlanId}.`,
      });
    }

    // orderId unik per transaksi (contoh: GPA.1234-5678-9012-34567)
    const orderId = subscriptionData.latestOrderId || null;

    // ─── G. ACKNOWLEDGE KE GOOGLE PLAY ───
    // WAJIB dilakukan dalam 3 hari setelah purchase!
    // Kalau tidak, Google otomatis refund pembelian user.
    //
    // Kita cek dulu apakah sudah di-acknowledge (bisa terjadi
    // jika Flutter retry karena timeout / error sebelumnya).
    const ackState = subscriptionData.acknowledgementState;
    if (ackState !== "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED") {
      try {
        const actualProductId = lineItem.productId || productId;
        await acknowledgeSubscription(purchaseToken, actualProductId);
        console.log(`[Subscription] Acknowledged: ${purchaseToken.substring(0, 20)}...`);
      } catch (ackError) {
        // Jika acknowledge gagal, LOG tapi JANGAN return error ke user.
        // Data subscription tetap disimpan, dan acknowledge bisa di-retry nanti.
        console.error("[Subscription] Acknowledge failed:", ackError.message);
      }
    }

    // ─── H. SIMPAN KE FIRESTORE (TRANSACTION) ───
    // Pakai transaction untuk memastikan atomicity:
    // 1. Simpan subscription document
    // 2. Simpan token registry (fraud prevention)
    // 3. Update company limits
    // Semua harus sukses atau semua fail.
    const subscriptionId = `${productId}_${Date.now()}`;

    const subscriptionDoc = {
      productId: productId,
      productType: benefits.type,         // "tier" atau "addon"
      billingPeriod: benefits.billingPeriod, // "monthly" atau "yearly"
      basePlanId: basePlanId,
      purchaseToken: purchaseToken,
      status: status,
      platform: "google_play",
      startedAt: Timestamp.now(),
      expiresAt: expiryTime ? Timestamp.fromDate(expiryTime) : null,
      lastRenewedAt: Timestamp.now(),
      cancelledAt: null,
      autoRenewing: autoRenewing,
      orderId: orderId,
      addedStorage: benefits.addedStorage,
      addedKaryawan: benefits.addedKaryawan,
      acknowledgedAt: Timestamp.now(),
      purchasedBy: user.email,
      createdAt: Timestamp.now(),
    };

    const tokenRegistryDoc = {
      companyId: companyId,
      subscriptionId: subscriptionId,
      productId: productId,
      createdAt: Timestamp.now(),
    };

    // Simpan subscription + token registry
    const batch = db.batch();

    // 1. Subscription document (subcollection di bawah company)
    const subRef = db
      .collection("companies")
      .doc(companyId)
      .collection("subscriptions")
      .doc(subscriptionId);
    batch.set(subRef, subscriptionDoc);

    // 2. Token registry (untuk fraud prevention — lookup cepat by token)
    const tokenRef = db.collection("subscription_tokens").doc(purchaseToken);
    batch.set(tokenRef, tokenRegistryDoc);

    await batch.commit();

    // ─── I. RECALCULATE LIMITS ───
    // Hitung ulang maxStorage dan maxKaryawan berdasarkan
    // SEMUA subscription aktif (bukan cuma yang baru ini).
    // Ini membuat function idempotent dan aman dari duplikasi.
    await recalculateLimits(companyId);

    console.log(
      `[Subscription] ✅ Verified & activated: ${productId} for ${companyId} by ${user.email}`
    );

    return res.status(200).json({
      message: "Subscription berhasil diaktifkan!",
      data: {
        subscriptionId: subscriptionId,
        productId: productId,
        plan: benefits.name,
        productType: benefits.type,
        billingPeriod: benefits.billingPeriod,
        status: status,
        expiresAt: expiryTime ? expiryTime.toISOString() : null,
        addedStorage: benefits.addedStorage,
        addedKaryawan: benefits.addedKaryawan,
      },
    });
  } catch (e) {
    console.error("[Subscription] Verify Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

// ==================================================================
// 2. STATUS SUBSCRIPTION (Untuk Flutter: cek plan aktif)
// ==================================================================
/**
 * GET /api/subscription/status
 *
 * Mengembalikan semua subscription aktif untuk company user.
 * Flutter bisa panggil ini saat app dibuka untuk menampilkan
 * info plan yang sedang aktif.
 *
 * Response:
 * {
 *   "subscriptions": [...],
 *   "totalAddedStorage": 1073741824,
 *   "totalAddedKaryawan": 10
 * }
 */
router.get("/status", verifyToken, async (req, res) => {
  try {
    const companyId = req.user.idCompany;

    if (!companyId) {
      return res.status(403).json({
        message: "Anda belum terdaftar di perusahaan manapun.",
      });
    }

    // Ambil semua subscription untuk company ini (aktif + yang lain)
    const subsSnapshot = await db
      .collection("companies")
      .doc(companyId)
      .collection("subscriptions")
      .orderBy("createdAt", "desc")
      .get();

    const subscriptions = [];
    let totalAddedStorage = 0;
    let totalAddedKaryawan = 0;

    subsSnapshot.forEach((doc) => {
      const data = doc.data();
      const sub = {
        id: doc.id,
        productId: data.productId,
        status: data.status,
        autoRenewing: data.autoRenewing,
        expiresAt: data.expiresAt?.toDate?.()?.toISOString() || null,
        addedStorage: data.addedStorage,
        addedKaryawan: data.addedKaryawan,
        startedAt: data.startedAt?.toDate?.()?.toISOString() || null,
      };

      subscriptions.push(sub);

      // Hitung total addon dari subscription yang masih aktif
      if (isActiveState(data.status)) {
        totalAddedStorage += data.addedStorage || 0;
        totalAddedKaryawan += data.addedKaryawan || 0;
      }
    });

    return res.status(200).json({
      subscriptions,
      totalAddedStorage,
      totalAddedKaryawan,
      baseLimits: {
        maxStorage: BASE_MAX_STORAGE,
        maxKaryawan: BASE_MAX_KARYAWAN,
      },
    });
  } catch (e) {
    console.error("[Subscription] Status Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

// ==================================================================
// 3. VERIFY APPLE SUBSCRIPTION (Endpoint dari Flutter iOS)
// ==================================================================
/**
 * POST /api/subscription/verify-apple
 *
 * Endpoint ini dipanggil Flutter setelah user berhasil membeli subscription
 * di iOS (via StoreKit 2).
 *
 * Body yang diharapkan:
 * {
 *   "transactionId": "transaction-id-dari-storekit",
 *   "productId": "vorce_basic"
 * }
 *
 * PERBEDAAN DENGAN GOOGLE PLAY:
 * - Google: purchaseToken → verify via Google Play API v3
 * - Apple:  transactionId → verify via App Store Server API v2
 * - Apple semua data dikembalikan dalam format JWS (signed JWT)
 *
 * companyId tetap diambil dari JWT kita (req.user.idCompany).
 */
router.post("/verify-apple", verifyToken, async (req, res) => {
  try {
    const { transactionId, productId } = req.body;
    const user = req.user;

    // ─── A. VALIDASI INPUT ───
    if (!transactionId || !productId) {
      return res.status(400).json({
        message: "transactionId dan productId wajib diisi.",
      });
    }

    // Cek apakah productId valid (ada di config lokal)
    const productConfig = PRODUCT_BENEFITS[productId];
    if (!productConfig) {
      return res.status(400).json({
        message: `Product '${productId}' tidak dikenali.`,
      });
    }

    const appleHelper = require("../helper/applestore");

    // ─── B. CEK COMPANY ───
    const companyId = user.idCompany;
    if (!companyId) {
      return res.status(403).json({
        message: "Anda belum terdaftar di perusahaan manapun.",
      });
    }

    if (user.role !== "admin") {
      return res.status(403).json({
        message: "Hanya Admin yang bisa membeli subscription.",
      });
    }

    // ─── C. FRAUD CHECK: TRANSACTION ID REUSE ───
    // Apple pakai transactionId sebagai unique identifier (bukan purchaseToken)
    const tokenDoc = await db
      .collection("subscription_tokens")
      .doc(`apple_${transactionId}`)
      .get();

    if (tokenDoc.exists) {
      return res.status(409).json({
        message: "Transaksi ini sudah pernah diverifikasi.",
      });
    }

    // ─── D. VERIFIKASI KE APPLE APP STORE SERVER API ───
    let transactionData;
    try {
      transactionData = await appleHelper.verifyAppleTransaction(transactionId);
    } catch (apiError) {
      console.error("[Subscription] Apple API Error:", apiError.message);

      if (apiError.code === 404 || apiError.code === 400) {
        return res.status(400).json({
          message: "Transaction ID tidak valid atau tidak ditemukan.",
        });
      }
      throw apiError;
    }

    // ─── E. EXTRACT & VALIDATE DATA ───
    // Dari decoded JWS, Apple mengembalikan:
    // - productId: ID produk yang dibeli
    // - expiresDate: kapan subscription expire (ms)
    // - originalTransactionId: ID transaksi original
    // - bundleId: bundle ID app
    // - type: "Auto-Renewable Subscription"
    const appleProductId = transactionData.productId;
    const expiresDateMs = transactionData.expiresDate;
    const originalTransactionId = transactionData.originalTransactionId || transactionId;
    const bundleId = transactionData.bundleId;

    // Validasi bundle ID
    if (bundleId && bundleId !== appleHelper.APPLE_BUNDLE_ID) {
      console.error(
        `[Subscription] Bundle ID mismatch: expected ${appleHelper.APPLE_BUNDLE_ID}, got ${bundleId}`
      );
      return res.status(400).json({
        message: "Bundle ID tidak sesuai.",
      });
    }

    // Validasi productId cocok
    if (appleProductId && appleProductId !== productId) {
      console.warn(
        `[Subscription] Product ID mismatch: client=${productId}, apple=${appleProductId}`
      );
    }

    // Cek expiry
    const expiryTime = expiresDateMs ? new Date(expiresDateMs) : null;
    const isExpired = expiryTime && expiryTime < new Date();

    if (isExpired) {
      return res.status(400).json({
        message: "Subscription sudah expired.",
      });
    }

    // ─── F. SIMPAN KE FIRESTORE ───
    // Detect billing period dari Apple transaction data
    // Apple StoreKit 2 menyimpan subscriptionPeriod di transaction
    const appleSubPeriod = transactionData.subscriptionPeriod || "";
    const isYearly = appleSubPeriod.includes("year") || appleSubPeriod.includes("P1Y");
    const periodKey = isYearly ? "yearly" : "monthly";

    // Resolve benefits menggunakan config lokal
    const benefits = resolveBenefits(productId, periodKey);
    if (!benefits) {
      return res.status(400).json({
        message: `Tidak dapat resolve benefit untuk ${productId}/${periodKey}.`,
      });
    }

    const subscriptionId = `${productId}_apple_${Date.now()}`;

    const subscriptionDoc = {
      productId: productId,
      productType: benefits.type,             // "tier" atau "addon"
      billingPeriod: benefits.billingPeriod,   // "monthly" atau "yearly"
      transactionId: transactionId,
      originalTransactionId: originalTransactionId,
      status: "active",
      platform: "apple",
      startedAt: Timestamp.now(),
      expiresAt: expiryTime ? Timestamp.fromDate(expiryTime) : null,
      lastRenewedAt: Timestamp.now(),
      cancelledAt: null,
      autoRenewing: true, // Default true untuk auto-renewable subscription
      addedStorage: benefits.addedStorage,
      addedKaryawan: benefits.addedKaryawan,
      purchasedBy: user.email,
      createdAt: Timestamp.now(),
    };

    const tokenRegistryDoc = {
      companyId: companyId,
      subscriptionId: subscriptionId,
      productId: productId,
      platform: "apple",
      originalTransactionId: originalTransactionId,
      createdAt: Timestamp.now(),
    };

    // Batch write
    const batch = db.batch();

    const subRef = db
      .collection("companies")
      .doc(companyId)
      .collection("subscriptions")
      .doc(subscriptionId);
    batch.set(subRef, subscriptionDoc);

    // Token registry: pakai prefix "apple_" untuk membedakan dari Google
    const tokenRef = db
      .collection("subscription_tokens")
      .doc(`apple_${transactionId}`);
    batch.set(tokenRef, tokenRegistryDoc);

    await batch.commit();

    // ─── G. RECALCULATE LIMITS ───
    await recalculateLimits(companyId);

    console.log(
      `[Subscription] ✅ Apple verified & activated: ${productId} for ${companyId} by ${user.email}`
    );

    return res.status(200).json({
      message: "Subscription Apple berhasil diaktifkan!",
      data: {
        subscriptionId: subscriptionId,
        productId: productId,
        plan: benefits.name,
        productType: benefits.type,
        billingPeriod: benefits.billingPeriod,
        platform: "apple",
        status: "active",
        expiresAt: expiryTime ? expiryTime.toISOString() : null,
        addedStorage: benefits.addedStorage,
        addedKaryawan: benefits.addedKaryawan,
      },
    });
  } catch (e) {
    console.error("[Subscription] Apple Verify Error:", e);
    return res.status(500).json({ message: "Server Error" });
  }
});

// ==================================================================
// 4. APPLE SERVER NOTIFICATION v2 WEBHOOK
// ==================================================================
/**
 * POST /api/subscription/apple-webhook
 *
 * Endpoint ini dipanggil oleh Apple Server Notifications v2
 * setiap kali ada perubahan status subscription (renew, cancel, expire, dll).
 *
 * Mirip dengan Google Play RTDN (di rtdn.js), tapi:
 * - Google: Pub/Sub trigger
 * - Apple: HTTP webhook (POST ke URL kita)
 *
 * Apple mengirim payload dalam format JWS (JSON Web Signature)
 * yang harus di-decode dan di-verify.
 *
 * SETUP DI APP STORE CONNECT:
 * App Store Connect → App → General → App Information
 * → Server Notifications URL (Production / Sandbox)
 * → Masukkan: https://api-y4ntpb3uvq-et.a.run.app/api/subscription/apple-webhook
 *
 * Body dari Apple:
 * {
 *   "signedPayload": "eyJ..." (JWS string)
 * }
 *
 * Decoded payload berisi:
 * {
 *   "notificationType": "DID_RENEW" | "EXPIRED" | "REFUND" | etc,
 *   "subtype": "AUTO_RENEW_DISABLED" | etc,
 *   "data": {
 *     "signedTransactionInfo": "eyJ..." (JWS lagi),
 *     "signedRenewalInfo": "eyJ..." (JWS lagi)
 *   }
 * }
 */
router.post("/apple-webhook", async (req, res) => {
  try {
    const { signedPayload } = req.body;

    if (!signedPayload) {
      console.warn("[Apple Webhook] Empty payload received");
      return res.status(400).json({ message: "Missing signedPayload" });
    }

    const appleHelper = require("../helper/applestore");

    // ─── A. DECODE NOTIFICATION PAYLOAD ───
    let notification;
    try {
      notification = await appleHelper.decodeAppleJWS(signedPayload);
    } catch (decodeError) {
      console.error("[Apple Webhook] Failed to decode payload:", decodeError.message);
      return res.status(400).json({ message: "Invalid payload" });
    }

    const { notificationType, subtype, data } = notification;

    console.log(
      `[Apple Webhook] Received: type=${notificationType}, subtype=${subtype || "none"}`
    );

    // ─── B. HANDLE TEST NOTIFICATION ───
    if (notificationType === "TEST") {
      console.log("[Apple Webhook] Test notification received — OK");
      return res.status(200).json({ message: "Test received" });
    }

    // ─── C. DECODE TRANSACTION INFO ───
    if (!data || !data.signedTransactionInfo) {
      console.warn("[Apple Webhook] No transaction info in notification");
      return res.status(200).json({ message: "No action needed" });
    }

    let transactionInfo;
    try {
      transactionInfo = await appleHelper.decodeAppleJWS(
        data.signedTransactionInfo
      );
    } catch (txDecodeError) {
      console.error(
        "[Apple Webhook] Failed to decode transaction info:",
        txDecodeError.message
      );
      return res.status(200).json({ message: "Decode failed, acknowledged" });
    }

    const { transactionId, originalTransactionId, productId, expiresDate } =
      transactionInfo;

    console.log(
      `[Apple Webhook] Transaction: id=${transactionId}, product=${productId}, ` +
        `originalTx=${originalTransactionId}`
    );

    // ─── D. LOOKUP SUBSCRIPTION DI DATABASE ───
    // Cari di subscription_tokens berdasarkan originalTransactionId
    const tokensQuery = await db
      .collection("subscription_tokens")
      .where("originalTransactionId", "==", originalTransactionId)
      .where("platform", "==", "apple")
      .limit(1)
      .get();

    if (tokensQuery.empty) {
      // Token belum pernah diverifikasi oleh /verify-apple endpoint
      console.warn(
        "[Apple Webhook] Transaction not found in registry:",
        originalTransactionId
      );
      // Return 200 agar Apple tidak retry terus
      return res
        .status(200)
        .json({ message: "Transaction not tracked, acknowledged" });
    }

    const tokenData = tokensQuery.docs[0].data();
    const { companyId, subscriptionId: subDocId } = tokenData;

    // ─── E. UPDATE SUBSCRIPTION STATUS ───
    const action = appleHelper.getNotificationAction(notificationType);
    const expiryTime = expiresDate ? new Date(expiresDate) : null;

    const updateData = {
      lastAppleNotifAt: Timestamp.now(),
      lastAppleNotifType: notificationType,
      lastAppleNotifSubtype: subtype || null,
    };

    switch (action) {
      case "activate":
      case "renew":
        updateData.status = "active";
        updateData.lastRenewedAt = Timestamp.now();
        if (expiryTime) {
          updateData.expiresAt = Timestamp.fromDate(expiryTime);
        }
        break;

      case "expire":
        updateData.status = "expired";
        updateData.expiredAt = Timestamp.now();
        break;

      case "revoke":
        updateData.status = "expired";
        updateData.revokedAt = Timestamp.now();
        break;

      case "billing_issue":
        // Bisa grace_period atau on_hold tergantung subtype
        if (subtype === "GRACE_PERIOD") {
          updateData.status = "grace_period";
        } else {
          updateData.status = "on_hold";
        }
        break;

      case "status_change":
        // Auto-renew status changed
        if (subtype === "AUTO_RENEW_DISABLED") {
          updateData.autoRenewing = false;
          updateData.status = "cancelled"; // Will still be active until expiry
        } else if (subtype === "AUTO_RENEW_ENABLED") {
          updateData.autoRenewing = true;
          updateData.status = "active";
        }
        break;

      case "extend":
        updateData.status = "active";
        if (expiryTime) {
          updateData.expiresAt = Timestamp.fromDate(expiryTime);
        }
        break;

      default:
        console.log(
          `[Apple Webhook] Unhandled action: ${action} for type: ${notificationType}`
        );
        break;
    }

    // Update subscription document
    const subRef = db
      .collection("companies")
      .doc(companyId)
      .collection("subscriptions")
      .doc(subDocId);

    const subDoc = await subRef.get();
    if (!subDoc.exists) {
      console.warn(
        `[Apple Webhook] Subscription doc ${subDocId} not found in company ${companyId}`
      );
      return res.status(200).json({ message: "Subscription doc not found" });
    }

    await subRef.update(updateData);

    // ─── F. RECALCULATE LIMITS ───
    await recalculateLimits(companyId);

    console.log(
      `[Apple Webhook] ✅ Updated ${subDocId} → action: ${action}, type: ${notificationType}`
    );

    // Apple expects 200 response to stop retrying
    return res.status(200).json({ message: "OK" });
  } catch (e) {
    console.error("[Apple Webhook] Error:", e);
    // Still return 200 to prevent Apple from retrying indefinitely
    // Log the error for debugging
    return res.status(200).json({ message: "Error processed" });
  }
});

// ──────────────────────────────────────────────
// EXPORT
// ──────────────────────────────────────────────
module.exports = router;

