# Vorce — Improvement Fitur Tugas
## Dokumen Pembahasan UI/UX & Frontend

**Status:** Draft untuk diskusi tim  
**Fokus:** Perancangan pengalaman pengguna dan gambaran implementasi FE  
**Tujuan akhir:** Fondasi Project → Task → Assignment → Evidence → Review → Poin, yang nantinya menjadi sumber data fitur Kinerja.

---

## 1. Gambaran Singkat

Fitur Tugas saat ini masih berpusat pada tugas individual: admin membuat tugas, memilih karyawan, menentukan deadline, lalu karyawan mengirim lampiran untuk direview.

Fitur akan dikembangkan supaya pekerjaan dapat dikelompokkan ke dalam **Project**. Setiap project berisi beberapa task, dan setiap task dapat ditugaskan kepada satu atau beberapa pekerja.

```text
Company
└── Project
    ├── Informasi & timeline project
    ├── Nilai project (admin saja)
    └── Task
        ├── Timeline, prioritas, dan poin
        ├── Assignee / pekerja
        ├── Progres dan bukti pengerjaan
        ├── Review atau revisi
        └── Poin final setelah disetujui
```

### Prinsip yang harus dijaga

- **Project bukan task.** Project adalah wadah, task adalah pekerjaan spesifik di dalamnya.
- **Poin bukan uang.** Poin menjadi indikator kontribusi untuk evaluasi kinerja, bukan otomatis menjadi nominal gaji.
- **Nilai finansial project hanya terlihat oleh admin.** Jangan sekadar menyembunyikan nominal di UI; FE hanya boleh mengambilnya dari endpoint yang memang berizin.
- **Poin final diberikan setelah hasil disetujui.** Submit pekerjaan belum berarti pekerjaan sudah selesai.
- **Evidence dan revisi memiliki histori.** Bukti submission lama tidak ditimpa ketika pekerja mengirim ulang.
- **Riwayat tugas tidak hilang saat pekerja keluar.** Status hubungan kerja tetap dikelola di Management Karyawan.

## 2. Ruang Lingkup

### Masuk fase ini

1. Daftar, buat, edit, dan lihat detail Project.
2. Membuat Task dari dalam Project.
3. Mengatur judul, deskripsi, prioritas, tanggal mulai, deadline, assignee, dan poin.
4. Melihat progres dan timeline task.
5. Mengirim laporan serta bukti pengerjaan.
6. Admin menyetujui hasil atau meminta revisi.
7. Menampilkan poin dasar dan poin final secara jelas.
8. Mempertahankan tampilan task lama yang belum memiliki Project.

### Belum masuk fase ini

- Kalkulasi gaji, slip gaji, pajak, atau pembayaran freelancer.
- Konversi poin ke uang.
- Sistem timesheet atau pencatatan jam kerja lengkap.
- Bonus percepatan otomatis yang langsung aktif. Untuk awal, cukup tampilkan dan simpan data waktu sebagai dasar evaluasi; aturan bonus perlu disepakati dahulu.
- Perombakan modul Management Karyawan.

---

## 3. Peran Pengguna

| Peran | Kebutuhan utama |
|---|---|
| **Admin / Owner** | Mengelola project, membuat task, menetapkan pekerja dan poin, melihat nilai finansial, meninjau bukti, meminta revisi, dan menyetujui hasil. |
| **Pekerja / Assignee** | Melihat project/task yang relevan dengannya, memahami deadline dan poin, memperbarui progres, mengirim bukti, serta melihat hasil review. |

Jenis pekerja (tetap, kontrak, harian, freelancer) tidak perlu menjadi pengaturan baru di fitur Tugas. Identitas dan status hubungan kerja tetap mengikuti Management Karyawan; fitur Tugas menggunakan daftar pekerja yang valid untuk diberi tugas.

---

## 4. Usulan Navigasi

