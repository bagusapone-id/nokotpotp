

# Product Requirements Document (PRD)

## Project: Panel Web Nokos WA (Nokos Indo & Nokos Luar) Semi-Manual + Telegram Notification

### 1. Overview & Tujuan Produk

Membangun platform web berbasis **Node.js, Express, dan Firebase Realtime Database** untuk jual-beli nomor kosong (Nokos) WhatsApp secara semi-manual dengan sistem stok siap pakai (*pre-stocked*). Platform ini dibagi menjadi 2 tab utama (**Nokos Indo** dan **Nokos Luar**), dilengkapi sistem notifikasi Telegram, manajemen timer, fitur kirim ulang OTP, dan tombol *cancel* otomatis dengan sistem *refund* saldo.

---

### 2. Tab Menu Utama

* **Tab 1: Nokos Indo** (Khusus nomor lokal Indonesia, misal prefiks +62).
* **Tab 2: Nokos Luar** (Khusus nomor internasional, misal USA +1, Malaysia +60, dll.).
* Masing-masing tab menampilkan daftar negara/layanan lengkap dengan: Bendera, Nama Negara, Harga (Rupiah), dan **Sisa Stok Real-Time**.

---

### 3. Alur End-to-End (User Journey & Admin Workflow)

#### A. Pembelian & Muncul Nomor (Instant Stock)

1. User pilih tab (Indo/Luar) $\rightarrow$ Pilih negara $\rightarrow$ Klik **Beli**.
2. Sistem mengecek saldo user di Firebase. Jika cukup, saldo dipotong secara atomik.
3. Sistem mengambil 1 stok nomor acak berstatus `AVAILABLE` dari kategori/negara tersebut, mengubah statusnya menjadi `LOCKED` (milik user), dan menampilkannya secara instan ke layar user.
4. **Timer Mundur 5 Menit** langsung berjalan otomatis di layar user.

#### B. Minta OTP & Fitur Kirim Ulang OTP (Resend OTP)

1. User menyalin nomor, memasukkannya ke aplikasi WhatsApp, lalu klik minta OTP (SMS/Call) di WhatsApp.
2. Di web, user mengklik tombol **"Sudah Minta OTP, Tunggu Kode"**.
3. Sistem mengirim notifikasi instan ke **Bot Telegram Admin** (Berisi: Nama User, Nomor HP, Negara, dan ID Order).
4. **Fitur Tambahan (Kirim Ulang OTP):**
* Jika dalam 1–2 menit kode OTP belum masuk, user dapat menekan tombol **"Kirim Ulang OTP"** di web.
* Tombol ini memiliki jeda *cooldown* (misal 60 detik) agar tidak disetrum spam oleh user.
* Aksi ini kembali mengirim notifikasi update ke Telegram admin bahwa user meminta *Resend OTP* untuk nomor tersebut.



#### C. Sisi Admin (Input OTP & Cek Login)

1. Admin melihat notifikasi di Telegram atau membuka **Panel Admin Web**.
2. Admin melihat nomor yang sedang aktif menunggu OTP, lalu mengecek ke panel/alat penerima SMS mereka.
3. Admin memasukkan kode OTP ke form di panel admin. Kode OTP langsung muncul secara *real-time* di layar user.
4. **Validasi Akhir Admin:**
* Setelah user memasukkan kode OTP dan mencoba login, admin melakukan pengecekan (apakah akun sudah sukses masuk / nyangkut *2FA*).
* Jika sudah aman & sukses, admin menekan tombol **"Done / Selesai"**. Status pesanan berubah menjadi `COMPLETED`.



#### D. Skenario Timeout (Timer 5 Menit Habis) & Cancel Wajib

1. Jika waktu mundur 5 menit habis dan status pesanan belum `COMPLETED`:
* Sistem mengunci form dan memunculkan pop-up peringatan keras di layar user: *"Waktu Habis! OTP Gagal Masuk?"*.
* Di dalam pop-up tersebut, terdapat **Tombol Cancel Pesanan yang WAJIB DIKLIK OLEH USER** untuk menutup sesi transaksi.


2. Begitu user mengklik tombol Cancel tersebut, backend mengeksekusi:
* Mengubah status pesanan menjadi `CANCELLED / EXPIRED`.
* **Auto-Refund:** Saldo user dikembalikan 100% ke akun Firebase mereka.
* Status nomor HP di database diubah menjadi `BURNED / EXPIRED` (supaya tidak dipakai ulang).



---

### 4. Struktur Database Firebase (JSON Schema Draft)

```json
{
  "users": {
    "uid_user_123": {
      "username": "budi_dev",
      "balance": 50000
    }
  },
  "countries": {
    "indonesia_reguler": {
      "tab": "indo",
      "country_name": "Indonesia",
      "flag": "🇮🇩",
      "price": 5000
    },
    "usa_reguler": {
      "tab": "luar",
      "country_name": "United States",
      "flag": "🇺🇸",
      "price": 15000
    }
  },
  "phone_stocks": {
    "stk_01": {
      "country_key": "indonesia_reguler",
      "number": "6281234567890",
      "status": "AVAILABLE" 
    }
  },
  "orders": {
    "ORD-20261114-01": {
      "user_id": "uid_user_123",
      "country_key": "indonesia_reguler",
      "phone_number": "6281234567890",
      "status": "WAITING_OTP", 
      "otp_code": "",
      "resend_count": 0,
      "created_at": 1731564000000,
      "expires_at": 1731564300000,
      "is_refunded": false
    }
  }
}

```

---

### 5. Tech Stack untuk Di-generate ke Kiro

* **Frontend:** HTML5, Tailwind CSS (CDN/Vite), Vanilla JavaScript dengan Firebase SDK (Realtime Database listeners untuk sinkronisasi instan tanpa *refresh*).
* **Backend:** Node.js + Express.js.
* **Database:** Firebase Realtime Database (menggunakan *Transactions* untuk mencegah bentrok pembelian stok bersamaan).
* **Notifikasi:** Telegram Bot API via HTTP `fetch` (Metode Webhook/Instan).

---