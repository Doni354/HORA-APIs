---
id: login
sidebar_position: 6
title: Login, Auth, & Users Mapping
---

# Route — `login.js`

## Tujuan
Menangani seluruh alur autentikasi Vorce, proses pendaftaran (baik untuk karyawan baru maupun entitas perusahaan), dan manajemen koleksi `users`. Route ini melayani OTP email, Google Sign-In, manajemen device lock, serta pencatatan identitas pengguna (termasuk FaceID) yang baru pertama kali bergabung ke dalam ekosistem.

---

## Manajemen Koleksi `users`
Sebagian besar daur hidup awal entitas **User** diurus oleh modul ini:
1. **Pendaftaran Perusahaan (`/registrasi`)**: Membuat struktur `companies` baru beserta membuat akun perdana ber-`role: "admin"` yang di-*bind* (terikat) sebagai `createdBy`.
2. **Pendaftaran Kandidat (`/register-employee`)**: Menciptakan dokumen user dengan status `pending_approval` dan `role: "candidate"`. Data karyawan ini nantinya disetujui (dikelola) oleh admin via route `company.js`.
3. **Tracking & Sesi (Login/Logout)**: Saat login lewat `/login-google`, Firestore akan mencatat `lastLogin`, menghapus/menyalin `fcmTokens` (supaya tidak redundan antar perangkat), dan memberlakukan **Device Lock**. Saat `/logout`, semua jejak FCM Token di-tarik keluar (dibersihkan).

### Enum Value untuk Field pada Koleksi `users`
Kondisi seorang user di dalam aplikasi sangat bergantung pada kombinasi _role_ dan _status_:

**Daftar Nilai `status`:**
- `"pending_approval"` : User baru saja mendaftar via *public link* dan masih menunggu keputusan (Approve/Reject) Admin.
- `"active"` : Tervalidasi. Karyawan siap menggunakan sistem secara penuh (baik melalui jalur verifikasi Admin atau via daftar perusahaan otomatis).
- `"rejected"` : Pendaftaran partisipan ditolak (bisa mendaftar lagi dari awal).
- `"fired"` : Telah diberhentikan oleh eksekutif perusahaan (bisa mengajukan lamaran ke prusahaan lain/re-apply).
- `"company_deleted"` : Status khusus saat Owner meratakan bangunan (menghapus) perusahaannya. Seluruh karyawan dirombak ke status ini.
- `"pending_deletion"` : User secara personal menjadwalkan agar akun pribadinya dihapus, dan sedang berada pada masa tenggang waktu hapus.
- `"inactive" / "banned"` : Dilarang/di-*lock* temporer oleh Super Admin. Login selalu di-tolak.

**Daftar Nilai `role`:**
- `"candidate"` : Pasangan abadi dari status _pending_approval_. Belum ada kewenangan sama sekali.
- `"staff"` : Tunjangan hak akses normal untuk karyawan absen/tugas.
- `"admin"` : Level manajerial yang berhak memodifikasi perangkat, rekrutmen, hingga mutasi rekan kerjanya.
- `"rejected"` : Bila ditolak atau dipecat, `role` seringkali direndahkan jadi _rejected_ untuk mencegah manipulasi logic.

---

## Tabel Endpoint Lengkap

| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| `PUT` | `/login/sendlink` | ❌ | Melakukan request pengiriman kode OTP 6-digit ke Email yang sudah terdaftar. |
| `GET` | `/login/verifyOTP` | ❌ | Memvalidasi kode OTP dan mengembalikan akses login berupa Token JWT `30d`. |
| `POST` | `/login/login-google` | ❌ | Utama: Mobile Login menggunakan Google (Menerima `idToken` Firebase Authenticator). |
| `POST` | `/login/login-google-admin` | ❌ | Web: Akses khusus Panel Admin Website (Tanpa pembatasan FaceID, durasi JWT `12h`). |
| `POST` | `/login/logout` | ✅ | Mengakhiri sesi, membersihkan *Device Binding* di file `company` & `fcmTokens`. |
| `GET` | `/login/confirm-email` | ❌ | Akses halaman HTML konfirmasi klik link email verifikasi dari pengguna. |
| `POST` | `/login/registrasi` | ❌ | Pendaftaran Perusahaan & Konfigurasi Batasan *Storage Free Tier* Otomatis. |
| `POST` | `/login/register-employee` | ❌ | Kandidat mendaftarkan diri secara mandiri (terhubung otomatis ke perusahaan tujuan). |
| `POST` | `/login/request-reset-device` | ❌ | Permohonan reset peranti dari *User* → Mengirim Email konfirmasi reset ke *Admin*/Diri. |
| `GET` | `/login/admin/confirm-reset-device`| ❌ | Dieksekusi saat tombol/link dari Email di-klik untuk mengkonfirmasi reset perangkat. |
| `POST` | `/login/register-faceid` | ✅ | Merekam vektor / *file URL* gambar wajah (*Face ID*) milik karyawan ke sub-koleksi company. |
| `POST` | `/login/demo-login` | ❌ | Memberikan akses *bypass* (Demo) bagi *Reviewer* Apple App Store. |