Tambahkan **Project** sebagai pintu masuk pengelolaan pekerjaan. Jangan membuat Project hanya berupa label/filter di halaman Tugas.

```text
Menu Pekerjaan
├── Project
│   ├── Daftar Project
│   ├── Detail Project
│   └── Buat / Edit Project
└── Tugas Saya
    ├── Daftar task yang ditugaskan kepada saya
    └── Detail task dan submission
```

Untuk admin, halaman Project perlu menyediakan akses menuju daftar task dan tindakan review. Untuk pekerja, navigasi sebaiknya tetap berfokus pada **Tugas Saya** agar tidak perlu memahami pengelolaan project secara administratif.

Task lama yang belum memiliki project tetap tersedia dalam grup **Tugas Lama / Tanpa Project**. Jangan memaksa data lama masuk ke project buatan otomatis.

---

## 5. Gambaran UI yang Perlu Dirancang

Wireframe di bawah adalah arahan struktur, bukan desain visual final. UI/UX menyesuaikan komponen, warna, dan pola navigasi Vorce yang sudah ada.

### A. Halaman Daftar Project — Admin

Tujuan: admin dapat memindai project yang sedang berjalan dan mengetahui progresnya dengan cepat.

```text
┌────────────────────────────────────────────────────────────┐
│ Project                                   [ + Buat Project ]│
│ Kelola project dan pekerjaan tim                            │
│                                                            │
│ [Cari project...] [Status ▼] [Periode ▼]                    │
│                                                            │
│ ┌────────────────────────────────────────────────────────┐ │
│ │ Renovasi Kantor                 [Aktif]                 │ │
│ │ PIC: Budi  •  12–25 Okt                                │ │
│ │ Progress task: 6/10 selesai     ██████░░░░              │ │
│ │ Deadline: 25 Okt                         [Lihat Detail] │ │
│ └────────────────────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────────────────────┐ │
│ │ Website Company Profile        [Draft]                 │ │
│ │ PIC: Siti  •  20–30 Okt                                │ │
│ │ Belum ada task                         [Lihat Detail]  │ │
│ └────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

**Elemen penting:** nama project, status, PIC, periode, progres task, deadline, pencarian/filter, dan aksi buat project.

Nominal project tidak perlu tampil sebagai informasi utama di kartu. Nilai finansial berada di detail project untuk admin saja.

### B. Form Buat / Edit Project — Admin

Gunakan form yang ringkas dan dikelompokkan agar admin tidak merasa sedang mengisi terlalu banyak field sekaligus.

```text
┌─────────────────────────────────────────────────────┐
│ Buat Project                                        │
│                                                     │
│ Informasi Project                                   │
│ [Nama project...................................]   │
│ [Deskripsi.......................................]  │
│ [Penanggung jawab / PIC ▼]                          │
│                                                     │
│ Timeline                                            │
│ [Tanggal mulai 📅]       [Deadline 📅]               │
│                                                     │
│ Nilai Finansial (khusus admin)                      │
│ [Nilai project Rp...............................]   │
│ [Anggaran internal Rp............................]  │
│                                                     │
│                         [Batal] [Simpan Project]    │
└─────────────────────────────────────────────────────┘
```

- Bagian finansial hanya muncul pada pengalaman admin dan harus memakai endpoint admin-only.
- Bedakan **nilai project/kontrak** dengan **anggaran internal**. Keduanya opsional dan tidak selalu sama.
- Project bisa dibuat tanpa nilai finansial jika bukan project komersial.
- Sesudah berhasil dibuat, arahkan admin ke halaman detail project dengan aksi **Tambah Task**.

### C. Detail Project — Admin

```text
┌────────────────────────────────────────────────────────────┐
│ ← Project     Renovasi Kantor              [Edit] [•••]     │
│ Aktif • PIC: Budi • 12–25 Okt                               │
│ [Deskripsi project]                                         │
│                                                            │
│ Progress task     6/10 selesai     Deadline 25 Okt           │
│ ████████████░░░░░░                                           │
│                                                            │
│ Ringkasan Finansial (admin)                                 │
│ Nilai project: Rp xx.xxx.xxx  |  Anggaran: Rp xx.xxx.xxx    │
│                                                            │
│ Daftar Task                           [ + Tambah Task ]     │
│ [Semua ▼] [Status ▼] [Assignee ▼] [Cari task...]            │
│ ┌────────────────────────────────────────────────────────┐  │
│ │ Pemasangan bata  [Proses]  Agus  • Deadline 16 Okt     │  │
│ │ 20 poin • Bukti terakhir: 14 Okt        [Lihat Task]   │  │
│ └────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

