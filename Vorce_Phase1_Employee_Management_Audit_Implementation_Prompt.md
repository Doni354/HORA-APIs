# Vorce Phase 1 — Employee Management Audit & Implementation Prompt

## Context

Project **Vorce** sedang berada pada eksekusi **Phase 1: Core HR V2**.

Berdasarkan rancangan Phase 1, data karyawan dan applicant akan dipusatkan pada:

```text
companies/{company_id}/employees/{user_email}
```

dengan `status` yang membedakan `applicant`, `active`, `resigned`, dan `terminated`.

Fitur Personal Storage pada entitas user juga sudah mulai/selesai dikerjakan di BE. Tahap berikutnya adalah menyelesaikan **Employee Management** terlebih dahulu, sebelum melanjutkan perubahan pada flow pendaftaran perusahaan yang nantinya membutuhkan upload CV ke Personal Storage.

Referensi rancangan Phase 1 menetapkan bahwa employee management mencakup pemusatan data employee/applicant, migrasi/kompatibilitas data lama, detail profil karyawan, deactivate/kick dengan status nonaktif, serta kebutuhan export data. fileciteturn0file0L5-L34

---

# Tujuan Task

Jangan langsung mengubah kode.

Task pertama adalah **melakukan audit terhadap kondisi BE Vorce saat ini**, kemudian menyusun rencana implementasi Employee Management berdasarkan kondisi kode yang benar-benar ditemukan.

Setelah audit selesai, implementasikan perubahan yang diperlukan dengan tetap mempertahankan compatibility terhadap fitur existing selama tidak bertentangan dengan rancangan Phase 1.

> Fokus utama task ini adalah **Employee Management**.
>
> Jangan mengerjakan perubahan Recruitment / Join Company / Upload CV pada task ini. Integrasi CV ke Personal Storage akan dikerjakan pada task berikutnya.

---

# PART 1 — Audit Existing Backend

Sebelum melakukan perubahan apa pun, telusuri codebase BE secara menyeluruh.

## 1. Identifikasi struktur project

Cari dan dokumentasikan:

- framework/runtime yang digunakan
- struktur folder
- entry point API
- Cloud Functions yang digunakan
- Express router
- middleware
- authentication/authorization
- Firebase Admin SDK
- Firestore initialization
- utility/helper
- service layer jika ada
- repository/data-access layer jika ada
- validation layer
- error handling
- logging
- response format

Jangan berasumsi struktur project.

Gunakan struktur dan pola existing sebagai dasar implementasi.

---

## 2. Audit model/data karyawan saat ini

Cari seluruh penggunaan:

```text
users
companies
employees
company members
join company
applicant
employee
staff
admin
hr
resigned
terminated
```

Tujuan audit:

1. Temukan bagaimana employee saat ini direpresentasikan.
2. Temukan apakah data employee masih dihitung/dibaca langsung dari:

```text
users/{email}
```

3. Temukan apakah:

```text
companies/{company_id}/employees/{user_email}
```

sudah ada.
4. Jika sudah ada, identifikasi field yang benar-benar digunakan.
5. Jika belum ada, identifikasi seluruh lokasi yang perlu disesuaikan.
6. Temukan seluruh endpoint yang membaca atau mengubah data employee.
7. Temukan seluruh frontend/client flow yang bergantung terhadap response endpoint tersebut jika referensinya tersedia di repository.

---

# PART 2 — Cocokkan Dengan Target Data Model

Target utama Phase 1:

```text
companies/{company_id}/employees/{user_email}
```

Expected field:

| Field | Type | Keterangan |
|---|---|---|
| `userEmail` | string | Referensi ke `users` |
| `role` | string | Role employee di perusahaan |
| `status` | string | `applicant`, `active`, `resigned`, `terminated` |
| `joinDate` | timestamp | Tanggal mulai bergabung |
| `leaveBalance` | number | Sisa cuti |
| `shiftQuota` | number | Opsional |
| `config` | object | Konfigurasi employee |
| `cvUrl` | string | Khusus applicant |
| `applicantDesc` | string | Khusus applicant |