---

## 1. Pendaftaran Otomatis Perusahaan (`/registrasi`)

Saat *founder* perusahaan mencoba daftar:
1. Endpoint menerima `idToken` (Google), nama perusahaan, dan telepon. 
2. Mengeksekusi pengecekan nomor telepon agar tidak terjadi duplikasi akun.
3. Looping generate *Company Code* yang unik secara dinamis (huruf C + AlphaNumeric).
4. **Menciptakan Free Tier Company**: Perusahaan didaftarkan pada kuota dasar `maxStorage: 104857600 (100MB)` serta inisialisasi Device Lock: `false`. Document dibuat di koleksi `companies`.
5. **Menciptakan User Admin**: Di waktu yang bersamaan menjalankan Transaksi Firestore (ACID) guna menyimpan data pengguna Google tersebut ke dokumen `users` bersangkutan dengan `role: "admin"`.

---

## 2. Alur Login (OTP & Google)

### A. Login Google (Aplikasi Mobile)
````mermaid
sequenceDiagram
    participant F as Mobile Flutter
    participant BE as Route /login
    participant FA as Firebase Auth
    participant DB as Firestore
    participant M as EmailHelper

    F->>BE: POST /login-google { idToken, deviceId, FcmToken }
    BE->>FA: verifyIdToken(idToken)
    FA-->>BE: Decoded Payload { email, uid }
    BE->>DB: Lookup users/{email}
    
    alt Akun Tidak Valid (Candidate, Banned, Ditolak)
        BE-->>F: 403 Forbidden Error Status 
    end

    BE->>BE: checkDeviceSecurity(companyData)
    alt Device Lock Gagal
        BE-->>F: 409 Conflict (Akun Lock/Perangkat Digunakan!)
    end

    BE->>BE: handleEmailVerification(db, user, email)
    alt Email Belum Terverifikasi
        BE->>M: Send Template "verification" & Register Cooldown
        BE-->>F: 403 Email belum Diverifikasi (Mohon cek inbox)
    end

    BE->>DB: Cleanup FCMToken duplikat dari User lain
    BE->>DB: Push FcmToken & Set LastLogin
    BE->>BE: Sign JWT Secret Token (30 Hari)
    BE-->>F: 200 { token, user: { email, role, nama } }
````

### B. Anti-Fraud & Keamanan Peranti (`checkDeviceSecurity`)
Ada 2 poin pembuktian bila `deviceLockEnabled == true`:
1. **Mis-match Account-Bound:** Apabila user mendarat menggunakan UUID *hardware* yang berbeda dengan saat awal aktivasi mereka `(bindings[safeEmail] !== incomingDeviceId)`.
2. **Device Stolen / Used:** Mencegat jikalau UUID *hardware* saat ini masih aktif melekat di alamat email kawan sekerja, memastikan 1 unit HP murni hanya bisa dipakai 1 orang *staff*.

Jikalau perangkat dinyatakan **berubah/dilarang**, sesi diblokir. Pekerja diwajibkan untuk menebus proses rekonsiliasi perangkat lewat panggillan API `/request-reset-device`.

---

## 3. Sistem Reset / Pencabutan *Device Lock*

Bila seorang staf membeli HP baru, *Device ID* tidak mencocokkan rekaman lama dan berujung dikunci.
1. Karyawan men-*trigger* `/request-reset-device` di halaman muka bersama `reason` (contoh: HP Hancur/Beli Baru). 
2. Back-End melingkungkan token aksi kedaluwarsa-3-hari (`RESET_DEVICE_CONFIRMATION`) ke dalam HTML *link button* khusus.
3. Apabila Staf tersebut bekerja di dalam naungan perusahaan, email terlempar **ke alamat Email Admin**. Sebaliknya khusus Staf wirausahawan dialamatkan ke email dirinya sendiri. 
4. Saat si penerima (Pimpinan) meng-Kelik tombol pada badan Email, ia dikirim ke GET `/admin/confirm-reset-device?token=...`.
5. JWT diteliti, selanjutnya field `deviceBindings` atas karyawan dicoret (dihapus). Alhasil Staf sukses dapat bermukim (login kembali) lewat gawainya yang baru!

---

## 4. Keamanan JWT Payload
Token dibuat saat login dan berlaku `30d` untuk karyawan, `12h` untuk manajemen Web.
```json
{
  "id": "emailterdaftar@gmail.com",
  "role": "admin",
  "idCompany": "C8ASDFM9",
  "status": "active",
  "deviceId": "hardware-uuidd-xxx",
  "fcmTokens": "push-message-token",
  "iat": 1700000000,
  "exp": 1702592000
}
```
> **Catatan:** Sesi kedaluwarsa (`expired`) mengembalikan kode unik 403, meminta Frontend membuato-lemparkan layar menuju ruang awal untuk re-Autentikasi.

---

## 5. Pendaftaran Kandidat / Calon Pegawai (`/register-employee`)

