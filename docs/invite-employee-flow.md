# 📄 Dokumentasi Fitur: Invite Employee Flow

> **Tanggal:** 23 September 2026  
> **Status:** BE ✅ Done | Web 🔲 Todo | FE Mobile 🔲 Todo  
> **File BE terkait:** `functions/routes/company.js`

---

## 1. Gambaran Umum

### Apa yang berubah?

Sebelumnya, saat Admin invite karyawan, email yang dikirim berisi link internal (`hora-7394b.web.app/join/?code=xxx`). Sekarang, link diganti ke **app link publik** `vorce.id/invite` agar user bisa langsung di-redirect ke app (Play Store / App Store).

### Format URL Baru

```
https://vorce.id/invite?id={companyCode}&inviteToken={token}&invited=true
```

| Param | Contoh | Penjelasan |
|-------|--------|------------|
| `id` | `CTD96L` | Kode perusahaan. Web sudah handle ini (existing) |
| `inviteToken` | `a1b2c3d4e5f6...` | **BARU** — Token undangan yang di-generate BE |
| `invited` | `true` | Trigger auto-redirect ke app/store (existing) |

### Flow Singkat

```
Admin invite → BE kirim email → User klik link → Web redirect ke App → App validasi token → User signup → Done
```

---

## 2. Sequence Diagram

```
Admin (Mobile)                 Backend                    Email Service
     |                            |                            |
     |-- POST /send-invite ------>|                            |
     |                            |-- Generate inviteToken     |
     |                            |-- Simpan ke Firestore      |
     |                            |-- Kirim email ------------>|
     |<-- 200 OK ----------------|                            |
     |                            |                            |
                                                               |
User (Calon Karyawan)          Web (vorce.id)                  |
     |                            |                            |
     |<-- Terima email ----------------------------------------|
     |-- Klik link -------------->|                            
     |                            |-- Parse params             
     |                            |-- invited=true? → redirect 
     |                            |                            
     |                     App (FE Mobile)          Backend
     |                            |                    |
     |                            |-- Parse inviteToken |
     |                            |-- GET /verify-invite -->|
     |                            |<-- {email, company} ---|
     |                            |-- Tampilkan info       |
     |                            |-- Google Sign-In       |
     |                            |-- Form noTelp/noWA     |
     |                            |-- POST /accept-invite ->|
     |                            |<-- 200 OK Berhasil! ---|
     |                            |-- Navigate Dashboard   |
```

---

## 3. Detail Per Platform

---

### 🔵 Backend (BE) — ✅ SUDAH SELESAI

#### A. `POST /company/send-invite` — Diubah

**Perubahan:** Link di email sekarang pakai URL baru.