Referensi struktur tersebut berasal dari rancangan Phase 1. fileciteturn0file0L9-L21

### Instruksi penting

Jangan otomatis membuat semua field di atas jika codebase existing menunjukkan bahwa beberapa field:

- belum digunakan
- memiliki nama berbeda
- berasal dari sumber data lain
- tidak dibutuhkan oleh flow existing

Sebaliknya, jelaskan:

```text
Existing Field
Target Field
Action
Reason
```

Contoh:

```text
Existing: users.role
Target: companies/{company_id}/employees/{user_email}.role

Action:
- gunakan employee.role sebagai source of truth untuk role dalam konteks perusahaan
- users.role tetap dipertahankan jika masih digunakan untuk kebutuhan global

Reason:
- satu user dapat memiliki konteks berbeda pada perusahaan yang berbeda
```

Jangan membuat asumsi seperti contoh di atas sebagai fakta sebelum memeriksa codebase.

---

# PART 3 — Tentukan Source of Truth

Ini adalah bagian penting.

Analisis apakah kondisi sekarang menyebabkan data employee tersebar di beberapa tempat.

Contoh kemungkinan:

```text
users/{email}
companies/{company_id}
companies/{company_id}/employees/{email}
```

Tentukan:

1. Data mana yang merupakan profile global user.
2. Data mana yang merupakan membership perusahaan.
3. Data mana yang merupakan data HR employee.
4. Data mana yang merupakan data applicant.
5. Data mana yang hanya merupakan legacy compatibility.

Buat keputusan source of truth yang jelas.

Target desain Phase 1:

```text
User
 └── users/{email}
      └── profile/global data

Company
 └── companies/{company_id}
      └── employees/{user_email}
           ├── membership
           ├── HR data
           ├── employment status
           └── applicant data
```

Namun keputusan final harus mengikuti hasil audit codebase.

---

# PART 4 — Employee Management API Audit

Temukan endpoint existing yang berkaitan dengan:

- get employee
- get employees
- add employee
- update employee
- remove employee
- kick employee
- deactivate employee
- activate employee
- applicant
- company member
- employee profile
- HR employee list
- employee export

Untuk setiap endpoint, dokumentasikan:

```text
Method
Route
Authentication
Authorization
Input
Current Firestore Read
Current Firestore Write
Response
Consumers
Potential Breaking Change
```

Jika endpoint belum ada, tandai:

```text
MISSING
```

---

# PART 5 — Tentukan API Employee Management

Setelah audit, tentukan API minimum yang diperlukan.

Jangan membuat endpoint hanya karena terlihat bagus.

Endpoint harus mengikuti kebutuhan actual application.

Minimal evaluasi kebutuhan berikut:

## Employee List

Contoh:

```http
GET /companies/{companyId}/employees
```

Kebutuhan:

- mengambil employee perusahaan
- filter status jika diperlukan
- filter role jika diperlukan
- pagination jika dataset memungkinkan besar
- search jika memang dibutuhkan existing UI
- authorization HR/Admin/Owner sesuai sistem existing

---

## Employee Detail

Contoh:

```http
GET /companies/{companyId}/employees/{email}
```

Response harus cukup untuk halaman detail employee.

Evaluasi apakah data berikut perlu diambil:

- profile user
- employee role
- employment status
- join date
- leave balance
- shift quota
- employee config
- activity summary

Jangan membuat query tambahan jika data sebenarnya sudah tersedia di service existing.

---

## Update Employee

Contoh:

```http
PATCH /companies/{companyId}/employees/{email}
```

Evaluasi field mana yang boleh diubah.

Pisahkan:

### HR-editable fields

Contoh:

```text
role
leaveBalance
shiftQuota
config
```

### System-managed fields

Contoh:

