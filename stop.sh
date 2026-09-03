#!/usr/bin/env bash
# Script cepat untuk mematikan proses Scribd Reader tanpa mengganggu website lain

echo "Menghentikan proses Scribd Reader..."
sudo fuser -k 5000/tcp 2>/dev/null
sudo pkill -9 -f "\.profile" 2>/dev/null
sudo pkill -9 -f "scribd-downloader" 2>/dev/null
echo "✓ Selesai! Port 5000 dan Chrome milik Scribd Reader sudah dimatikan."
echo "  Aplikasi Node.js dan website lain di server tetap aman."
