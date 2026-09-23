/* eslint-disable */

/**
 * PRODUCT CONFIG
 * ==============
 * Central config untuk semua produk in-app:
 *
 * 1. PRODUCT_BENEFITS — Subscription plans (recurring, Google Play & Apple)
 * 2. IAP_PRODUCTS     — One-time consumable purchases (token AI, dll)
 *
 * Tambahkan produk baru di sini saja, logika di subscription.js
 * tidak perlu diubah.
 */

// ──────────────────────────────────────────────
// A. SUBSCRIPTION PLANS (Recurring)
// ──────────────────────────────────────────────
//
// TYPE:
//   "tier"     = Plan utama Vorce (exclusive, hanya 1 aktif)
//   "addon"    = Storage tambahan (stackable)
//   "velinked" = Plan Velinked — khusus max_devices
//
// Google Play: 1 productId + basePlanId (monthly/yearly)
// Apple: productId terpisah per period (_month / _year)
// ──────────────────────────────────────────────
const PRODUCT_BENEFITS = {
  // ── TIER PLANS — Google Play ──
  vorce_basic: {
    name: "Basic Plan", type: "tier",
    monthly: { addedStorage: 1073741824,   addedKaryawan: 10 },   // 1 GB
    yearly:  { addedStorage: 12884901888,  addedKaryawan: 10 },   // 12 GB
  },
  vorce_team: {
    name: "Team Plan", type: "tier",
    monthly: { addedStorage: 3221225472,   addedKaryawan: 30 },   // 3 GB
    yearly:  { addedStorage: 38654705664,  addedKaryawan: 30 },   // 36 GB
  },
  vorce_business: {
    name: "Business Plan", type: "tier",
    monthly: { addedStorage: 10737418240,  addedKaryawan: 100 },  // 10 GB
    yearly:  { addedStorage: 128849018880, addedKaryawan: 100 },  // 120 GB
  },
  vorce_enterprise: {
    name: "Enterprise Plan", type: "tier",
    monthly: { addedStorage: 32212254720,  addedKaryawan: 300 },  // 30 GB
    yearly:  { addedStorage: 386547056640, addedKaryawan: 300 },  // 360 GB
  },

  // ── STORAGE ADDONS — Google Play ──
  vorce_storage_1: {
    name: "Storage Addon 10GB", type: "addon",
    monthly: { addedStorage: 10737418240,   addedKaryawan: 0 },   // 10 GB
    yearly:  { addedStorage: 128849018880,  addedKaryawan: 0 },   // 120 GB
  },
  vorce_storage_2: {
    name: "Storage Addon 50GB", type: "addon",
    monthly: { addedStorage: 53687091200,   addedKaryawan: 0 },   // 50 GB
    yearly:  { addedStorage: 644245094400,  addedKaryawan: 0 },   // 600 GB
  },
  vorce_storage_3: {
    name: "Storage Addon 125GB", type: "addon",
    monthly: { addedStorage: 134217728000,  addedKaryawan: 0 },   // 125 GB
    yearly:  { addedStorage: 1610612736000, addedKaryawan: 0 },   // 1500 GB
  },
  vorce_storage_4: {
    name: "Storage Addon 250GB", type: "addon",
    monthly: { addedStorage: 268435456000,  addedKaryawan: 0 },   // 250 GB
    yearly:  { addedStorage: 3221225472000, addedKaryawan: 0 },   // 3000 GB
  },

  // ── VELINKED PLANS — Google Play ──
  velinked_pro: {
    name: "Velinked Pro", type: "velinked",
    monthly: { addedStorage: 0, addedKaryawan: 0, maxDevices: 3 },
    yearly:  { addedStorage: 0, addedKaryawan: 0, maxDevices: 3 },
  },
  velinked_pro_plus: {
    name: "Velinked Pro Plus", type: "velinked",
    monthly: { addedStorage: 0, addedKaryawan: 0, maxDevices: 5 },
    yearly:  { addedStorage: 0, addedKaryawan: 0, maxDevices: 5 },
  },
  velinked_pro_max: {
    name: "Velinked Pro Max", type: "velinked",
    monthly: { addedStorage: 0, addedKaryawan: 0, maxDevices: 13 },
  },

  // ── TIER PLANS — Apple ──
  vorce_basic_month:      { name: "Basic Plan",      type: "tier",    monthly: { addedStorage: 1073741824,   addedKaryawan: 10  } },
  vorce_basic_year:       { name: "Basic Plan",      type: "tier",    yearly:  { addedStorage: 12884901888,  addedKaryawan: 10  } },
  vorce_team_month:       { name: "Team Plan",       type: "tier",    monthly: { addedStorage: 3221225472,   addedKaryawan: 30  } },
  vorce_team_year:        { name: "Team Plan",       type: "tier",    yearly:  { addedStorage: 38654705664,  addedKaryawan: 30  } },
  vorce_business_month:   { name: "Business Plan",   type: "tier",    monthly: { addedStorage: 10737418240,  addedKaryawan: 100 } },
  vorce_business_year:    { name: "Business Plan",   type: "tier",    yearly:  { addedStorage: 128849018880, addedKaryawan: 100 } },
  vorce_enterprise_month: { name: "Enterprise Plan", type: "tier",    monthly: { addedStorage: 32212254720,  addedKaryawan: 300 } },
  vorce_enterprise_year:  { name: "Enterprise Plan", type: "tier",    yearly:  { addedStorage: 386547056640, addedKaryawan: 300 } },

  // ── STORAGE ADDONS — Apple ──
  vorce_storage_1_month:  { name: "Storage Addon 10GB", type: "addon", monthly: { addedStorage: 10737418240,   addedKaryawan: 0 } },
  vorce_storage_1_year:   { name: "Storage Addon 10GB", type: "addon", yearly:  { addedStorage: 128849018880,  addedKaryawan: 0 } },
  vorce_storage_2_month:  { name: "Storage Addon 50GB", type: "addon", monthly: { addedStorage: 53687091200,   addedKaryawan: 0 } },
  vorce_storage_2_year:   { name: "Storage Addon 50GB", type: "addon", yearly:  { addedStorage: 644245094400,  addedKaryawan: 0 } },
  vorce_storage_3_month:  { name: "Storage Addon 125GB", type: "addon", monthly: { addedStorage: 134217728000,  addedKaryawan: 0 } },
  vorce_storage_3_year:   { name: "Storage Addon 125GB", type: "addon", yearly:  { addedStorage: 1610612736000, addedKaryawan: 0 } },
  vorce_storage_4_month:  { name: "Storage Addon 250GB", type: "addon", monthly: { addedStorage: 268435456000,  addedKaryawan: 0 } },
  vorce_storage_4_year:   { name: "Storage Addon 250GB", type: "addon", yearly:  { addedStorage: 3221225472000, addedKaryawan: 0 } },

  // ── PERSONAL STORAGE (USER STORAGE) — Google Play ──
  vorce_personal_storage_1: {
    name: "User Storage 10GB", type: "personal_storage",
    monthly: { addedStorage: 10737418240,   addedKaryawan: 0 },   // 10 GB
    yearly:  { addedStorage: 128849018880,  addedKaryawan: 0 },   // 120 GB
  },
  vorce_personal_storage_2: {
    name: "User Storage 20GB", type: "personal_storage",
    monthly: { addedStorage: 21474836480,   addedKaryawan: 0 },   // 20 GB
    yearly:  { addedStorage: 257698037760,  addedKaryawan: 0 },   // 240 GB
  },
  vorce_personal_storage_3: {
    name: "User Storage 30GB", type: "personal_storage",
    monthly: { addedStorage: 32212254720,   addedKaryawan: 0 },   // 30 GB
    yearly:  { addedStorage: 386547056640,  addedKaryawan: 0 },   // 360 GB
  },

  // ── VELINKED PLANS — Apple ──
  velinked_pro_max_month:  { name: "Velinked Pro Max",  type: "velinked", monthly: { addedStorage: 0, addedKaryawan: 0, maxDevices: 13 } },
  velinked_pro_max_year:   { name: "Velinked Pro Max",  type: "velinked", yearly:  { addedStorage: 0, addedKaryawan: 0, maxDevices: 13 } },
  velinked_pro_plus_month: { name: "Velinked Pro Plus", type: "velinked", monthly: { addedStorage: 0, addedKaryawan: 0, maxDevices: 5  } },
  velinked_pro_plus_year:  { name: "Velinked Pro Plus", type: "velinked", yearly:  { addedStorage: 0, addedKaryawan: 0, maxDevices: 5  } },
  velinked_pro_month:      { name: "Velinked Pro",      type: "velinked", monthly: { addedStorage: 0, addedKaryawan: 0, maxDevices: 3  } },
  velinked_pro_year:       { name: "Velinked Pro",      type: "velinked", yearly:  { addedStorage: 0, addedKaryawan: 0, maxDevices: 3  } },

  // ── PERSONAL STORAGE (USER STORAGE) — Apple ──
  vorce_personal_storage_1_month: { name: "User Storage 10GB", type: "personal_storage", monthly: { addedStorage: 10737418240,   addedKaryawan: 0 } },
  vorce_personal_storage_1_year:  { name: "User Storage 10GB", type: "personal_storage", yearly:  { addedStorage: 128849018880,  addedKaryawan: 0 } },
  vorce_personal_storage_2_month: { name: "User Storage 20GB", type: "personal_storage", monthly: { addedStorage: 21474836480,   addedKaryawan: 0 } },
  vorce_personal_storage_2_year:  { name: "User Storage 20GB", type: "personal_storage", yearly:  { addedStorage: 257698037760,  addedKaryawan: 0 } },
  vorce_personal_storage_3_month: { name: "User Storage 30GB", type: "personal_storage", monthly: { addedStorage: 32212254720,   addedKaryawan: 0 } },
  vorce_personal_storage_3_year:  { name: "User Storage 30GB", type: "personal_storage", yearly:  { addedStorage: 386547056640,  addedKaryawan: 0 } },
};

// ──────────────────────────────────────────────
// B. ONE-TIME IAP PRODUCTS (Consumable)
// ──────────────────────────────────────────────
//
// Product ID sama untuk Google Play dan Apple.
// creditAmount = jumlah yang ditambahkan ke paid_credits_remaining.
//
// Tambah baris baru di sini untuk produk token baru.
// ──────────────────────────────────────────────
const IAP_PRODUCTS = {
  mitsu_ai_token_1: { description: "Mitsu AI Token 1",   creditAmount: 30000   },
  mitsu_ai_token_2: { description: "Mitsu AI Token 2",   creditAmount: 100000  },
  mitsu_ai_token_3: { description: "Mitsu AI Token 3",   creditAmount: 250000  },
  mitsu_ai_token_4: { description: "Mitsu AI Token 4",   creditAmount: 500000  },
  mitsu_ai_token_5: { description: "Mitsu AI Token 5",   creditAmount: 1000000 },
};

module.exports = { PRODUCT_BENEFITS, IAP_PRODUCTS };
