---
id: firestore-mutations
sidebar_position: 1.5
title: Efek & Mutasi Firestore
---

# Efek In-App Purchase (IAP) di Firestore

Dokumentasi ini menjelaskan kebutuhan input (*Endpoint Arguments*) dan **mutasi data yang terjadi secara spesifik di Firestore** saat sebuah transaksi dari Store divalidasi dengan sukses oleh *backend*.

Setiap kategori IAP/Subscription akan menumbuhkan siklus penulisan algoritma yang berbeda.

---

## 1. Vorce Plan (Tier Subscription)
Kategori langganan langganan paket utama secara recurring (bulanan/tahunan) seperti `vorce_basic`, `vorce_team`, dsb. 
Setiap perusahaan secara teknis hanya boleh memiliki (terikat) pada satu *Tier Plan* spesifik sekaligus.

- **Kebutuhan Endpoint / Payload:**
  - Google (`/verify`): `{ purchaseToken, productId }`
  - Apple (`/verify-apple`): `{ transactionId, productId }`
- **Mutasi Data di Firestore:**
  1. **Log Subscriptions**: Membuat atau meneruskan sesi dokumen baru di *Sub-collection* `companies/{companyId}/subscriptions/{sub_Id}` yang diinisialisasi field metadata: `productType: "tier"`, `addedStorage: <Integer Bytes>`, dan `status: "active"`.
  2. **Update Limit Perusahaan (Recalculation)**: 
     - Field **`maxStorage`** pada Doc perusahaan (`companies/{companyId}`) akan terkalibrasi menjadi: _[Tier Storage Tertinggi]_ + _[Timbunan Addon Storage]_.

---

## 2. Storage Addon (Subs)
Bersifat akumulatif (*stackable*) tambahan kuota yang dikerjakan via skema Subs (contoh: `vorce_storage_1`).

- **Kebutuhan Endpoint / Payload:**
  Identik dengan Vorce Plan (menggunakan `/verify` atau `/verify-apple`).
- **Mutasi Data di Firestore:**
  1. **Log Subscriptions**: Resi terbuat di `companies/{companyId}/subscriptions` ditandai dengan tipe `productType: "addon"` beserta memori storage cadangan yang ada di atribut `addedStorage: <Integer>`.
  2. **Update Limit Perusahaan (Recalculation)**:
     - Algoritma khusus akan merangkul (`Sum`) seluruh dokumen subscription yang ada. Akumulasi ini akan mendorong pembaharuan pada field utama `maxStorage` di dokumen induk perusahaan secara dinamis/menambah total kapasitas aslinya.

---

## 3. Velinked (Device Management Subs)
Velinked bertugas menambahkan kuota *maksimal karyawan (device)* yang terhindar dari pencegatan anti-login yang ada di fitur premium, misal: `velinked_pro`.

- **Kebutuhan Endpoint / Payload:**
  Identik dengan sistem Plan / Addon diatas.
- **Mutasi Data di Firestore:**
  1. **Log Subscriptions**: Resi tercatat dengan metadata unik `productType: "velinked"` dan membawa jumlah limitasi alat (hardware pembatas) melalui atribut `maxDevices: <Integer>`, sisanya nol.
  2. **Update Limit Perusahaan (Recalculation)**:
     - Field baru dengan nama khusus **`max_devices`** akan diamandemen (tertulis update) di dokumen `companies/{companyId}` guna menggembok _business rule_. Apabila tagihan mati/dibatalkan, kolom `max_devices` merambat anjlok kebatas minimum standar.

---

## 4. Mitsu AI Token (One-Time IAP Purchase)
Berbeda dari langganan server-sentral Google Play; Ini adalah pembelian sistem putus beli 1 kali (*Consumable*) yang dialokasikan khusus pada *level pengguna/individu* dan terpisah mutlak dari ruang lingkup perusahaannya.

- **Kebutuhan Endpoint / Payload:**
  - Endpoint: `POST /api/subscription/verify-iap`
  - Body: `{ transactionId, productId, platform: "google_play" atau "apple" }`
- **Mutasi Data di Firestore (Atomic Batch Write):**
  1. **Menambah/Mengisi Saldo Kredensial User:**
     Melakukan *increment* otomatis (penjumlahan aman anti-race condition) langsung kepada key khusus: **`paid_credits_remaining`** pada dokumen induk individu `users/{email}`. _Value_ nya seutuhnya akan ditambahkan dengan parameter jumlah paket token yang telah di set.
  2. **Ledger (Catatan) Log Transaksi:**
     Sebagai jurnal bukti di Sub-collection `users/{email}/log_token/{autoId}` dengan atribut khusus rekam uang (`amount`, `transactionId`, dan `type: "purchase"`).
  3. **Penyuntikan Fraud Registry:**
     Memasang baut registrasi dokumen anti ganda di akar `iap_tokens/{platform}_{transactionId}` yang berbekas di database, bertujuan untuk mencegah terjadinya *double-fund* bila di injeksikan POST token berulang kali.
