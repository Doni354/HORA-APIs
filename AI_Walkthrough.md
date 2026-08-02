# AI_Walkthrough — Vorce Project SOP

> File ini adalah **memori kerja dan doktrin wajib** AI untuk project Vorce.
> Berisi: konteks sistem, workflow pengerjaan, konvensi kode, dan panduan dokumentasi.

---

## 1. Konteks Project

| Field | Value |
|---|---|
| **Nama Project** | **Vorce** |
| **Nama Lama** | HORA (JANGAN digunakan lagi) |
| **Repo** | `d:\Project\HORA-APIs` |
| **Backend** | Node.js 22 + Express, Firebase Cloud Functions Gen 2 |
| **Database** | Firestore (NoSQL) |
| **Storage** | Cloudflare R2 (`helper/uploadFile.js`, `config/r2.js`) |
| **Platform** | Google Play + Apple App Store (Flutter client) |
| **API Base URL** | `https://api-y4ntpb3uvq-et.a.run.app` |
| **Docs URL** | `https://hora-7394b.web.app/doc/` |

> [!CAUTION]
> Project ini bernama **VORCE**. Jangan pernah menyebut "HORA" dalam kode, log, komentar, maupun dokumentasi baru.

---

## 2. Arsitektur File yang Wajib Diketahui

```
functions/
├── config/
│   ├── firebase.js        ← Firestore & Admin SDK init (gunakan ini untuk db, auth)
│   ├── r2.js              ← Cloudflare R2 S3 client
│   └── products.js        ← ⭐ SATU-SATUNYA tempat definisi produk (subscription + IAP)
│
├── middleware/
│   └── token.js           ← verifyToken: decode JWT → set req.user
│                            req.user berisi: { email, role, idCompany, status, nama, deviceId }
│
├── helper/
│   ├── subscriptionService.js      ← resolveBenefits, mapSubscriptionState, isActiveState, recalculateLimits
│   ├── googlePlayService.js        ← verifyGooglePlayPurchase(purchaseToken, productId, user)
│   ├── appleSubscriptionService.js ← verifyApplePurchase + handleAppleWebhook
│   ├── iapService.js               ← processIAPPurchase(transactionId, productId, platform, user)
│   ├── playstore.js                ← Google Play API client: verifySubscription, acknowledgeSubscription
│   │                                 Export: BASE_MAX_STORAGE, BASE_MAX_DEVICES
│   ├── applestore.js               ← Apple App Store Server API: verifyAppleTransaction, decodeAppleJWS
│   │                                 Export: APPLE_BUNDLE_ID, getNotificationAction
│   ├── emailHelper.js              ← Nodemailer / Hostinger SMTP (bukan Firestore mail collection lagi)
│   ├── uploadFile.js               ← R2 upload/delete + update usedStorage
│   ├── shiftScheduleService.js     ← getActiveShift(companyId, currentTime)
│   └── logCompanyActivity.js       ← log aktivitas ke companies/{id}/activity
│
├── routes/                ← THIN ROUTER ONLY — validasi input + call helper/service
│   ├── subscription.js    ← /verify, /status, /verify-apple, /apple-webhook, /verify-iap
│   ├── login.js           ← /login, /register, /register-company
│   ├── profile.js         ← /profile GET/PUT
│   ├── absensi.js         ← /check-in, /check-out, /history
│   ├── arsip.js           ← file management admin
│   ├── karyawan.js        ← employee management
│   └── ...
│
└── scheduler/
    ├── rtdn.js            ← Google Play RTDN via Pub/Sub (subscription status update)
    └── subscription.js    ← Scheduled job: cleanup expired subscriptions
```

---

## 3. Pola Kode yang Wajib Diikuti

### Pattern Route (Thin Router)
```js
router.post("/endpoint", verifyToken, async (req, res) => {
  // 1. Validasi input saja
  const { field } = req.body;
  if (!field) return res.status(400).json({ message: "field wajib diisi." });

  // 2. Delegasi ke service/helper
  const result = await myService.doSomething(field, req.user);

  // 3. Map result ke HTTP response
  if (!result.ok) return res.status(result.status).json({ message: result.message });
  return res.status(200).json({ message: "Sukses", data: result.data });
});
```

### Pattern Service Return
```js
// Service selalu return { ok, status?, message?, data? }
return { ok: false, status: 409, message: "Duplikat." };
return { ok: true, data: { ... } };
```

### Firestore — Field Baru
```js
// JANGAN pakai update() jika field belum tentu ada
// HARUS pakai set + merge: true
batch.set(ref, { newField: value }, { merge: true });
```

### Firestore — Atomic Write
```js
const batch = db.batch();
batch.set(ref1, data1);
batch.set(ref2, data2); // fraud registry
await batch.commit();   // semua atau tidak sama sekali
```

### Fraud Prevention Pattern
```js
// Selalu cek token/transactionId SEBELUM proses apapun
const tokenDoc = await db.collection("iap_tokens").doc(`${platform}_${txId}`).get();
if (tokenDoc.exists) return { ok: false, status: 409, message: "Sudah diproses." };
```

---

