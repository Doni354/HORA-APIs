---
id: overview
sidebar_position: 1
title: Overview Subscription
---

# Subscription System — Overview

Vorce menggunakan dua jenis pembelian in-app:

| Tipe | Deskripsi | Handler |
|---|---|---|
| **Subscription** | Recurring (monthly/yearly), akses storage + fitur | `googlePlayService`, `appleSubscriptionService` |
| **IAP One-Time** | Consumable, token AI Mitsu | `iapService` |

## Product Config

Semua produk didefinisikan di **satu tempat**: [`config/products.js`](https://github.com/vorce/vorce-apis/blob/main/functions/config/products.js)

Untuk menambah produk baru → edit file tersebut. Tidak perlu ubah logic di route atau service.

## Fraud Prevention

Setiap transaksi di-lock dengan registry Firestore:
- Google Play → `subscription_tokens/{purchaseToken}`
- Apple → `subscription_tokens/apple_{transactionId}`
- IAP → `iap_tokens/{platform}_{transactionId}`

Request dengan token yang sama akan di-reject `409 Conflict`.