**Arah UX:** detail project menjadi pusat pengelolaan. Admin dapat memantau progres, mengelola task, dan membuka task untuk review. Ringkasan finansial hanya tampil untuk admin.

### D. Form Buat Task — Admin

Form perlu menekankan urutan berpikir admin: **pekerjaan apa → siapa yang mengerjakan → kapan → dinilai bagaimana**.

```text
┌─────────────────────────────────────────────────────┐
│ Tambah Task                                         │
│ Project: Renovasi Kantor                            │
│                                                     │
│ Detail Pekerjaan                                    │
│ [Judul task......................................]  │
│ [Instruksi / kriteria selesai....................]  │
│ [Prioritas ▼]                                       │
│                                                     │
│ Timeline                                            │
│ [Tanggal mulai 📅]       [Deadline 📅]               │
│                                                     │
│ Penugasan                                           │
│ [Pilih pekerja... ▼]                                │
│ Pekerja terpilih:                                   │
│ • Agus      [Alokasi poin 100% ▼]                   │
│                                                     │
│ Penilaian                                           │
│ Poin dasar: [20]                                    │
│ Bonus percepatan: [Tidak aktif ▼]                   │
│                                                     │
│ [Batal]                         [Terbitkan Task]    │
└─────────────────────────────────────────────────────┘
```

**Catatan perilaku:**

- Project dipilih dari konteks halaman detail project; `projectId` tidak perlu diminta lagi bila form dibuka dari sana.
- Satu task dapat memiliki lebih dari satu assignee. Jika multi-assignee dipakai, admin harus bisa melihat alokasi poin masing-masing sebelum menerbitkan task.
- Pilihan awal yang disarankan adalah pembagian rata yang bisa dikonfirmasi admin; jangan otomatis memberi poin penuh kepada setiap orang tanpa aturan yang jelas.
- Poin dasar tidak boleh negatif. Tampilkan penjelasan singkat bahwa poin bukan uang.
- Bonus kecepatan nonaktif secara default. Jika kebijakan bonus belum disepakati, UI cukup menampilkan indikator bahwa waktu submit akan direkam.
- Setelah task mulai dikerjakan, perubahan deadline/poin perlu diberi konfirmasi dan tercatat di histori.

### E. Detail Task — Admin

```text
┌────────────────────────────────────────────────────────────┐
│ ← Renovasi Kantor     Pemasangan Bata            [•••]      │
│ [Proses]   Prioritas: Tinggi                                │
│                                                            │
│ Instruksi dan kriteria selesai                              │
│ ...                                                        │
│                                                            │
│ Timeline                                                    │
│ Mulai: 12 Okt     Deadline: 16 Okt     Submit: 15 Okt        │
│                                                            │
│ Pekerja & Poin                                              │
│ Agus — Proses — alokasi 100% — 20 poin dasar                │
│                                                            │
│ Aktivitas / Bukti Pengerjaan                                │
│ 15 Okt • Agus mengirim laporan                              │
│ [Laporan teks] [Buka file/foto]                             │
│                                                            │
│ Review Admin                                                │
│ [Catatan review / revisi.................................]  │
│                     [Minta Revisi] [Setujui Hasil]          │
└────────────────────────────────────────────────────────────┘
```