```diff
- const inviteLink = `https://hora-7394b.web.app/join/?code=${inviteCode}`;
+ const inviteLink = `https://vorce.id/invite?id=${adminData.idCompany}&inviteToken=${inviteCode}&invited=true`;
```

**Request:**
```
POST /company/send-invite
Header: Authorization: Bearer <jwt_token>
```
```json
{
  "targetEmail": "karyawan@gmail.com"
}
```

**Response 200:**
```json
{
  "message": "Undangan berhasil dikirim ke karyawan@gmail.com"
}
```

**Data yang disimpan di Firestore (`invitations/{inviteToken}`):**
```json
{
  "email": "karyawan@gmail.com",
  "idCompany": "CTD96L",
  "companyName": "PT Maju Mundur",
  "role": "staff",
  "invitedBy": "admin@gmail.com",
  "createdAt": "Timestamp",
  "expiresAt": "Timestamp (24 jam dari sekarang)"
}
```

---

#### B. `GET /company/verify-invite/:inviteToken` — BARU ✨

**Fungsi:** FE Mobile hit API ini untuk cek apakah token undangan masih valid + dapat info perusahaan.

**Catatan:** Endpoint ini **publik** (tanpa auth token). Hanya untuk FE Mobile, Web tidak perlu hit ini.

**Request:**
```
GET /company/verify-invite/a1b2c3d4e5f6
```
Tidak ada body. Tidak ada auth header.

**Response 200 (Valid):**
```json
{
  "valid": true,
  "email": "karyawan@gmail.com",
  "companyName": "PT Maju Mundur",
  "companyLogo": "https://cdn.vorce.id/logos/CTD96L.png",
  "inviterName": "admin@gmail.com"
}
```

**Response 400 (Expired):**
```json
{
  "valid": false,
  "message": "Undangan sudah kadaluarsa."
}
```

**Response 404 (Tidak ditemukan):**
```json
{
  "valid": false,
  "message": "Kode undangan tidak valid."
}
```

---

#### C. `POST /company/accept-invite` — Tidak Diubah

**Fungsi:** FE Mobile hit API ini setelah user Google Sign-In + isi data diri.

**Request:**
```
POST /company/accept-invite
```
```json
{
  "idToken": "firebase_id_token_dari_google_signin",
  "inviteCode": "a1b2c3d4e5f6",
  "noTelp": "081234567890",
  "noWA": "081234567890"
}
```

> ⚠️ **Perhatikan:** Field di body namanya `inviteCode`, bukan `inviteToken`. Isinya sama — yaitu token undangan yang sama.

**Response 200 (Berhasil):**
```json
{
  "message": "Registrasi Berhasil! Selamat bergabung.",
  "user": {
    "email": "karyawan@gmail.com",
    "role": "staff",
    "company": "PT Maju Mundur"
  }
}
```

**Semua Error Response:**

| Status | Kapan | Response |
|--------|-------|----------|
| 400 | `idToken`, `inviteCode`, atau `noTelp` kosong | `{ "message": "Data tidak lengkap." }` |
| 400 | Token sudah expired (>24 jam) | `{ "message": "Kode undangan sudah kadaluarsa." }` |
| 400 | Kuota karyawan perusahaan penuh | `{ "message": "..." }` (dari quotaCheck) |
| 400 | User sudah terdaftar aktif | `{ "message": "Akun Anda sudah terdaftar aktif. Silakan login." }` |
| 401 | Firebase `idToken` tidak valid / expired | `{ "message": "Sesi login tidak valid." }` |
| 403 | Email yg login beda sama email undangan | `{ "message": "Undangan khusus untuk email xxx" }` |
| 404 | `inviteCode` tidak ditemukan di Firestore | `{ "message": "Kode undangan tidak valid." }` |
| 409 | Nomor telepon sudah dipakai akun lain | `{ "message": "Nomor telepon sudah digunakan oleh akun lain.", "error": "PHONE_ALREADY_EXISTS" }` |

---

### 🟢 Web (`vorce.id`) — 🔲 TODO

Web **TIDAK perlu hit API baru**. Tugasnya cuma pass-through param `inviteToken` ke app.

#### Yang perlu dikerjakan:

| # | Task | Detail |
|---|------|--------|
| 1 | **Parse param `inviteToken`** | Ambil value `inviteToken` dari query string URL |
| 2 | **Pass ke deep link** | Saat redirect ke app (baik auto-redirect maupun tombol), sertakan `inviteToken` di deep link |

#### Contoh:

**URL yang masuk ke Web:**
```
https://vorce.id/invite?id=CTD96L&inviteToken=a1b2c3d4e5f6&invited=true
```

**Deep link yang Web kirim ke App:**
```
vorce://invite?inviteToken=a1b2c3d4e5f6
```

#### Behavior:

| Kondisi | Yang terjadi |
|---------|-------------|
| `invited=true` | Auto-redirect ke app/store (existing) — pastikan `inviteToken` ikut dikirim via deep link |
| `invited` tidak ada / `false` | Tampilkan landing page biasa (existing) — jika ada `inviteToken`, tombol "Buka di Aplikasi" juga harus include `inviteToken` di deep link |

> 💡 **Intinya:** Apapun flow-nya, kalau ada `inviteToken` di URL, pastikan param itu sampai ke app.

---

### 🟠 FE Mobile (Flutter) — 🔲 TODO

FE Mobile paling banyak kerjaan. Ini flow lengkapnya:

#### Step-by-step:

```
1. App terima deep link → parse inviteToken
2. Hit GET /verify-invite/:inviteToken → dapat info
3. Tampilkan halaman undangan (info perusahaan)
4. User Google Sign-In
5. Validasi: email login == email undangan
6. User isi form (noTelp, noWA)
7. Hit POST /accept-invite → selesai
```

#### Yang perlu dikerjakan:

| # | Task | Detail |
|---|------|--------|
| 1 | **Deep link handler** | Listen deep link `vorce://invite?inviteToken=xxx` saat app dibuka dari link |
| 2 | **Parse `inviteToken`** | Ambil value dari deep link query params |
| 3 | **Hit verify-invite** | `GET /company/verify-invite/{inviteToken}` — untuk validasi + dapat info perusahaan |
| 4 | **Halaman undangan** | Tampilkan UI: logo perusahaan, nama perusahaan, siapa yang mengundang, email yang diundang |
| 5 | **Google Sign-In** | Trigger Google Sign-In untuk dapat `idToken` Firebase |
| 6 | **Validasi email** | Cek apakah email yang login **sama** dengan `email` dari response verify-invite. Kalau beda, tampilkan warning |
| 7 | **Form input** | Input `noTelp` (wajib) dan `noWA` (opsional, kalau kosong default = noTelp) |
| 8 | **Hit accept-invite** | `POST /company/accept-invite` dengan body: `{ idToken, inviteCode, noTelp, noWA }` |
| 9 | **Handle semua error** | Map setiap error status code ke pesan UI yang sesuai (lihat tabel error di atas) |
| 10 | **Sukses → Dashboard** | Navigasi ke halaman utama, clear state invite |

