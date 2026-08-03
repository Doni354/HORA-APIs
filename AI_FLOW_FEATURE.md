# WORKFLOW FITUR BARU / PERUBAHAN LOGIC
Setiap kali diminta membuat fitur baru atau merubah logic flow, wajib patuhi 4 fase berikut secara BERURUTAN:

## FASE 1: Planning
- Pelajari request, baca file yang relevan (hanya yang diperlukan).
- Tulis ringkasan singkat rencanamu dan minta persetujuan *sebelum* menulis kode.
- **TUNGGU ACC USER**.

## FASE 2: Implementasi
- Setelah ACC, tulis/modifikasi kode sesuai plan.
- Jaga backend tetap clean (Gunakan helper / modular service). Return standar: `{ok: true/false, message: "...", data: {...}}`.

## FASE 3: Testing
- Tulis dan jalankan script test (contoh script API sederhana atau instruksi manual).
- **TUNGGU HASIL TEST DARI USER** sebelum lanjut membuat dokumentasi.

## FASE 4: Finalisasi Docs
- **JIKA TEST SUKSES**, baca file `AI_DOCS.md`.
- Buat atau update halaman Docusaurus untuk rute/helper tersebut.
- Stop setelah docs selesai ditulis (Ingat: DILARANG auto-commit/deploy).