- Bukti dan submission tampil sebagai histori kronologis, bukan mengganti bukti sebelumnya.
- Tombol **Setujui Hasil** hanya tersedia untuk admin ketika ada submission yang bisa direview.
- Tombol **Minta Revisi** mewajibkan catatan yang jelas.
- Poin final tampil setelah persetujuan. Sebelum itu gunakan label **Belum dinilai**, bukan `0 poin`.

### F. Tugas Saya — Pekerja

```text
┌────────────────────────────────────────────────────────┐
│ Tugas Saya                                             │
│ [Semua] [Perlu Dikerjakan] [Review] [Revisi] [Selesai] │
│                                                        │
│ ┌────────────────────────────────────────────────────┐ │
│ │ Renovasi Kantor / Pemasangan Bata                  │ │
│ │ [Proses]                                           │ │
│ │ Deadline 16 Okt • 20 poin dasar                    │ │
│ │                               [Buka Detail]        │ │
│ └────────────────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────────────────┐ │
│ │ Website / Implementasi Login                       │ │
│ │ [Revisi]                                           │ │
│ │ Deadline 20 Okt • Ada catatan dari admin           │ │
│ │                               [Buka Detail]        │ │
│ └────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

Pekerja hanya melihat task yang ditugaskan kepadanya. **Nominal nilai/anggaran project tidak boleh muncul** di kartu, detail, payload API, maupun state FE milik pekerja.

### G. Detail Task — Pekerja: Progres dan Bukti

```text
┌─────────────────────────────────────────────────────┐
│ Pemasangan Bata                      [Proses]        │
│ Project: Renovasi Kantor                            │
│ Deadline: 16 Okt • Bobot: 20 poin                   │
│                                                     │
│ Instruksi / kriteria selesai                        │
│ ...                                                 │
│                                                     │
│ Aktivitas dan Bukti                                 │
│ [Histori submission, komentar, dan catatan revisi]  │
│                                                     │
│ Laporan pengerjaan                                  │
│ [Jelaskan pekerjaan yang sudah dilakukan.........]  │
│ [ + Tambah Foto / File ]                            │
│                                                     │
│             [Simpan Draft] [Kirim untuk Review]     │
└─────────────────────────────────────────────────────┘
```

- Pekerja dapat mulai mengerjakan, menambahkan laporan/evidence, dan mengirim pekerjaan untuk review.
- Setelah dikirim, tampilkan status **Menunggu Review** dan nonaktifkan submit berulang kecuali memang mengirim revisi.
- Bila revisi diminta, catatan admin harus terlihat jelas dan pekerja dapat mengirim submission versi baru.
- Waktu mulai dan waktu setiap submission direkam agar bisa digunakan untuk kinerja di masa depan.

---

## 6. Status yang Ditampilkan di UI

Status lama di BE memiliki perilaku yang kurang sesuai dengan nama: `Tunda` saat ini dipakai untuk menunggu review admin. Pada UI target, gunakan istilah yang menjelaskan aksi sebenarnya.

| Label UI target | Makna | Aksi berikutnya |
|---|---|---|
| **Belum Dimulai** | Task sudah ditugaskan, belum mulai dikerjakan | Pekerja mulai |
| **Proses** | Sedang dikerjakan | Update progres / kirim bukti |
| **Review** | Bukti sudah dikirim, menunggu admin | Admin review |
| **Revisi** | Ada perbaikan yang diminta admin | Pekerja kirim versi baru |
| **Selesai** | Hasil sudah disetujui | Lihat histori dan poin final |
| **Dibatalkan** | Task tidak dilanjutkan | Lihat alasan |

FE perlu memetakan status lama agar task existing tidak salah ditampilkan. Selama masa kompatibilitas, status BE lama `Tunda` dipetakan ke label UI **Review** sesuai makna aktualnya. Jangan langsung mengubah enum di FE tanpa koordinasi kontrak API dengan BE.

---

## 7. Panduan Implementasi Frontend

### Komponen yang bisa digunakan ulang

- `ProjectCard` / `ProjectListItem`
- `ProjectProgressSummary`
- `TaskCard` / `TaskListItem`
- `StatusBadge`
- `AssigneeSelector` dan `AssigneePointAllocation`
- `TimelineFields`
- `EvidenceUploader` dan `SubmissionHistory`
- `ReviewPanel`
- `PointSummary`
- `EmptyState`, `LoadingState`, `ErrorState`, dan `ConfirmDialog`

Nama komponen bersifat usulan dan boleh mengikuti konvensi codebase.

### State UI yang wajib dirancang

Setiap halaman minimal memiliki kondisi:

- Loading / data sedang dimuat.
- Empty state: belum ada project, belum ada task, atau bukti belum tersedia.
- Error state dan aksi mencoba lagi.
- Forbidden / tidak memiliki akses.
- Submit sedang diproses untuk mencegah klik berulang.
- Validasi form, khususnya deadline, poin, dan alokasi multi-assignee.
- Project/task archived atau cancelled.
- Data legacy yang belum memiliki project, judul, atau poin.

### Aturan FE yang penting

1. FE mengikuti role dan permission dari BE, tetapi **validasi akses tidak boleh hanya mengandalkan penyembunyian tombol**.
2. Jangan mengasumsikan task memiliki `title`, `projectId`, atau `basePoints` untuk semua data lama.
3. Jangan menganggap `0 poin` sama dengan belum dinilai.
4. Tampilkan nominal finansial hanya jika data berasal dari endpoint finance yang khusus admin.
5. Gunakan waktu dari response BE untuk histori resmi; jangan menghitung waktu submit/approval hanya dari jam perangkat.
6. Setelah create/update/review berhasil, perbarui data daftar dan detail secara konsisten.
7. Hindari hard-delete task yang telah memiliki histori; gunakan pembatalan/arsip sesuai kontrak BE.

---

## 8. Catatan Backend yang Berpengaruh ke FE

Bagian ini bukan spesifikasi API lengkap. Tim BE perlu menyepakati kontrak final sebelum integrasi.

| Temuan kondisi sekarang | Dampak ke FE / kebutuhan perbaikan |
|---|---|
| Task belum menyimpan `title`, `priority`, `projectId`, dan poin | Form/list/detail baru membutuhkan kontrak field baru; data lama perlu fallback. |
| Assignee disimpan sebagai array email/nama/foto | Penugasan baru perlu progres dan poin per pekerja; disarankan model assignment individual. |
| `Tunda` berarti menunggu review | Perlu mapping sementara ke label **Review** dan transisi status yang konsisten. |
| List task berpotensi menampilkan task seluruh company ke staff | BE harus membatasi hasil ke task yang memang ditugaskan kepada pekerja tersebut. |
| Endpoint attachment belum memvalidasi assignee terkait | BE harus menolak akses ke task orang lain, termasuk jika request dibuat langsung. |
| Attachment disimpan di array task | Bukti/submission baru sebaiknya memiliki histori tersendiri agar dokumen tidak terus membesar. |
| Belum ada Project | Dibutuhkan API daftar, detail, create/update, dan endpoint finansial admin-only. |

### Kontrak API minimum yang perlu disepakati

- Daftar dan detail Project, termasuk filter status/pencarian/pagination.
- Create/update Project dan endpoint finance khusus admin.
- Daftar/detail Task dengan filter `projectId`, status, dan assignee.
- Create/update Task dalam Project.
- Mulai task, kirim submission/evidence, review approve/revision.
- Response status, timestamp, poin dasar/final, dan histori submission.
- Format error untuk validasi, data tidak ditemukan, dan akses ditolak.

Nama endpoint final mengikuti konvensi API Vorce. FE tidak perlu mengunci URL pada wireframe; gunakan service/API layer yang terpisah dari komponen UI.

---

## 9. Deliverable yang Diharapkan dari Tiap Tim

### UI/UX

- [ ] User flow Admin dan Pekerja.
- [ ] Wireframe daftar project, form project, detail project, form task, detail task admin, Tugas Saya, dan detail task pekerja.
- [ ] State loading, empty, error, forbidden, review, revisi, selesai, dan task legacy.
- [ ] Desain alokasi poin saat task memiliki beberapa assignee.
- [ ] Penjelasan visual bahwa poin bukan uang dan nominal project hanya untuk admin.
- [ ] Prototype atau anotasi perilaku tombol dan transisi status.

### Frontend

- [ ] Sepakati daftar screen, komponen reusable, dan navigasi berdasarkan desain yang disepakati.
- [ ] Pisahkan API/service layer dari komponen UI.
- [ ] Tangani semua status serta data task legacy.
- [ ] Implementasikan form validation, upload evidence, submission history, dan review UI.
- [ ] Terapkan permission-aware UI tanpa menjadikan FE sebagai satu-satunya kontrol keamanan.
- [ ] Siapkan test untuk multi-assignee, revisi, akses finance, dan kondisi data kosong/error.

### Backend

- [ ] Finalisasi kontrak project/task/assignment/submission.
- [ ] Perbaiki akses list/detail/attachment agar pekerja tidak dapat mengakses task orang lain.
- [ ] Sediakan route finansial project admin-only.
- [ ] Sepakati transisi status, aturan alokasi poin, dan timestamp yang menjadi sumber kebenaran.
- [ ] Pastikan data legacy tetap dapat dibaca selama migrasi.

---

## 10. Keputusan untuk Dibahas Bersama

Gunakan nilai rekomendasi berikut sebagai titik awal diskusi, bukan keputusan final yang tidak boleh diubah.

| Topik | Rekomendasi awal |
|---|---|
| Apakah task baru wajib masuk project? | Ya. Task lama tetap didukung sebagai legacy. |
| Siapa yang melihat nilai project? | Admin saja, melalui endpoint khusus. |
| Apakah poin adalah uang? | Tidak. Poin untuk indikator kontribusi/kinerja. |
| Kapan poin menjadi final? | Setelah hasil submission disetujui admin. |
| Bagaimana task multi-assignee mendapat poin? | Total poin dibagi secara eksplisit; pembagian terlihat sebelum task diterbitkan. |
| Apakah bonus kerja cepat aktif dari awal? | Tidak. Waktu tetap dicatat, bonus menunggu persetujuan aturan bisnis. |
| Apakah bukti lama ditimpa saat revisi? | Tidak. Setiap submission menjadi histori versi baru. |
| Apakah task lama langsung dipaksa masuk project? | Tidak. Tampilkan di grup Tugas Lama / Tanpa Project. |
| Apakah task selesai boleh dihapus permanen? | Secara normal tidak; gunakan arsip/cancel dengan histori. |

---

## 11. Kriteria Siap Masuk Implementasi

Perancangan UI/UX dan FE siap dilanjutkan setelah:

- [ ] User flow dan wireframe utama disepakati tim.
- [ ] Definisi status dan perilaku tombol sudah jelas.
- [ ] Pola alokasi poin untuk task multi-assignee sudah diputuskan.
- [ ] Perilaku poin final, submission, dan revisi sudah dipahami semua tim.
- [ ] Batas akses nominal finansial disepakati dan didukung kontrak BE.
- [ ] Kontrak API minimum serta strategi kompatibilitas task lama telah disepakati.

**Urutan delivery yang disarankan:** Project list/detail → create Project → create Task → Tugas Saya dan detail Task → submission/evidence → review/revisi → poin final. Fokus fase ini adalah memantapkan penugasan sebagai fondasi fitur Kinerja; penggajian menyusul setelah data Kinerja dinilai benar.