#### Data yang FE terima dari verify-invite:

```json
{
  "valid": true,
  "email": "karyawan@gmail.com",       // ← Tampilkan di UI + validasi saat login
  "companyName": "PT Maju Mundur",      // ← Tampilkan di UI
  "companyLogo": "https://cdn...",      // ← Tampilkan di UI
  "inviterName": "admin@gmail.com"      // ← Tampilkan di UI
}
```

#### Payload yang FE kirim ke accept-invite:

```json
{
  "idToken": "eyJhbGciOiJS...",         // ← Dari Google Sign-In (Firebase Auth)
  "inviteCode": "a1b2c3d4e5f6",        // ← Dari deep link (param inviteToken)
  "noTelp": "081234567890",             // ← Dari form input
  "noWA": "081234567890"                // ← Dari form input (opsional)
}
```

> ⚠️ **Field name di body = `inviteCode`**, bukan `inviteToken`. Value-nya sama.

#### Error yang harus di-handle FE:

| Error dari BE | Yang ditampilkan di UI |
|---------------|----------------------|
| 400 — Data tidak lengkap | "Mohon lengkapi semua data" |
| 400 — Expired | "Undangan sudah kadaluarsa. Minta admin kirim ulang." |
| 400 — Kuota penuh | "Kuota karyawan perusahaan sudah penuh." |
| 400 — Sudah terdaftar | "Akun sudah terdaftar. Silakan login." |
| 401 — Token invalid | "Sesi login tidak valid. Silakan login ulang." |
| 403 — Email beda | "Email Anda tidak sesuai undangan. Login dengan email: {email}" |
| 404 — Invite not found | "Undangan tidak valid." |
| 409 — No telp duplikat | "Nomor telepon sudah digunakan akun lain." |

---

## 4. Catatan Penting

### Expiry Undangan
- Token undangan berlaku **24 jam** sejak dikirim
- Setelah expired, user harus minta admin kirim undangan ulang
- Setelah accept berhasil, data invitation di Firestore **dihapus**

### Keamanan
- `verify-invite` tidak expose `idCompany` atau data internal
- `accept-invite` validasi email login harus cocok dengan email undangan
- Satu token hanya bisa dipakai sekali (dihapus setelah accept)

### Kompatibilitas
- Flow ini **tidak** mengganggu fitur company management employee yang sudah ada
- User yang join via invite langsung `status: "active"` (skip approval)
- Data otomatis sync ke subcollection `companies/{id}/employees/{email}`

### Edge Case: User Belum Install App
- Jika user klik link tapi belum install app → redirect ke Play Store / App Store (existing behavior Web)
- Setelah install, user harus **klik link lagi dari email** untuk masuk ke flow invite
- (Deferred deep linking belum di-support saat ini)