## 4. Data Model Penting

```
users/{email}                     ← primary key = email (bukan uid)
  ├── uid, username, role
  ├── idCompany                   ← FK ke companies/
  ├── status: "active"|"inactive"
  ├── paid_credits_remaining      ← AI token credits (int)
  └── log_token/ {logId}          ← riwayat pembelian IAP

companies/{companyId}
  ├── maxStorage (bytes), max_devices
  └── subscriptions/ {subId}
      ├── productId, productType ("tier"|"addon"|"velinked")
      ├── platform ("google_play"|"apple")
      ├── status ("active"|"grace_period"|"expired"|...)
      └── addedStorage, maxDevices

subscription_tokens/{purchaseToken}     ← fraud registry Google Play
iap_tokens/{platform}_{transactionId}   ← fraud registry IAP
```

---

## 5. Workflow 4 Fase — WAJIB DIIKUTI

Setiap pengerjaan fitur **harus melewati 4 fase berurutan**. Tidak boleh skip.

### Fase 1 — PLANNING (Tunggu ACC)
- Buat draft: Business Logic, Alur, Endpoint spec, File yang berubah
- **Tunggu kata "ACC"** sebelum nulis kode apapun

### Fase 2 — IMPLEMENTASI (Setelah ACC)
- Ikuti pola kode di atas (thin router, service return pattern, dll)
- Kalau ada hal tak terduga → STOP, kembali ke Fase 1

### Fase 3 — AUTOMATED TESTING (Tunggu Hasil Run)
- Buat script Node.js test (`scripts/test-xxx.js`) yang bisa dijalankan dengan `node scripts/test-xxx.js`
- Cakupan: happy path + edge cases (token invalid, 409 duplicate, field missing)
- **Jangan buat/ubah doc Docusaurus di fase ini**
- Tunggu hasil user: Pass / Fail

### Fase 4 — DOKUMENTASI FINAL (Setelah Test Pass)
- Buat/update file MDX di `docs-site/docs/`
- Format wajib setiap halaman (lihat bagian 6 di bawah)
- Build + deploy: `npm run docs:build && firebase deploy --only hosting`
- Commit: `git add -A && git commit -m "docs: ..."`

---

## 6. Format Wajib Dokumentasi (Per Halaman)

Setiap halaman doc WAJIB berisi semua bagian ini:

### Untuk Route/Endpoint
```md
## Tujuan
[bisnis problem yang diselesaikan — 1-2 kalimat]

## Endpoint
[method, path, contoh request body + tabel field, contoh response sukses + tabel error codes]

## Alur Logic
[Mermaid sequenceDiagram — wajib visual, bukan teks]

## Efek di Firestore / Database
[field apa yang berubah, collection mana, format data]

## Decision Making
[kenapa dibikin seperti ini — trade-off, alternatif yang tidak dipilih]
```

### Untuk Helper/Service
```md
## Tujuan
[fungsi ini responsible untuk apa]

## Exports
[list function yang di-export + signature]

## Flow Internal
[Mermaid flowchart — step-step internal logic]

## Digunakan Oleh
[list route/file yang memanggil helper ini]
```

### Untuk Scheduler
```md
## Trigger
[kapan dijalankan — Pub/Sub topic, cron schedule, dll]

## Tujuan
[apa yang dilakukan]

## Alur
[Mermaid flow]

## Efek di Firestore
```

---

## 7. Panduan Mermaid — Anti Error

Mermaid sering error karena karakter khusus. **Aturan wajib:**

```md
# SALAH — kurung kurawal {} di dalam label [] menyebabkan parse error
F[Lookup users/{email}]

# BENAR — quote label yang mengandung {}, (), [], |
F["Lookup users/{email}"]

# Diamond shape (decision) = {} tanpa quote
H{Kondisi aktif?}

# Newline di label
A["Baris pertama\nBaris kedua"]
```

Karakter yang **HARUS** di-quote jika di dalam label:
- `{` `}` — diamond shape
- `(` `)` — stadium shape  
- `[` `]` — nested bracket

---

## 8. Docs Build & Deploy Workflow

```bash
# Setelah edit file di docs-site/docs/

# 1. Build + copy ke public/doc/
npm run docs:build

# 2. Deploy hosting
firebase deploy --only hosting

# 3. Commit
git add -A && git commit -m "docs: <deskripsi singkat>"

# Atau sekaligus:
npm run docs:build && firebase deploy --only hosting
```

**Dev mode (preview lokal tanpa build):**
```bash
npm run docs:dev
# → http://localhost:3000/doc/
```

---

## 9. File yang TIDAK Boleh Diubah Sembarangan

| File | Risiko |
|---|---|
| `config/firebase.js` | Mengubah ini bisa break semua Firestore connection |
| `middleware/token.js` | Mengubah `req.user` shape bisa break semua route |
| `config/products.js` | Gunakan ini SAJA untuk tambah produk, jangan duplikat di route |
| `firebase.json` | Perubahan hosting config harus ditest lokal dulu |
| `functions/.env` | **JANGAN PERNAH COMMIT** |

---

*Last updated: 2026-08-02*