Digunakan ketika seorang pengguna Google mendaftarkan diri secara mandiri sebagai pelamar kerja (kandidat) ke suatu perusahaan.

- **Method & Path:** `POST /login/register-employee`
- **Auth:** Menggunakan `idToken` Firebase Google Auth di body (tanpa header Authorization).
- **Content-Type:** `application/json`

### Request Body Payload (JSON)
```json
{
  "idToken": "eyJhbGciOiJSUzI1NiIs...",
  "idCompany": "C_TEST_01",
  "noTelp": "081234567890",
  "noWa": "081234567890",
  "attachmentUrl": "https://cdn.vorce.id/user_storage/UID_123/1726743900000_cv_budi.pdf",
  "description": "Halo, saya Budi Santoso. Saya adalah Senior Flutter Developer dengan pengalaman 3 tahun di arsitektur BLoC dan Clean Architecture, tertarik melamar posisi Mobile Engineer."
}
```

### Penjelasan Detail Field Payload:

| Field | Tipe Data | Status | Keterangan & Aturan |
|---|---|---|---|
| **`idToken`** | `string` | **Wajib** | Token kredensial Firebase ID Token yang didapatkan dari proses Google Sign-In di aplikasi Flutter/Client (`GoogleAuthProvider.credential`). Digunakan untuk memverifikasi keaslian akun serta mengekstrak email, nama lengkap, foto profil, dan UID Firebase Auth pelamar. |
| **`idCompany`** | `string` | **Wajib** | Kode / ID unik perusahaan yang dituju (misal: `C_XYZ123`). ID ini divalidasi ke koleksi `companies`. Jika tidak ditemukan, API mengembalikan `404 Not Found`. |
| **`noTelp`** | `string` | **Wajib** | Nomor telepon seluler aktif milik pelamar (format string: `08...` atau `+62...`). Divalidasi oleh sistem agar tidak terjadi duplikasi akun dengan nomor telepon yang sama (`409 PHONE_ALREADY_EXISTS`). |
| **`noWa`** | `string` | *Opsional* | Nomor WhatsApp pelamar untuk komunikasi rekrutmen. Jika tidak diisi / `null`, sistem secara otomatis mengisinya sama dengan nilai `noTelp`. |
| **`attachmentUrl`** | `string` | *Opsional* | URL file berkas dokumen lamaran / Curriculum Vitae (CV) pelamar yang sudah diunggah dan tersimpan di **Personal Storage** milik pengguna (R2 Storage). URL ini dapat diakses langsung oleh Admin saat me-review berkas pelamar di layar `RecruitmentScreen`. Bernilai `null` jika pelamar belum melampirkan berkas. |
| **`description`** | `string` | *Opsional* | Surat pengantar / ringkasan bio / teks perkenalan singkat dari pelamar kepada pihak manajemen/HR perusahaan mengenai motivasi, keahlian, atau posisi yang diminati. Default: string kosong `""`. |

---

### Contoh Response Berhasil (HTTP 200 OK)
```json
{
  "message": "Pendaftaran berhasil dikirim",
  "info": "Silakan hubungi Admin perusahaan untuk konfirmasi akun Anda.",
  "user": {
    "email": "budi.santoso@gmail.com",
    "username": "Budi Santoso",
    "role": "candidate",
    "attachmentUrl": "https://cdn.vorce.id/user_storage/UID_123/1726743900000_cv_budi.pdf",
    "description": "Halo, saya Budi Santoso. Saya adalah Senior Flutter Developer dengan pengalaman 3 tahun di arsitektur BLoC dan Clean Architecture, tertarik melamar posisi Mobile Engineer."
  }
}
```

---

### Alur Integrasi ke Fitur Employee Management:
Saat endpoint ini dipanggil, backend menjalankan sinkronisasi data secara otomatis:
1. **Dual-Write User Dokumen (`users/{email}`)**:
   - Disimpan dengan `role: "candidate"` dan `status: "pending_approval"`.
   - Menyimpan field `attachmentUrl` dan `description` (serta field kompatibilitas `cvUrl` dan `applicantDesc`).
2. **Subkoleksi Karyawan Perusahaan (`companies/{idCompany}/employees/{email}`)**:
   - Disimpan sebagai dokumen pelamar dengan `status: "applicant"` dan `jabatan: "Pelamar / Applicant"`.
   - Menyimpan `attachmentUrl`, `description`, serta timestamp `appliedAt`.
   - Data ini **langsung tampil di layar Admin (`RecruitmentScreen`)** melalui `GET /api/company/applicants`.
3. **Audit Log Perusahaan**:
   - Mencatat aktivitas `NEW_APPLICANT` ke subkoleksi `companies/{idCompany}/activityLogs`.
4. **Notifikasi Email Admin**:
   - Mengirimkan email pemberitahuan ke alamat email pemilik/admin perusahaan (`createdBy`) yang berisi nama pelamar, kontak, isi perkenalan (`description`), dan tautan berkas CV (`attachmentUrl`).