```text
status
joinDate
```

Jika field tersebut seharusnya hanya berubah melalui business action tertentu, jangan izinkan arbitrary update.

---

# PART 6 — Employee Activation / Deactivation

Rancangan Phase 1 menyatakan bahwa action "kick" tidak menghapus data historis.

Status harus menjadi salah satu:

```text
resigned
terminated
```

dan data historis tetap tersedia. fileciteturn0file0L30-L32

Audit terlebih dahulu:

- apakah fitur kick sudah ada?
- apakah kick saat ini menghapus Firestore document?
- apakah kick menghapus user dari company?
- apakah kick mengubah field tertentu?
- apakah ada dependency terhadap status employee?
- apakah employee yang sudah nonaktif masih muncul di fitur attendance/task/chat/etc.?

## Business Rule

Implementasikan status transition secara eksplisit.

Contoh:

```text
active
  ├── resigned
  └── terminated
```

Jangan menggunakan delete document sebagai mekanisme utama untuk employee deactivation.

### Confirmation

BE harus memiliki business action yang jelas untuk deactivate.

Contoh:

```http
POST /companies/{companyId}/employees/{email}/deactivate
```

Body:

```json
{
  "status": "resigned"
}
```

atau bentuk lain yang lebih sesuai dengan architecture existing.

Jangan mengikuti contoh endpoint/body secara literal jika pola API existing berbeda.

---

# PART 7 — Authorization & Security

Audit authorization existing secara serius.

Pastikan employee management tidak memungkinkan:

```text
employee A mengubah employee B
staff mengubah HR
employee biasa melakukan kick
user dari company A membaca employee company B
```

Validasi minimal:

1. authenticated user
2. company membership
3. role/permission
4. target employee belongs to company
5. valid status transition
6. ownership/administrative authority

Gunakan middleware/permission system existing jika sudah tersedia.

Jangan membuat sistem authorization kedua jika sebenarnya sudah ada authorization layer.

---

# PART 8 — Legacy Compatibility

Rancangan Phase 1 menyebutkan bahwa data employee aktif akan dimigrasikan dari `users` ke subcollection `employees`, sementara legacy logic boleh tetap berjalan jika masih kompatibel. fileciteturn0file0L23-L26

Audit seluruh kode yang masih membaca employee langsung dari:

```text
users
```

Kelompokkan:

### A. Harus dipindahkan

Logic yang memang merupakan employee/company membership.

### B. Tetap di users

Data profile global user.

### C. Temporary compatibility

Logic lama yang belum aman untuk dipindahkan sekarang.

Buat migration strategy yang aman.

Jangan melakukan destructive migration.

---

# PART 9 — Migration Strategy

Jika migration diperlukan, buat strategy yang:

- idempotent
- aman dijalankan ulang
- tidak menghapus data lama
- dapat diverifikasi
- memiliki logging
- tidak menyebabkan duplicate data
- tidak merusak employee existing

Contoh konsep:

```text
users/{email}
       ↓
companies/{companyId}/employees/{email}
```

Namun companyId harus diperoleh dari relasi yang benar-benar ditemukan di codebase.

Jangan menebak companyId.

Jika terdapat employee yang tidak dapat dipetakan dengan aman:

```text
DO NOT MIGRATE AUTOMATICALLY
```

dan masukkan ke migration report.

---

# PART 10 — Activity / Employee Profile

Rancangan UI meminta halaman Detail Karyawan memiliki rekap "Riwayat Aktivitas" yang mencakup:

- Kehadiran harian
- Izin/Cuti
- Reimburse
- Tugas aktif/selesai
- Jadwal Shift

fileciteturn0file0L28-L34

Untuk BE, audit apakah masing-masing data tersebut sudah memiliki collection/service/API.

Buat mapping:

| Activity | Existing Source | Existing API | Need New API? |
|---|---|---|---|
| Attendance | ... | ... | ... |
| Leave | ... | ... | ... |
| Reimburse | ... | ... | ... |
| Task | ... | ... | ... |
| Shift | ... | ... | ... |

