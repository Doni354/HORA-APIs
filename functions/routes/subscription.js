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
// baru di Google Play Console.
const PRODUCT_BENEFITS = {
  vorce_explorer: {
    name: "Explorer Plan",
    addedStorage: 1073741824, // 1 GB in bytes
    addedKaryawan: 10,
  },
  // Contoh plan lain (uncomment kalau sudah dibuat di Play Console):
  // vorce_professional: {
  //   name: "Professional Plan",
  //   addedStorage: 5368709120,  // 5 GB
  //   addedKaryawan: 50,
  // },
};

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
 * Formula:
 *   maxStorage  = BASE (100MB) + Σ(addedStorage dari subscription aktif)
 *   maxKaryawan = BASE (3)     + Σ(addedKaryawan dari subscription aktif)
 *
 * Kenapa pakai konstanta BASE dan bukan field di database?
 * → Karena base limit itu fixed (100MB / 3 karyawan) untuk semua company.
 *   Menyimpan di database hanya menambah kompleksitas tanpa manfaat.
 *   Kalau di masa depan perlu customisasi per-company, baru tambahkan field.
 *
 * Fungsi ini IDEMPOTENT — bisa dipanggil berulang kali tanpa efek samping.
 * Ini penting karena RTDN bisa mengirim notifikasi duplikat.
 *
 * @param {string} companyId - ID company yang subscription-nya berubah
 */
async function recalculateLimits(companyId) {
  // 1. Ambil semua subscription yang STATUS-nya = aktif atau grace_period
  const activeSubs = await db
    .collection("companies")
    .doc(companyId)
    .collection("subscriptions")
    .where("status", "in", ["active", "grace_period"])
    .get();

  // 2. Jumlahkan semua addon dari subscription aktif
  let totalAddedStorage = 0;
  let totalAddedKaryawan = 0;

  activeSubs.forEach((doc) => {
    const data = doc.data();
    totalAddedStorage += data.addedStorage || 0;
    totalAddedKaryawan += data.addedKaryawan || 0;
  });

  // 3. Update company document dengan total limit baru
  //    BASE + semua addon dari subscription aktif
  await db
    .collection("companies")
    .doc(companyId)
    .update({
      maxStorage: BASE_MAX_STORAGE + totalAddedStorage,
      maxKaryawan: BASE_MAX_KARYAWAN + totalAddedKaryawan,
    });

  console.log(
    `[Subscription] Recalculated limits for ${companyId}: ` +
      `maxStorage=${BASE_MAX_STORAGE + totalAddedStorage}, ` +
      `maxKaryawan=${BASE_MAX_KARYAWAN + totalAddedKaryawan}`
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
 *   "productId": "vorce_explorer"
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
    const benefits = PRODUCT_BENEFITS[productId];
    if (!benefits) {
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
        // productId dari lineItem (contoh: "vorce_explorer")
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

// ──────────────────────────────────────────────
// EXPORT
// ──────────────────────────────────────────────
module.exports = router;
