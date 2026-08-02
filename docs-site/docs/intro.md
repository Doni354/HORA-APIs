---
id: intro
slug: /
sidebar_position: 1
title: Pengenalan Vorce
---

# Vorce Backend API

**Vorce** adalah platform SaaS berbasis subscription untuk manajemen karyawan, arsip digital, dan absensi. Backend ini melayani Flutter client (Android & iOS) via REST API yang di-deploy ke **Firebase Cloud Functions (Gen 2)**.

## Tech Stack

| Layer | Teknologi |
|---|---|
| Runtime | Node.js 22 (Firebase Functions Gen 2) |
| Framework | Express.js |
| Database | Firestore (NoSQL) |
| File Storage | Cloudflare R2 |
| Auth | JWT (custom) + Firebase Auth |
| Push Notif | Firebase Cloud Messaging (FCM) |
| Subscription | Google Play Billing v3 + Apple StoreKit 2 |

## Struktur Project

```
functions/
├── config/
│   ├── firebase.js          ← Firestore & Firebase Admin init
│   ├── r2.js                ← Cloudflare R2 client
│   └── products.js          ← ⭐ Central product config (subscription + IAP)
├── helper/
│   ├── subscriptionService.js     ← Shared utils: resolveBenefits, recalculateLimits
│   ├── googlePlayService.js       ← Logic verify Google Play subscription
│   ├── appleSubscriptionService.js← Logic verify Apple + webhook handler
│   ├── iapService.js              ← Logic IAP one-time purchase
│   ├── playstore.js               ← Google Play API client
│   ├── applestore.js              ← Apple App Store Server API client
│   ├── emailHelper.js             ← Nodemailer / Hostinger SMTP
│   └── uploadFile.js              ← R2 upload/delete
├── middleware/
│   └── token.js             ← JWT verify middleware
├── routes/
│   ├── subscription.js      ← Thin router (delegate ke service files)
│   ├── login.js             ← Auth, company registration
│   ├── profile.js           ← User profile management
│   ├── absensi.js           ← Attendance & shift
│   ├── arsip.js             ← File archive management
│   └── ...
└── scheduler/
    ├── rtdn.js              ← Google Play RTDN via Pub/Sub
    └── subscription.js      ← Scheduled subscription checks
```

## Deployment

Backend di-deploy otomatis ke Cloud Run via:
```bash
firebase deploy --only functions
```

**API Base URL:** `https://api-y4ntpb3uvq-et.a.run.app`

## Navigasi Dokumentasi

- **Subscription & IAP** — Cara kerja pembelian subscription dan token AI
- **Backend** — Setup, environment, dan middleware
- **Fitur** — Storage, notifikasi, absensi