### Penting

Jangan langsung membuat seluruh activity endpoint jika belum dibutuhkan oleh current frontend.

Tujuan tahap ini adalah memastikan Employee Detail memiliki fondasi backend yang benar.

Jika activity sebenarnya sudah dapat diambil dari endpoint existing, gunakan kembali service tersebut.

---

# PART 11 — Export Employee Data

Rancangan Phase 1 meminta export laporan employee/attendance memiliki opsi tambahan:

```text
Durasi
Gaji
```

fileciteturn0file0L33-L34

Audit:

- apakah export employee sudah tersedia?
- apakah export attendance sudah tersedia?
- format file apa yang digunakan?
- apakah generation dilakukan di BE?
- bagaimana authorization-nya?
- dari mana field Durasi berasal?
- dari mana field Gaji berasal?
- apakah data tersebut sudah tersedia?

Jangan menambahkan field yang sumber datanya belum jelas.

Jika belum tersedia, tandai dependency.

---

# PART 12 — Firestore Query & Performance

Audit query employee management.

Perhatikan:

- query terhadap `employees`
- filter status
- filter role
- orderBy
- pagination
- document reads
- N+1 reads
- index requirement
- unnecessary full collection reads

Hindari pola seperti:

```text
GET all employees
→ GET user profile satu per satu
→ GET activity satu per satu
```

jika dapat menyebabkan N+1 reads.

Berikan rekomendasi optimasi berdasarkan codebase actual.

---

# PART 13 — API Response Consistency

Pastikan endpoint baru mengikuti response format existing.

Audit:

```text
success response
error response
HTTP status
error code
message
data
pagination
```

Jangan membuat format response baru tanpa alasan.

Jika existing BE memiliki standard response wrapper, gunakan standard tersebut.

---

# PART 14 — Validation & Error Handling

Validasi minimal:

- companyId valid
- email valid
- employee exists
- employee belongs to company
- role valid
- status valid
- status transition valid
- numeric fields valid
- permission valid

Gunakan validation library/pattern existing jika tersedia.

---

# PART 15 — Testing

Sebelum implementasi dianggap selesai, buat test/check untuk minimal:

### Employee List

```text
HR/Admin dapat melihat employee company sendiri.
User biasa tidak dapat mengakses jika tidak memiliki permission.
Company A tidak dapat melihat employee Company B.
```

### Employee Detail

```text
employee existing → berhasil
employee tidak ditemukan → 404 / equivalent existing error
employee dari company lain → ditolak
```

### Update

```text
authorized HR/Admin → berhasil
unauthorized user → ditolak
invalid field → ditolak
```

### Deactivate

```text
active → resigned
active → terminated
document tidak dihapus
historical data tetap ada
unauthorized user → ditolak
```

### Migration

```text
employee existing → dapat dimigrasikan
migration dijalankan dua kali → tidak duplicate / tidak corrupt
data tidak dapat dipetakan → tidak dipaksa migrate
```

---

# PART 16 — Implementation Rules

Setelah audit selesai, baru lakukan implementasi.

Ikuti aturan berikut:

1. **Jangan rewrite architecture tanpa kebutuhan.**
2. **Jangan menghapus endpoint existing jika masih digunakan.**
3. **Jangan menghapus data legacy sebelum compatibility terbukti.**
4. **Jangan membuat duplicate service jika service existing dapat digunakan.**
5. **Jangan membuat endpoint yang tidak memiliki consumer/use case.**
6. **Jangan melakukan destructive migration.**
7. **Jangan mengubah contract API existing tanpa menjelaskan breaking impact.**
8. **Gunakan pola coding existing project.**
9. **Pertahankan CommonJS/Node/runtime/project convention yang sudah digunakan project jika masih relevan.**
10. **Prioritaskan perubahan minimum yang menghasilkan Employee Management yang stabil.**

