# Panel Web Nokos WA

Platform jual-beli nomor kosong (Nokos) WhatsApp berbasis Node.js + Express + Firebase Realtime Database.

## Setup

### 1. Konfigurasi Firebase

**Backend (`.env`):**
```
copy .env.example .env
```
Isi `.env` dengan kredensial Firebase project kamu:
- `FIREBASE_PROJECT_ID` � Project ID dari Firebase Console
- `FIREBASE_CLIENT_EMAIL` � Email dari service account key (JSON)
- `FIREBASE_PRIVATE_KEY` � Private key dari service account key (JSON)
- `FIREBASE_DATABASE_URL` � URL Realtime Database (contoh: `https://nama-project-default-rtdb.firebaseio.com`)
- `TELEGRAM_BOT_TOKEN` � Token bot Telegram dari BotFather
- `ADMIN_CHAT_ID` � Chat ID Telegram admin untuk notifikasi
- `ADMIN_SECRET_UID` � UID user Firebase yang dijadikan admin

### Deploy ke Vercel

Hubungkan repository GitHub ke Vercel dan deploy dari folder root repository. Vercel akan mendeteksi aplikasi Express dari `server.js`. Jangan menjalankan `bot.js` sebagai Vercel Function.

Tambahkan Environment Variables berikut di **Vercel Project Settings → Environment Variables** untuk setiap environment yang dipakai (Production, Preview, dan Development):

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY` — tempel private key service account; jika baris baru tersimpan sebagai `\n`, aplikasi akan mengubahnya.
- `FIREBASE_DATABASE_URL`
- `TELEGRAM_BOT_TOKEN`
- `ADMIN_CHAT_ID`
- `ADMIN_SECRET_UID`
- `PAKASIR_SLUG`
- `PAKASIR_API_KEY`
- `PAKASIR_WEBHOOK_SECRET`

Jangan gunakan `FIREBASE_SERVICE_ACCOUNT_PATH` di Vercel kecuali file service account memang disertakan dengan aman pada build. Gunakan variabel service account di atas. Setelah mengubah variabel Vercel, buat deployment baru.

Periksa **Deployment → Functions → Logs** jika fungsi masih gagal. Error konfigurasi Firebase sekarang menyebut nama variabel yang belum diisi; jangan kirim nilai rahasia ke log atau chat.

Vercel Functions tidak menjalankan proses dan timer background secara terus-menerus. Karena itu, `ExpiryGuardian` yang berjalan tiap 30 detik hanya aktif saat server dijalankan langsung dengan `npm start`; untuk menjalankan expiry otomatis di Vercel, gunakan scheduler eksternal atau worker/server yang selalu hidup. Bot interaktif `bot.js` menggunakan polling dan perlu dijalankan di worker/server yang selalu hidup, bukan di Vercel Functions.

Jika token Telegram pernah di-commit atau di-push ke GitHub, revoke token lama lewat BotFather lalu perbarui `TELEGRAM_BOT_TOKEN` di Vercel dan `.env`.

**Frontend (`public/js/firebase-config.js`):**
Ganti nilai placeholder di file ini dengan config Firebase web app kamu (dari Firebase Console ? Project Settings ? Your apps).

### 2. Jalankan Server

```bash
npm start
```

Server berjalan di `http://localhost:3000`

- **User Panel:** `http://localhost:3000`
- **Admin Panel:** `http://localhost:3000/admin.html`
- **Referral / Undang Teman:** `http://localhost:3000/referral.html`
- **Tarik Saldo:** `http://localhost:3000/withdrawal.html`
- **Health Check:** `http://localhost:3000/healthz`

