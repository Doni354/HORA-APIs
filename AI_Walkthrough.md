# AI_Walkthrough — Vorce Project SOP

> Dokumen ini adalah **SOP wajib** yang harus dibaca dan dipatuhi oleh AI
> setiap kali memulai sesi pengerjaan di project ini.

---

## 1. Konteks Project

| Field | Value |
|---|---|
| **Nama Project** | **Vorce** |
| **Nama Lama** | HORA (JANGAN digunakan lagi) |
| **Repo** | `d:\Project\HORA-APIs` |
| **Backend** | Node.js + Express, deploy ke Firebase Cloud Functions |
| **Database** | Firestore |
| **Storage** | Cloudflare R2 |
| **Platform** | Google Play + Apple App Store (Flutter client) |

> [!CAUTION]
> Project ini bernama **VORCE**. Jangan pernah menyebut "HORA" dalam kode,
> komentar, log, maupun dokumentasi yang dibuat ke depannya.

---

## 2. Workflow 4 Fase — WAJIB DIIKUTI

Setiap pengerjaan fitur atau perubahan logic **harus melewati 4 fase ini secara berurutan**.
Tidak boleh skip, tidak boleh loncat fase.

---

### Fase 1 — PLANNING (Tunggu ACC)

**Trigger:** User meminta fitur baru atau perubahan logic.

**Yang harus dilakukan:**
- Buat draft rencana yang berisi:
  - **Business Logic** — apa yang sistem ini lakukan secara bisnis?
  - **Alur / Flow** — step-by-step dari request masuk sampai response keluar
  - **Endpoint spec** — method, path, request body, response shape
  - **File yang akan diubah** — list file + apa yang berubah di tiap file
- Presentasikan ke user dan **TUNGGU kata "ACC"**

> [!IMPORTANT]
> **JANGAN menulis kode apapun di Fase 1.** Bahkan jika yakin logikanya sudah
> benar, tetap tunggu approval dari user sebelum lanjut ke Fase 2.

---

### Fase 2 — IMPLEMENTASI (Setelah ACC)

**Trigger:** User sudah bilang "ACC" atau setara.

**Yang harus dilakukan:**
- Tulis kode sesuai plan yang sudah di-ACC
- Jelaskan setiap perubahan: file apa, baris mana, kenapa
- Jika di tengah implementasi ditemukan kondisi yang tidak sesuai plan →
  **STOP, kembali ke Fase 1**, update plan, minta ACC ulang

> [!NOTE]
> Di fase ini, dokumentasi Docusaurus **belum dibuat/diubah**. Fokus ke kode saja.

---

### Fase 3 — AUTOMATED TESTING (Tunggu Hasil Run)

**Trigger:** Implementasi selesai.

**Yang harus dilakukan:**
- Buat script testing otomatis untuk fitur yang baru diimplementasi
  - Format: script Node.js sederhana atau Jest test case
  - Script harus bisa dijalankan user dengan satu command (tidak butuh Postman)
  - Cakupan: happy path + edge cases penting (token invalid, double submit, dll)
- Kirimkan script ke user dan **TUNGGU hasil run (Pass / Fail)**

> [!IMPORTANT]
> **Jangan membuat atau mengubah file Docusaurus di Fase 3.**
> Dokumentasi hanya dibuat setelah test dipastikan berhasil di Fase 4.

Jika user melaporkan **FAIL**:
- Analisa error, kembali ke **Fase 2** untuk fix
- Buat script test ulang jika perlu, tunggu hasil run lagi

---

### Fase 4 — DOKUMENTASI FINAL (Setelah Test Pass)

**Trigger:** User konfirmasi test **BERHASIL / PASS**.

**Yang harus dilakukan:**
- Buat atau update file MDX di `docs-site/docs/` yang relevan
- Setiap halaman dokumentasi **wajib berisi**:
  1. **Tujuan Fitur** — bisnis problem yang diselesaikan
  2. **Alur Logic** — flow diagram (Mermaid) atau step-by-step
  3. **Payload** — request body, response shape, contoh nyata
  4. **Decision Making** — kenapa logic dibuat seperti ini (trade-off, alternatif yang tidak dipilih)

> [!TIP]
> Dokumentasi yang baik menjawab pertanyaan "kenapa" lebih dari "apa".
> Sertakan contoh kasus nyata, bukan hanya definisi teknis.

---

## 3. Struktur File Penting

```
d:\Project\HORA-APIs\
├── AI_Walkthrough.md           ← file ini (SOP)
├── docs-site/                  ← Docusaurus project
│   └── docs/
│       ├── intro.md
│       ├── architecture.md
│       ├── subscription/
│       │   ├── overview.md
│       │   ├── google-play.md
│       │   ├── apple.md
│       │   └── iap-tokens.md
│       └── features/
├── functions/
│   ├── config/
│   │   └── products.js         ← SATU-SATUNYA tempat tambah produk baru
│   ├── helper/
│   │   ├── subscriptionService.js
│   │   ├── googlePlayService.js
│   │   ├── appleSubscriptionService.js
│   │   └── iapService.js
│   └── routes/
│       └── subscription.js     ← thin router only
└── firebase.json
```

---

## 4. Aturan Kode

| Aturan | Detail |
|---|---|
| Nama produk baru | Edit `config/products.js` saja, jangan hardcode di route |
| Logic per platform | Tetap di service file masing-masing (`googlePlayService`, `appleSubscriptionService`, `iapService`) |
| Route handler | Hanya validasi input + call service + return response |
| Fraud prevention | Selalu cek token/transactionId sebelum proses apapun |
| Atomic write | Gunakan `batch` Firestore untuk operasi yang harus konsisten |
| Field baru di Firestore | Gunakan `set(..., { merge: true })` bukan `update()` untuk mencegah error field-not-exist |

---

*Last updated: 2026-08-01*
