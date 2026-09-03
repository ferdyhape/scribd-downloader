# Panduan Menghentikan Proses (How to Stop)

Panduan ini berisi perintah terminal cepat untuk mematikan proses **Scribd Reader** secara spesifik dan aman, **tanpa mengganggu aplikasi Node.js atau website lain** yang sedang berjalan di VPS Anda.

---

## ⚡ 1. Cara Cepat 1 Detik (One-Liner Paling Ampuh & Aman)

Jalankan perintah ini di terminal VPS:

```bash
sudo fuser -k 5000/tcp && sudo pkill -9 -f "\.profile"
```

> **Mengapa ini aman untuk web lain?**
> - `fuser -k 5000/tcp`: Hanya mematikan proses yang mendengarkan port 5000 (Scribd Reader).
> - `pkill -9 -f "\.profile"`: Hanya mematikan proses Chrome yang dibuka oleh Scribd Reader (karena menggunakan folder session `.profile`), **tidak akan menyentuh** browser atau Node.js lain di server Anda.

---

## 🔍 2. Cara Memantau (Cek Apakah Masih Ada Proses yang Berjalan)

### A. Cek Port 5000
```bash
sudo ss -tulpn | grep 5000
```
*Jika kosong / tidak ada output, berarti server Scribd Reader sudah mati.*

### B. Cek Proses Node.js Khusus Scribd Reader
```bash
ps aux | grep -E "scribd-downloader|server\.js" | grep -v grep
```

### C. Cek Proses Chrome Khusus Scribd Reader
```bash
ps aux | grep -E "chrome.*\.profile" | grep -v grep
```

---

## 🎯 3. Pilihan Stop Spesifik Sesuai Kebutuhan

### Opsi A: Matikan Chrome yang Sedang Berat Saja (Server Tetap Hidup)
Jika server web ingin tetap online tetapi Anda ingin membatalkan proses capture dokumen yang sedang memakan CPU:
```bash
sudo pkill -9 -f "\.profile"
```

### Opsi B: Matikan Server Berdasarkan Nama Folder Proyek
```bash
sudo pkill -9 -f "scribd-downloader"
```

### Opsi C: Matikan Berdasarkan Nomor PID
1. Cari PID prosesnya:
   ```bash
   pgrep -f "scribd-downloader"
   ```
2. Matikan nomor PID tersebut (contoh jika PID `3638287`):
   ```bash
   sudo kill -9 3638287
   ```

---

## 🚀 4. Jika Menggunakan PM2 (Rekomendasi Production)

Jika Anda menjalankan aplikasi menggunakan PM2:

```bash
# Menghentikan Scribd Reader
pm2 stop scribd-reader

# Menjalankan kembali
pm2 start scribd-reader

# Restart
pm2 restart scribd-reader

# Melihat penggunaan CPU & RAM real-time
pm2 monit
```