---

# PART 17 — Output Yang Wajib Dihasilkan

Sebelum coding:

Buat laporan:

```markdown
# Employee Management — Backend Audit

## Existing Architecture

## Existing Employee Flow

## Existing Firestore Structure

## Existing APIs

## Existing Authorization

## Existing Legacy Logic

## Gap Analysis

## Target Architecture

## Required Changes

## Migration Strategy

## Risks / Breaking Changes

## Implementation Plan
```

Setelah coding:

Buat summary:

```markdown
# Employee Management — Implementation Summary

## Changes Made

## New / Modified Endpoints

## Firestore Changes

## Authorization Changes

## Migration

## Compatibility

## Testing Performed

## Remaining Issues

## Next Step
```

---

# Definition of Done

Task Employee Management dianggap selesai apabila:

- [ ] kondisi BE existing sudah diaudit
- [ ] employee data flow sudah dipahami
- [ ] source of truth sudah ditentukan
- [ ] struktur `companies/{company_id}/employees/{user_email}` sudah sesuai kebutuhan
- [ ] employee list dapat berjalan
- [ ] employee detail dapat berjalan
- [ ] employee update memiliki authorization yang benar
- [ ] deactivate/kick menggunakan status, bukan destructive delete
- [ ] status `resigned` dan `terminated` ditangani dengan benar
- [ ] historical data tetap tersedia
- [ ] legacy flow tetap compatible atau sudah memiliki migration path
- [ ] migration aman dan idempotent jika memang diperlukan
- [ ] Firestore query tidak menimbulkan masalah performa yang jelas
- [ ] authorization antar-company aman
- [ ] testing dasar selesai
- [ ] tidak ada perubahan Recruitment / Join Company / CV Upload pada task ini

---

# Scope Boundary

## Kerjakan Sekarang

```text
Employee Management
├── Employee List
├── Employee Detail
├── Employee Update
├── Employee Status
├── Deactivate / Kick
├── Authorization
├── Migration / Compatibility
├── Activity Data Integration Analysis
└── Employee-related Export Analysis
```

## Jangan Kerjakan Sekarang

```text
Recruitment Flow
├── Join Company redesign
├── Job Application
├── Upload CV
├── CV → Personal Storage integration
└── applicant registration changes
```

Recruitment akan menjadi task berikutnya setelah Employee Management stabil.

Rancangan recruitment memang menempatkan data applicant pada `companies/{company_id}/employees/{user_email}` dan nantinya menambahkan CV serta deskripsi diri pada flow pendaftaran. fileciteturn0file0L63-L77

Personal Storage juga sudah ditentukan berada pada:

```text
users/{email}/files/{file_id}
```

dan ditujukan untuk file personal seperti CV/contract. fileciteturn0file0L36-L54

Karena itu, **jangan implementasikan integrasi CV sekarang**. Pastikan Employee Management selesai terlebih dahulu agar task recruitment berikutnya dapat langsung menggunakan fondasi tersebut.

---

# Final Instruction

**READ THE CODEBASE FIRST.**

Jangan menganggap struktur database, endpoint, authorization, atau service yang dijelaskan di prompt ini sudah ada.

Prompt ini adalah **target requirement**, bukan deskripsi kondisi codebase.

Urutan kerja wajib:

```text
1. Inspect
2. Understand
3. Audit
4. Report current condition
5. Identify gaps
6. Define target changes
7. Implement
8. Test
9. Report result
```

Jika menemukan conflict antara requirement ini dan implementation existing:

```text
DO NOT silently overwrite the existing behavior.
```

Jelaskan conflict tersebut, tentukan impact-nya, lalu pilih solusi yang paling aman untuk Phase 1.

Prioritas:

```text
Data Integrity
> Authorization & Security
> Backward Compatibility
> Correct Business Logic
> Performance
> Code Cleanliness
> Feature Completeness
```