Penarikan minimum Rp 1.000, tanpa biaya, ke DANA, GoPay, atau SeaBank. Fitur dapat diakses jika saldo yang bisa ditarik minimal Rp 25.000. Bonus event deposit 2x tetap bisa dipakai membeli layanan tetapi tidak dapat ditarik; bonus dipakai lebih dahulu sebelum saldo deposit. Komisi referral, refund, dan saldo tambahan admin tetap bisa ditarik. Saldo yang sudah ada sebelum pemisahan ini tetap dianggap sebagai saldo utama. Saldo dicadangkan saat permintaan diajukan dan dikembalikan jika admin menolak. Setelah mengubah Firebase Database Rules, salin rules terbaru dari `node set-db-rules.js` ke Firebase Console; penulisan data akun dan permintaan penarikan hanya dilakukan server.

Untuk membuat kode referral unik bagi semua akun yang sudah ada, jalankan sekali setelah konfigurasi `.env` terisi:

```bash
node scripts/migrateReferralCodes.js
```

Script aman dijalankan ulang; kode referral lama yang berupa UID akan diganti.

### 3. Seed Data Firebase (Manual)

Di Firebase Realtime Database, buat struktur data awal:

```json
{
  "countries": {
    "indonesia_reguler": {
      "tab": "indo",
      "country_name": "Indonesia",
      "flag": "????",
      "price": 5000
    },
    "usa_reguler": {
      "tab": "luar",
      "country_name": "United States",
      "flag": "????",
      "price": 15000
    }
  },
  "users": {
    "UID_USER_KAMU": {
      "username": "nama_user",
      "balance": 100000
    }
  }
}
```

Lalu tambah stok nomor dari **Admin Panel ? Tambah Stok**.

## Struktur Folder

```
+-- server.js                    # Entry point Express
+-- src/
�   +-- config/firebase.js       # Firebase Admin SDK init
�   +-- middleware/
�   �   +-- authUser.js          # Auth middleware untuk user
�   �   +-- authAdmin.js         # Auth middleware untuk admin
�   +-- routes/
�   �   +-- purchaseRoutes.js    # POST /api/purchase
�   �   +-- orderRoutes.js       # POST /api/orders/:id/*
�   �   +-- cancelRoutes.js      # POST /api/orders/:id/cancel
�   �   +-- adminRoutes.js       # POST /api/admin/*
�   +-- services/
�   �   +-- purchaseService.js   # Logika beli + atomic transaction
�   �   +-- orderService.js      # OTP request, resend, submit, complete
�   �   +-- cancelService.js     # Cancel + refund
�   �   +-- expiryGuardian.js    # Background job expiry stok
�   �   +-- telegramService.js   # Kirim notifikasi Telegram
�   +-- utils/retryTransaction.js
+-- public/
�   +-- index.html               # User Panel
�   +-- admin.html               # Admin Panel
�   +-- js/
�       +-- firebase-config.js   # Firebase web SDK config
�       +-- user-panel.js        # Logic user panel
�       +-- admin-panel.js       # Logic admin panel
```

## Fitur

- ?? **Beli Nomor Instant** � Timer 5 menit, stok di-lock atomik
- ?? **User Panel** � Tab Indo/Luar, saldo real-time, timer countdown
- ?? **Admin Panel** � Monitor order, input OTP, complete, tambah stok
- ?? **Notifikasi Telegram** � OTP request & resend auto-notify admin
- ?? **Resend OTP** � Cooldown 60 detik anti-spam
- ?? **Auto-Refund** � Cancel order = saldo kembali 100%
- ? **Expiry Guardian** � Background job expire order macet otomatis setiap 30 detik
- **Referral** � Kode undangan unik berformat `NOKOTPXXXXX`; pengundang mendapat komisi 50% tanpa batas jumlah deposit sukses. Akun yang terlanjur mendaftar tanpa kode dapat mengaitkannya sekali dari halaman Undang Teman.
- **Tarik Saldo** � Permintaan manual DANA, GoPay, dan SeaBank; biaya gratis, minimum penarikan Rp 1.000 dan saldo yang bisa ditarik minimal Rp 25.000 untuk akses. Bonus event tidak dapat ditarik. Permintaan tampil di dashboard admin dan dikirim melalui Telegram.
