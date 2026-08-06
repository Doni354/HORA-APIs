---
id: company
sidebar_position: 10
title: Company Management
---

# Route — `company.js`

## Tujuan
Manajemen operasional perusahaan yang meliputi pengelolaan data karyawan (onboarding, promote/demote role, memecat), pendaftaran kandidat melalui undangan email maupun link publik, pengaturan fitur keamanan perusahaan (Device Lock), hingga pencatatan log aktivitas dan penghapusan data secara menyeluruh.

---

## Endpoints

| Method | Path | Auth | Role | Deskripsi |
|---|---|---|---|---|
| `POST` | `/company/verify-employee` | ✅ | Admin | Menerima (`staff`) atau menolak (`rejected`) lamaran kandidat. |
| `POST` | `/company/fire-employee` | ✅ | Admin | Mengeluarkan karyawan dari perusahaan. |
| `POST` | `/company/update-role` | ✅ | Admin | Promote (menjadi admin) atau demote (menjadi staff) role karyawan. |
| `GET` | `/company/log-activity` | ✅ | Any | Mengambil log aktivitas perusahaan. |
| `POST` | `/company/log-activity` | ✅ | Any | Membuat log aktivitas baru. |
| `GET` | `/company/list` | ✅ | Any | Mengambil daftar pegawai beserta info limitasi storage. |
| `POST` | `/company/send-invite` | ✅ | Admin | Mengirimkan link undangan bergabung via Email. |
| `POST` | `/company/accept-invite` | ❌* | Any | Memvalidasi dan menerima undangan (butuh `idToken` di *body*). |
| `GET` | `/company/apply-company/:idCompany` | ❌ | Any | (Public) Mengambil info perusahaan untuk tampilan lamaran. |
| `POST` | `/company/apply` | ❌* | Any | Kandidat melamar pekerjaan (butuh `idToken` di *body*). |
| `GET` | `/company/public-link` | ✅ | Any | Mendapatkan link lamaran pekerjaan publik (untuk di-*share* Admin). |
| `POST` | `/company/toggle-device-lock` | ✅ | Admin | Mengaktifkan/menonaktifkan *Device Lock* (1 user 1 HP). |
| `DELETE` | `/company/delete-company` | ✅ | Owner | Menghapus perusahaan dan SELURUH data miliknya (termasuk file R2). |

*\*Tidak memakai middleware `verifyToken`, namun memverifikasi `idToken` langsung secara mandiri di controller menggunakan Firebase Admin Auth.*

---

## 1. Onboarding Karyawan

Karyawan bisa bergabung dengan dua cara:
1. **Via Undangan Admin (`/send-invite` & `/accept-invite`)**
   Admin membuat kode undangan sementara yang disimpan di `invitations` collection selama 24 jam. Karyawan yang mendapatkan link lewat email otomatis langsung menjadi **Staff** ketika klik bergabung.
2. **Via Public Link (`/apply` & `/verify-employee`)**
   Karyawan mendaftar dari web perusahaan tanpa diundang, masuk ke database dengan **status Candidate**. Admin kemudian menyetujui lamaran (panggil `/verify-employee`).

### POST `/verify-employee` — Persetujuan Kandidat

````mermaid
sequenceDiagram
    participant FE as Frontend Apps
    participant BE as Route /company
    participant DB as Firestore
    participant M as EmailHelper

    FE->>BE: POST /verify-employee { targetEmail, approved }
    BE->>BE: Check adminRole, Target = "candidate"
    
    alt "approved == true"
        BE->>BE: checkCompanyQuota()
        BE->>DB: role = "staff", status = "active", company.totalEmployees += 1
        BE->>DB: Log "APPROVE_EMPLOYEE"
        BE->>M: Send "employee_approved" email
        BE-->>FE: 200 Pegawai diterima
    else "approved == false"
        BE->>DB: role = "rejected", status = "rejected"
        BE->>DB: Log "REJECT_EMPLOYEE"
        BE->>M: Send "employee_rejected" email
        BE-->>FE: 200 Pegawai ditolak
    end
````

---

## 2. Pemecatan & Manajemen Jabatan

### POST `/fire-employee`

Hanya Admin yang berhak memecat (tidak dapat menargetkan Pemilik Perusahaan / *Owner*).

````mermaid
flowchart LR
    A["POST /fire-employee { targetEmail, reason }"] --> B["Validasi: role admin"]
    B --> C["Cek target dan actor \n(proteksi Owner UID)"]
    C --> D["Update target:\nstatus = 'fired', idCompany = null"]
    D --> E["companies.totalEmployees -= 1"]
    E --> F["Email employee_fired & Log Activity"]
````
Setelah dipecat:
- `idCompany` menjadi `null`. Karyawan terbebas dan dapat melamar ke company lain. 
- *Device Binding* yang terpasang otomatis dicabut ketika company mencoba memvalidasi sesi berikutnya, namun ID khusus ini akan ditarik.

### POST `/update-role`
Admin mengirimkan atribut `action` berupa `"promote"` atau `"demote"`.
Proses ini dilengkapi *Notifikasi Dalam Aplikasi* ke collection `users/{targetEmail}/notifications` jika berhasil.

---

## 3. Fitur Device Lock

### POST `/toggle-device-lock`
Menerima struktur data di JSON body `{ enabled: true/false }`. 
Fitur membatasi pengguna login di perangkat yang berbeda. Apabila `enabled` di-*set* aktif, namun belum ada object `deviceBindings` di dokumen perusahaan, maka field ini akan diinisialisasi otomatis ke *dictionary* kosong. Saat dinonaktifkan, seluruh `deviceBindings` ikut dibersihkan (reset ke `{}`).

---

## 4. Delete Company (Nuclear Option)

### DELETE `/delete-company`
Aksi berbahaya ini hanya bisa dipicu oleh **Owner Perusahaan** (atribut `createdBy` == `actor.email`).
Alur lengkap:
1. Kick dan reset seluruh karyawan di Firestore menjadi `idCompany`: null, role `rejected`.
2. Kirim email pemberitahuan ke setiap karyawan secara paralel.
3. Connect ke Cloudflare R2 untuk melakukan operasi melibas / *recursive delete* semua *file storage* (contoh: *attachment* slip gaji atau rekam jejak lamaran) yang berawalan `company_files/{idCompany}/`.
4. Berantas (*delete collection*) semua sub-koleksi bersarang milik Firestore: `files`, `logs`, `leaves`, `tasks`.
5. Hapus dokumen utama perusahaan.
6. Catat sejarah penghapusan ke dalam koleksi rahasia `super_admin_logs`.
