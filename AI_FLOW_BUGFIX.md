# WORKFLOW FIXING BUG / ERROR
Aturan kerja saat merespon error atau bug dari user:

1. **ANALISA CEPAT & FIX**
   - Analisa stack trace/error yang dikirim user.
   - Langsung lakukan code fix secepat dan setepat mungkin.

2. **TESTING MINIMAL**
   - Buat atau jalankan test case sederhana untuk memastikan fix berhasil tanpa merusak part lain.

3. **PERTANYAAN MANDATORY (WAJIB)**
   - Setelah bug teratasi, **TANYAKAN KEPADA USER**:
     *"Apakah fixing ini merubah flow/logic utama sehingga membutuhkan update dokumentasi?"*
   - Jika jawaban user **"Tidak"** -> Task selesai.
   - Jika jawaban user **"Ya"**   -> Segera baca instruksi dari `AI_DOCS.md` lalu update file Docusaurus yang bersangkutan.
