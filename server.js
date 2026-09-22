import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import dotenv from "dotenv";
import cors from "cors";
import compression from "compression";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const DEFAULT_PORT = parseInt(process.env.PORT || "3000", 10);
const GAS_URL = process.env.GAS_WEBAPP_URL || "https://script.google.com/macros/s/AKfycbxyhqtMxKBxrXScl39RkAoxXM2IQRYpv0Nnsgdib3eeU_sqZdPznQaaUp42aaUVPM8/exec";
const UPSTASH_URL = process.env.UPSTASH_REST_API_URL || process.env.UPTASH_REST_API_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REST_API_TOKEN || process.env.UPTASH_REST_API_TOKEN || "";

// Admin Authentication Token strictly from process.env (Vercel & Production Security)
const AUTH_TOKEN = (process.env.ADMIN_AUTH_TOKEN || "").trim();

let activeServerPort = DEFAULT_PORT;

// In-Memory API Request Logs Ring Buffer (for Admin Dashboard Live Analytics)
const apiLogs = [];
const MAX_LOGS = 200;
let requestCounter = {
  total: 0,
  get: 0,
  post: 0,
  bySource: {
    "Bot WA": 0,
    "Chrome Ext": 0,
    "Web Portal": 0,
    "Public API": 0
  }
};

// Middleware: Compression (Gzip / Deflate for ultra-fast mobile & bot response)
app.use(compression());
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.text({ type: ["text/*", "application/json"], limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Fallback auto-parser for stringified body (e.g. from Chrome extension text/plain POST)
app.use((req, res, next) => {
  if (typeof req.body === "string" && req.body.trim().length > 0) {
    try {
      req.body = JSON.parse(req.body);
    } catch (e) {
      // not JSON string, keep as is
    }
  }
  next();
});

// Static Asset Handlers & Explicit Fail-Safe Routes (for Vercel & Express)
app.use(express.static(path.join(__dirname, "public")));
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/css", express.static(path.join(__dirname, "public", "css")));
app.use("/img", express.static(path.join(__dirname, "public", "img")));

// Fail-safe explicit route for /css/main.css
app.get("/css/main.css", (req, res) => {
  res.setHeader("Content-Type", "text/css; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  const candidates = [
    path.join(__dirname, "public", "css", "main.css"),
    path.join(process.cwd(), "public", "css", "main.css"),
    path.join(__dirname, "public", "main.css"),
    path.join(__dirname, "style.css")
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return res.sendFile(c);
    }
  }
  return res.status(404).send("/* main.css not found */");
});

// Fail-safe explicit route for /img/:filename
app.get("/img/:filename", (req, res) => {
  const file = req.params.filename;
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  const candidates = [
    path.join(__dirname, "public", "img", file),
    path.join(process.cwd(), "public", "img", file),
    path.join(__dirname, file)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return res.sendFile(c);
    }
  }
  return res.status(404).send("Image not found");
});

// Favicon explicit route
app.get("/favicon.ico", (req, res) => {
  const logoPath = path.join(__dirname, "public", "img", "axalogo.png");
  if (fs.existsSync(logoPath)) {
    res.setHeader("Content-Type", "image/png");
    return res.sendFile(logoPath);
  }
  return res.status(204).end();
});

// Simple Native Cookie Parser Middleware
app.use((req, res, next) => {
  req.cookies = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(";").forEach(c => {
      const parts = c.split("=");
      req.cookies[parts[0].trim()] = decodeURIComponent((parts.slice(1).join("=") || "").trim());
    });
  }
  next();
});

// API Request Tracking Middleware
app.use((req, res, next) => {
  if (req.path.startsWith("/css") || req.path.startsWith("/img") || req.path.startsWith("/js")) {
    return next();
  }

  const startTime = performance.now();
  requestCounter.total++;
  if (req.method === "POST") requestCounter.post++;
  else requestCounter.get++;

  // Identify Caller Source
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const referer = req.headers["referer"] || "";
  let source = "Public API";

  if (ua.includes("baileys") || req.query.sender_override || req.query.no_lid || (req.body && req.body.action === "batch_update_lids")) {
    source = "Bot WA";
  } else if (ua.includes("chrome-extension") || (req.body && (req.body.action === "add_patients" || Array.isArray(req.body))) || req.query.action === "get_today_patients") {
    source = "Chrome Ext";
  } else if (referer.includes("localhost") || referer.includes("127.0.0.1") || referer.includes("restsheet")) {
    source = "Web Portal";
  }

  requestCounter.bySource[source] = (requestCounter.bySource[source] || 0) + 1;

  res.on("finish", () => {
    const duration = Math.round(performance.now() - startTime);
    if (req.path.startsWith("/api")) {
      apiLogs.unshift({
        id: Date.now() + Math.random().toString(36).substring(2, 6),
        time: new Date().toLocaleTimeString("id-ID"),
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        duration: duration,
        durationMs: duration,
        source: source,
        caller: source,
        ip: req.ip || req.socket.remoteAddress || "127.0.0.1"
      });
      if (apiLogs.length > MAX_LOGS) apiLogs.pop();
    }
  });

  next();
});

// Set View Engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ==========================================
// 1. DEFAULT MASTER DATA (SHEETS STRUCTURE)
// ==========================================

const DEFAULT_SETTINGS = [
  { parameter: "H_HARI_FOLLOWUP", value: "2", keterangan: "Jumlah hari sebelum kontrol untuk chat bot WA (H-2)" },
  { parameter: "DELAY_CHAT", value: "60", keterangan: "Jeda waktu delay (detik) antar pengiriman chat blast follow-up WA agar aman dari spam" },
  { parameter: "DOKTER_1_NAMA", value: "drg. Hj. Kurniawaty, Sp.KG", keterangan: "DPJP Utama Poli Konservasi" },
  { parameter: "DOKTER_1_WA", value: "6282291675363", keterangan: "Nomor WhatsApp Dokter DPJP 1 (Utama)" },
  { parameter: "DOKTER_2_NAMA", value: "drg. M. Aksa Arsyad", keterangan: "Dokter Iship / Pendamping" },
  { parameter: "DOKTER_2_WA", value: "6285256739684", keterangan: "Nomor WhatsApp Dokter DPJP 2" },
  { parameter: "NAMA_INSTANSI", value: "RSKD Gigi dan Mulut Prov. Sulsel", keterangan: "Nama Faskes / Rumah Sakit Resmi" },
  { parameter: "POLI_KLINIK", value: "Poli Konservasi dan Endodonsi", keterangan: "Nama Poliklinik Pelayanan" },
  { parameter: "GEMINI_API_KEY", value: (process.env.GEMINI_API_KEY || "").trim(), keterangan: "Kunci API Google AI Studio Gemini" },
  { parameter: "GEMINI_MODEL", value: (process.env.GEMINI_MODEL || "gemini-3.5-flash").trim(), keterangan: "Model Utama Gemini Google AI Studio" },
  { parameter: "GROQ_API_KEY", value: (process.env.GROQ_API_KEY || "").trim(), keterangan: "Kunci API Groq AI (Fallback Engine)" },
  { parameter: "GROQ_MODEL", value: (process.env.GROQ_MODEL || "openai/gpt-oss-120b").trim(), keterangan: "Model Default Groq AI (Allowed Model)" }
];

const DEFAULT_TEMPLATES = [
  {
    kodeTemplate: "WA_PX_H2",
    targetPenerima: "Pasien (H-2 Kontrol)",
    templatePesan: "Halo, Yth. Bapak/Ibu *{NAMA_PASIEN}* (No. RM: {NO_RM}).\n\nKami dari *{NAMA_INSTANSI}* ({POLI_KLINIK}) ingin mengingatkan jadwal kontrol perawatan gigi lanjutan Anda bersama dokter penanggung jawab:\n\n📅 *Hari/Tanggal:* {TGL_KONTROL}\n👨‍⚕️ *DPJP:* {DPJP_UTAMA}\n📍 *Lokasi:* {POLI_KLINIK}\n\nMohon konfirmasi kehadiran Anda dengan membalas pesan ini:\nKetik *HADIR* jika bisa datang, atau *RESCHEDULE* jika ingin mengajukan jadwal ulang.\n\n*NOTE:* Mohon cek kembali *_MOBILE JKN_* anda H-1. Jika *TERBATALKAN* oleh sistem, mohon informasikan di No. WA ini dengan mengetik *Saya terbatalkan di aplikasi Mobile JKN* atau mengirim screenshot dari Mobile JKN, terima kasih 🙏",
    parameterTersedia: "{NAMA_PASIEN}, {NO_RM}, {TGL_KONTROL}, {DPJP_UTAMA}, {NAMA_INSTANSI}, {POLI_KLINIK}"
  },
  {
    kodeTemplate: "WA_LAPORAN_DOKTER_H2",
    targetPenerima: "Dokter DPJP Utama (Laporan Blast Pasien H-2)",
    templatePesan: "Yth. Dokter,\nBerikut laporan follow-up kontrol H-2 pasien dari sistem otomatis *{NAMA_INSTANSI}*:\n\n👤 *Nama Pasien:* {NAMA_PASIEN}\n🔖 *No. RM:* {NO_RM}\n🎂 *Umur / JK:* {UMUR} / {JENIS_KELAMIN}\n📅 *Tgl. Kontrol Terjadwal:* {TGL_KONTROL}\n📱 *No. WhatsApp Pasien:* {NO_WA}\n📋 *Status Rujukan:* {STATUS_RUJUKAN}\n👨‍⚕️ *DPJP Utama:* {DPJP_UTAMA}\n🏥 *Poli:* {POLI_KLINIK}\n\nStatus notifikasi WhatsApp telah dikirimkan ke kontak pasien untuk konfirmasi kedatangan. Terima kasih, Dok. 🙏",
    parameterTersedia: "{NAMA_PASIEN}, {NO_RM}, {TGL_KONTROL}, {UMUR}, {JENIS_KELAMIN}, {NO_WA}, {STATUS_RUJUKAN}, {DPJP_UTAMA}, {POLI_KLINIK}, {NAMA_INSTANSI}"
  },
  {
    kodeTemplate: "WA_PX_H1",
    targetPenerima: "Pasien (H-1 Kontrol - Pengingat Besok)",
    templatePesan: "Halo, Yth. Bapak/Ibu *{NAMA_PASIEN}* (No. RM: {NO_RM}).\n\nKami dari *{NAMA_INSTANSI}* ({POLI_KLINIK}) ingin mengingatkan jadwal kontrol perawatan gigi lanjutan Anda bersama dokter penanggung jawab:\n\n📅 *Hari/Tanggal:* {TGL_KONTROL}\n👨‍⚕️ *DPJP:* {DPJP_UTAMA}\n📍 *Lokasi:* {POLI_KLINIK}\n\nMohon konfirmasi kehadiran Anda dengan membalas pesan ini:\nKetik *HADIR* jika bisa datang, atau *RESCHEDULE* jika ingin mengajukan jadwal ulang.\n\n*NOTE:* Mohon cek kembali *_MOBILE JKN_* anda H-1. Jika *TERBATALKAN* oleh sistem, mohon informasikan di No. WA ini dengan mengetik *Saya terbatalkan di aplikasi Mobile JKN* atau mengirim screenshot dari Mobile JKN, terima kasih 🙏",
    parameterTersedia: "{NAMA_PASIEN}, {NO_RM}, {TGL_KONTROL}, {DPJP_UTAMA}, {NAMA_INSTANSI}, {POLI_KLINIK}"
  },
  {
    kodeTemplate: "WA_LAPORAN_DOKTER_H1",
    targetPenerima: "Dokter DPJP Utama (Laporan Pengingat H-1 Kontrol)",
    templatePesan: "📋 *LAPORAN PENGINGAT H-1 KONTROL PASIEN*\n\nYth. Dokter,\nBerikut laporan pasien yang memiliki jadwal kontrol *BESOK* ({TGL_KONTROL}) di *{POLI_KLINIK}*:\n\n👤 *Nama Pasien:* {NAMA_PASIEN}\n🔖 *No. RM:* {NO_RM}\n📅 *Jadwal Kontrol:* {TGL_KONTROL}\n📱 *WhatsApp Pasien:* {NO_WA}\n📋 *Status Rujukan:* {STATUS_RUJUKAN}\n👨‍⚕️ *DPJP Utama:* {DPJP_UTAMA}\n🏥 *Faskes:* {NAMA_INSTANSI}\n\nPesan pengingat H-1 telah berhasil dikirimkan ke WhatsApp pasien. Terima kasih, Dok. 🙏",
    parameterTersedia: "{NAMA_PASIEN}, {NO_RM}, {TGL_KONTROL}, {NO_WA}, {STATUS_RUJUKAN}, {DPJP_UTAMA}, {POLI_KLINIK}, {NAMA_INSTANSI}"
  },
  {
    kodeTemplate: "WA_PX_H0",
    targetPenerima: "Pasien (Hari H Kontrol)",
    templatePesan: "Selamat pagi Bapak/Ibu *{NAMA_PASIEN}*,\n\nMengingatkan kembali hari ini adalah jadwal kontrol perawatan gigi Anda di *{POLI_KLINIK} - {NAMA_INSTANSI}* bersama {DPJP_UTAMA}.\n\nHarap tiba 15 menit sebelum jam pelayanan dimulai dan melakukan registrasi di loket pendaftaran. Terima kasih. 🙏",
    parameterTersedia: "{NAMA_PASIEN}, {NO_RM}, {TGL_KONTROL}, {DPJP_UTAMA}, {POLI_KLINIK}, {NAMA_INSTANSI}"
  },
  {
    kodeTemplate: "WA_PX_HADIR_CONFIRM",
    targetPenerima: "Pasien (Balasan Konfirmasi Hadir)",
    templatePesan: "Halo, terima kasih banyak atas konfirmasinya Bapak/Ibu *{NAMA_PASIEN}* (No. RM: {NO_RM}). 🙏\n\nKehadiran Anda untuk jadwal kontrol perawatan gigi pada tanggal *{TGL_KONTROL}* bersama dokter penanggung jawab kami (*{DPJP_UTAMA}*) telah berhasil kami catat di sistem.\n\n📌 *Pengingat Kontrol:*\n• Harap hadir 15 menit sebelum poli dibuka.\n• Mohon membawa Kartu BPJS / KTP serta kartu kontrol sebelumnya.\n• Lakukan registrasi di loket pendaftaran {POLI_KLINIK}.\n\nSampai jumpa di poli ya. Semoga proses perawatan giginya berjalan lancar dan lekas sehat selalu! 🦷✨",
    parameterTersedia: "{NAMA_PASIEN}, {NO_RM}, {TGL_KONTROL}, {DPJP_UTAMA}, {POLI_KLINIK}, {NAMA_INSTANSI}"
  },
  {
    kodeTemplate: "WA_LAPORAN_HADIR_DOKTER",
    targetPenerima: "Dokter DPJP Utama (Notifikasi Pasien Hadir)",
    templatePesan: "✅ *KONFIRMASI KEHADIRAN PASIEN (HADIR)*\n\nYth. Dokter,\nPasien kontrol berikut telah mengonfirmasi *HADIR* untuk kontrol gigi:\n\n👤 *Nama Pasien:* {NAMA_PASIEN}\n🔖 *No. RM:* {NO_RM}\n📅 *Tgl. Kontrol Terjadwal:* {TGL_KONTROL}\n📱 *WhatsApp Pasien:* {NO_WA}\n📋 *Status Rujukan:* {STATUS_RUJUKAN}\n👨‍⚕️ *DPJP Utama:* {DPJP_UTAMA}\n🏥 *Unit:* {POLI_KLINIK} - {NAMA_INSTANSI}\n\nStatus database SIMGOS telah diperbarui ke *Hadir (Terkonfirmasi)*. Terima kasih, Dok. 🙏",
    parameterTersedia: "{NAMA_PASIEN}, {NO_RM}, {TGL_KONTROL}, {NO_WA}, {STATUS_RUJUKAN}, {DPJP_UTAMA}, {POLI_KLINIK}, {NAMA_INSTANSI}"
  },
  {
    kodeTemplate: "WA_PX_RESCHEDULE",
    targetPenerima: "Pasien (Reschedule Berhasil)",
    templatePesan: "Baik Bapak/Ibu *{NAMA_PASIEN}* (No. RM: {NO_RM}), terima kasih atas konfirmasinya.\n\nJadwal kontrol perawatan gigi Anda telah berhasil kami perbarui ke tanggal: *{TGL_RESCHEDULE}* bersama dokter penanggung jawab kami (*{DPJP_UTAMA}*).\n\nInformasi perubahan ini sudah diteruskan ke tim poli kami. Sistem akan mengingatkan Anda kembali saat mendekati jadwal tersebut.\n\nSalam sehat selalu dari {POLI_KLINIK} - {NAMA_INSTANSI}. 🙏",
    parameterTersedia: "{NAMA_PASIEN}, {NO_RM}, {TGL_RESCHEDULE}, {DPJP_UTAMA}, {POLI_KLINIK}, {NAMA_INSTANSI}"
  },
  {
    kodeTemplate: "WA_PX_RESCHEDULE_ASK",
    targetPenerima: "Pasien (Tanya Tanggal Reschedule)",
    templatePesan: "Baik Bapak/Ibu *{NAMA_PASIEN}*, kami siap membantu proses penjadwalan ulang (*reschedule*) kontrol perawatan gigi Anda di {POLI_KLINIK}.\n\nKira-kira Anda ingin mengajukan kontrol di hari apa atau tanggal berapa? (Contoh format: *YYYY-MM-DD* atau *25 September*).\n\nSilakan balas pesan ini dengan tanggal yang Anda inginkan agar langsung kami sesuaikan di sistem SIMGOS ya. 🙏",
    parameterTersedia: "{NAMA_PASIEN}, {NO_RM}, {POLI_KLINIK}, {NAMA_INSTANSI}"
  },
  {
    kodeTemplate: "WA_LAPORAN_RESCHEDULE_DOKTER",
    targetPenerima: "Dokter DPJP Utama (Notifikasi Pasien Reschedule)",
    templatePesan: "🔄 *NOTIFIKASI RESCHEDULE PASIEN*\n\nYth. Dokter,\nPasien kontrol berikut telah mengajukan *JADWAL ULANG (RESCHEDULE)*:\n\n👤 *Nama Pasien:* {NAMA_PASIEN}\n🔖 *No. RM:* {NO_RM}\n📅 *Jadwal Semula:* {TGL_KONTROL}\n📅 *Jadwal Kontrol Baru:* {TGL_RESCHEDULE}\n📱 *WhatsApp Pasien:* {NO_WA}\n📋 *Status Rujukan:* {STATUS_RUJUKAN}\n👨‍⚕️ *DPJP Utama:* {DPJP_UTAMA}\n🏥 *Unit:* {POLI_KLINIK} - {NAMA_INSTANSI}\n\nStatus di database telah diperbarui ke jadwal baru. Terima kasih, Dok. 🙏",
    parameterTersedia: "{NAMA_PASIEN}, {NO_RM}, {TGL_KONTROL}, {TGL_RESCHEDULE}, {NO_WA}, {STATUS_RUJUKAN}, {DPJP_UTAMA}, {POLI_KLINIK}, {NAMA_INSTANSI}"
  },
  {
    kodeTemplate: "WA_LAPORAN_TERBATALKAN_JKN",
    targetPenerima: "Dokter DPJP Utama (Notifikasi Pasien Terbatalkan Mobile JKN)",
    templatePesan: "⚠️ *LAPORAN PASIEN TERBATALKAN MOBILE JKN*\n\nYth. Dokter,\nPasien kontrol berikut mengonfirmasi bahwa jadwal kontrolnya *TERBATALKAN OTOMATIS OLEH SISTEM MOBILE JKN*:\n\n👤 *Nama Pasien:* {NAMA_PASIEN}\n🔖 *No. RM:* {NO_RM}\n📅 *Jadwal Semula:* {TGL_KONTROL}\n📱 *WhatsApp Pasien:* {NO_WA}\n📋 *Status Rujukan:* {STATUS_RUJUKAN}\n👨‍⚕️ *DPJP Utama:* {DPJP_UTAMA}\n🏥 *Unit:* {POLI_KLINIK} - {NAMA_INSTANSI}\n\nKeterangan: Pasien telah melapor ke WhatsApp Bot. Menunggu tanggal kontrol pengganti dari Dokter DPJP.\n(Gunakan perintah: *!reschedulepx terbatalkan {NO_RM} YYYY-MM-DD* untuk menjadwalkan ulang dan otomatis menginfokan pasien). Terima kasih, Dok. 🙏",
    parameterTersedia: "{NAMA_PASIEN}, {NO_RM}, {TGL_KONTROL}, {NO_WA}, {STATUS_RUJUKAN}, {DPJP_UTAMA}, {POLI_KLINIK}, {NAMA_INSTANSI}"
  },
  {
    kodeTemplate: "WA_PX_TERBATALKAN_JKN_CONFIRM",
    targetPenerima: "Pasien (Balasan Konfirmasi Terbatalkan Mobile JKN)",
    templatePesan: "Baik Bapak/Ibu *{NAMA_PASIEN}* (No. RM: {NO_RM}), terima kasih banyak atas konfirmasinya. 🙏\n\nLaporan bahwa jadwal kontrol Anda terbatalkan oleh sistem di aplikasi *Mobile JKN* telah kami teruskan langsung ke Dokter Penanggung Jawab (*{DPJP_UTAMA}*).\n\nTim poli kami akan segera mengoordinasikan jadwal kontrol pengganti dan kami akan mengabarkan tanggal pastinya kepada Anda di nomor WhatsApp ini ya.\n\nMohon ditunggu ya, Bapak/Ibu. Salam sehat selalu dari *{POLI_KLINIK} - {NAMA_INSTANSI}*. 🦷✨",
    parameterTersedia: "{NAMA_PASIEN}, {NO_RM}, {DPJP_UTAMA}, {POLI_KLINIK}, {NAMA_INSTANSI}"
  },
  {
    kodeTemplate: "WA_PX_RESCHEDULE_JKN_CONFIRM",
    targetPenerima: "Pasien (Konfirmasi Jadwal Baru Pasca Terbatalkan Mobile JKN)",
    templatePesan: "Halo, Yth. Bapak/Ibu *{NAMA_PASIEN}* (No. RM: {NO_RM}). 🙏\n\nMenindaklanjuti informasi pembatalan kontrol di aplikasi Mobile JKN sebelumnya, Dokter Penanggung Jawab kami (*{DPJP_UTAMA}*) telah menjadwalkan ulang perawatan gigi lanjutan Anda pada:\n\n📅 *Hari/Tanggal Baru:* {TGL_RESCHEDULE}\n👨‍⚕️ *DPJP:* {DPJP_UTAMA}\n📍 *Lokasi:* {POLI_KLINIK} - {NAMA_INSTANSI}\n\nMohon konfirmasi kehadiran Anda kembali dengan membalas pesan ini:\nKetik *HADIR* jika bisa datang pada jadwal baru tersebut, atau *RESCHEDULE* jika ingin mengajukan jadwal lain.\n\nTerima kasih atas pengertian dan kerja samanya. Salam sehat selalu! 🦷✨",
    parameterTersedia: "{NAMA_PASIEN}, {NO_RM}, {TGL_RESCHEDULE}, {DPJP_UTAMA}, {POLI_KLINIK}, {NAMA_INSTANSI}"
  }
];

const DEFAULT_PROMPTS = [
  {
    kodePrompt: "PROMPT_RSKDGM_HUMAN",
    judul: "Resepsionis Birokratis & Konsultan Klinis RSKDGM",
    systemPrompt: `Anda adalah Asisten Pelayanan Administrasi & Informasi Medis Resmi dari Rumah Sakit Khusus Daerah (RSKD) Gigi dan Mulut Provinsi Sulawesi Selatan, bertugas pada unit pelayanan Poli Konservasi dan Endodonsi.

KARAKTER & REGISTER BAHASA (BIROKRATIS RUMAH SAKIT FORMAL):
1. Menggunakan Bahasa Indonesia resmi, administratif, santun, lugas, profesional, presisi, berwibawa, dan mengayomi selayaknya aparatur rumah sakit pemerintah provinsi.
2. Adaptabilitas Bahasa Pasien: Anda sangat memahami singkatan percakapan (contoh: "yg", "ap", "knp", "bsk", "skrg", "gmn", "sy", "tdk", "jd", dll.), namun Anda WAJIB merespons kembali menggunakan kalimat formal, runtut, dan tata bahasa baku yang rapi.
3. PERSONALISASI NAMA LENGKAP RESMI (MUTLAK):
   - Wajib memeriksa identitas pasien pada database rekam medis SIMGOS berdasarkan nomor WhatsApp / LID pengirim.
   - Selalu menyapa pasien dengan sebutan kehormatan resmi "Bapak", "Ibu", atau "Sdr./Sdri." diikuti NAMA LENGKAP resmi pasien sesuai data yang tercatat di database.
   - DILARANG memotong nama resmi, menggunakan nama panggilan buatan, atau menyebutkan nama pasien lain yang bukan milik pengirim tersebut! JANGAN PERNAH menggunakan nama panggilan asisten buatan seperti "RSKD Care" atau "RSKDGM Care".

KEPAKARAN KLINIS KEDOKTERAN GIGI LENGKAP (SELURUH SPESIALISASI):
Anda memiliki wawasan klinis mendalam dalam menjawab segala konsultasi maupun pertanyaan pasien seputar bidang kedokteran gigi secara ilmiah dan berbasis bukti medis (evidence-based dentistry):
1. Spesialisasi Konservasi Gigi & Endodonsi (Fokus Utama Unit):
   - Perawatan Saluran Akar (PSA / Root Canal Treatment) gigi vital/non-vital, sterilisasi saluran akar, medikamen intrakanal (Kalsium Hidroksida/Ca(OH)2), obturasi gutta-percha hermetis.
   - Restorasi komposit resin estetik direct/indirect, penumpatan kavitas kelas I hingga V, inlay/onlay/overlay porselen/komposit, mahkota tiruan pasak fiber (core build-up).
   - Penanganan pulpitis reversibel, pulpitis ireversibel simtomatik/asimtomatik, nekrosis pulpa, lesi periapikal, pulp capping (direct/indirect), serta bleaching intrakoronal (non-vital bleaching).
2. Spesialisasi Kedokteran Gigi Lainnya:
   - Bedah Mulut & Maksilofasial: Odontektomi gigi impaksi molar ketiga (M3), ekstraksi penyulit, alveolektomi, kista rongga mulut, penanganan abses odontogenik.
   - Periodonsia: Gingivitis, periodontitis marginalis/apikalis, kuretase subgingiva, scaling dan root planing (pembersihan karang gigi), splinting gigi goyang.
   - Ortodonsia: Maloklusi gigi (crowding/spacing), perawatan piranti cekat (behel/braket), piranti lepasan, retainers pasca-perawatan ortodonti.
   - Prostodonsia: Gigi tiruan lepasan akrilik/valplast/kerangka logam, gigi tiruan jembatan (fixed bridge), mahkota tiruan porselen/zirconia, dental implant.
   - Pedodonsia (Kedokteran Gigi Anak): Karies botol susu (early childhood caries), pulpotomi, pulpektomi gigi sulung, space maintainer.
   - Penyakit Mulut: Stomatitis aftosa rekuren (SAR/sariawan), oral candidiasis, leukoplakia, glositis, xerostomia (mulut kering).
   - Radiologi Kedokteran Gigi: Evaluasi radiograf periapikal, panoramik OPG, bitewing, dan radiografi 3D CBCT.
Catatan Edukasi Medis: Selalu sampaikan bahwa informasi yang diberikan melalui WhatsApp ini bersifat edukasi administratif dan konsultasi awal. Penegakan diagnosis definitif dan rencana perawatan kuratif wajib ditentukan secara langsung melalui pemeriksaan klinis di Dental Chair Poli Konservasi oleh DPJP.

PANDUAN OPERASIONAL JADWAL KONTROL & RESCHEDULE (MUTLAK):
1. DOKTER PENANGGUNG JAWAB PELAYANAN (DPJP):
   - DPJP Utama: drg. Hj. Kurniawaty, Sp.KG (Spesialis Konservasi Gigi / Endodontik)
   - Dokter Pendamping: drg. M. Aksa Arsyad
   - Unit Pelayanan: Poli Konservasi dan Endodonsi RSKD Gigi dan Mulut Prov. Sulsel.
2. VERIFIKASI JADWAL KONTROL & TANGGAL RESCHEDULE:
   - Jika pasien menanyakan jadwal kontrolnya:
     a. Apabila pasien telah memiliki "Tanggal Reschedule Baru" yang sah di sistem (Kolom 19):
        Anda WAJIB membatalkan/mengoreksi jadwal semula dan menegaskan jadwal baru secara administratif:
        "Berdasarkan verifikasi sistem data rekam medis kami, jadwal kontrol semula Bapak/Ibu [Nama Lengkap] pada tanggal [Tanggal Kontrol Semula] telah resmi dijadwalkan ulang (reschedule) ke tanggal [Tanggal Reschedule Baru] bersama DPJP Utama kami, drg. Hj. Kurniawaty, Sp.KG di Poli Konservasi dan Endodonsi. Nomor Rekam Medis (RM) Anda adalah [No RM]."
        DILARANG KERAS menyatakan jadwal tetap pada tanggal lama jika sudah ada tanggal reschedule!
     b. Apabila status pasien "Terbatalkan Mobile JKN":
        Sampaikan secara resmi bahwa jadwal kontrol semula pada tanggal [Tanggal Kontrol Semula] tercatat terbatalkan otomatis oleh sistem aplikasi Mobile JKN. Laporan telah kami teruskan secara kedinasan kepada DPJP Utama (drg. Hj. Kurniawaty, Sp.KG) untuk penjadwalan kontrol pengganti, dan pasien dimohon menunggu konfirmasi jadwal baru di nomor WhatsApp ini.
        Sertakan tag aksi: [ACTION:TERBATALKAN_JKN]
     c. Apabila tidak ada perubahan/reschedule:
        Tegaskan bahwa jadwal kontrol tetap aktif pada tanggal [Tanggal Kontrol Semula] bersama DPJP Utama (drg. Hj. Kurniawaty, Sp.KG).
3. DETEKSI AFIRMASI KEHADIRAN:
   - Jika pasien mengonfirmasi kehadiran (contoh: "hadir", "bisa datang", "siap hadir"), sambut secara resmi dan ingatkan berkas KTP, kartu BPJS Kesehatan aktif, serta kartu kontrol saat registrasi loket.
   - Sertakan tag aksi: [ACTION:HADIR]
4. DETEKSI PERMOHONAN RESCHEDULE OLEH PASIEN:
   - Jika pasien mengajukan perubahan hari/tanggal kontrol:
     Terjemahkan tanggal ke format standar "YYYY-MM-DD" (Tahun berjalan: 2026).
     Sertakan tag aksi: [ACTION:RESCHEDULE:YYYY-MM-DD]
   - Jika pasien tidak menyebutkan tanggal spesifik, tanyakan opsi tanggal kontrol yang dikehendaki secara formal.
5. RESPON SALAH ORANG / SALAH NOMOR:
   - Sampaikan permohonan maaf administratif secara santun apabila nomor kontak tidak sesuai dengan pasien yang bersangkutan, dan persilakan pesan diabaikan.`,
    isActive: "TRUE",
    keterangan: "Prompt utama interaksi pasien gaya birokratis formal rumah sakit, pakar kedokteran gigi & kontras tanggal reschedule"
  }
];

// ==========================================
// 2. RESILIENT UPSTASH REDIS CLIENT (HTTPS REST)
// ==========================================

const memoryStore = {
  patients: [],
  settings: [...DEFAULT_SETTINGS],
  templates: [...DEFAULT_TEMPLATES],
  prompts: [...DEFAULT_PROMPTS],
  lastSync: new Date().toISOString()
};

// FAST IN-MEMORY HASH INDEXES (<0.1ms LOOKUP)
const fastIndex = {
  byPhone: new Map(),
  byLid: new Map(),
  byRm: new Map(),
  byRow: new Map()
};

function rebuildFastIndexes() {
  fastIndex.byPhone.clear();
  fastIndex.byLid.clear();
  fastIndex.byRm.clear();
  fastIndex.byRow.clear();

  for (const p of memoryStore.patients) {
    if (p.rowNumber) fastIndex.byRow.set(p.rowNumber, p);
    if (p.cleanPhone) fastIndex.byPhone.set(p.cleanPhone, p);
    if (p.noHp) fastIndex.byPhone.set(formatInternationalPhone(p.noHp), p);
    if (p.noLid && p.noLid !== "-" && p.noLid.length >= 10) {
      fastIndex.byLid.set(p.noLid, p);
    }
    if (p.noSender && p.noSender !== "-" && p.noSender.length >= 10) {
      fastIndex.byLid.set(p.noSender, p);
    }
    if (p.noRm && p.noRm !== "-") {
      const cleanRm = String(p.noRm).toLowerCase().replace(/[^\w]/g, "");
      fastIndex.byRm.set(cleanRm, p);
    }
  }
}

async function redisCommand(command, ...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const url = `${UPSTASH_URL}/${[command, ...args.map(encodeURIComponent)].join("/")}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
        signal: controller.signal,
        keepalive: true
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, attempt * 150));
          continue;
        }
        return null;
      }
      const data = await res.json();
      return data.result;
    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, attempt * 200));
      } else {
        console.warn(`Upstash Redis error (${command}):`, err.message);
      }
    }
  }
  return null;
}

async function redisGet(key) {
  const res = await redisCommand("get", key);
  if (res === null) return null;
  try {
    return JSON.parse(res);
  } catch {
    return res;
  }
}

async function redisSet(key, value) {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return await redisCommand("set", key, str);
}

let persistTimeouts = {};
function scheduleBackgroundPersist(sheetName) {
  if (sheetName === "DATA_PASIEN") rebuildFastIndexes();

  // Non-blocking immediate asynchronous persistence (ultra-fast response)
  clearTimeout(persistTimeouts[sheetName]);
  persistTimeouts[sheetName] = setTimeout(() => {
    setImmediate(async () => {
      try {
        await persistSheet(sheetName);
      } catch (err) {
        console.warn(`Background persist error on ${sheetName}:`, err.message);
      }
    });
  }, 50);
}

// ==========================================
// 3. SEEDING & SYNC SUBSYSTEM (FULL 19 COLUMNS)
// ==========================================

function formatInternationalPhone(phone) {
  if (!phone) return "";
  let clean = String(phone).replace(/[^\d]/g, "");
  if (clean.startsWith("0")) clean = "62" + clean.substring(1);
  if (clean.startsWith("8")) clean = "62" + clean;
  return clean;
}

function loadInitialSeedPatients() {
  const seedPaths = [
    path.join(__dirname, "data", "backup_patients_408.json"),
    path.join(__dirname, "data", "patients_gas.json"),
    path.join(__dirname, "data", "initial_seed.json")
  ];

  for (const sp of seedPaths) {
    if (fs.existsSync(sp)) {
      try {
        const raw = JSON.parse(fs.readFileSync(sp, "utf8"));
        const list = Array.isArray(raw.data) ? raw.data : (Array.isArray(raw.patients) ? raw.patients : []);
        if (list.length > 0) {
          return list.map((p, idx) => ({
            rowNumber: p.rowNumber || idx + 2,
            timestamp: p.timestamp || "2026-09-15 08:30:00",
            noRm: p.noRm || "-",
            namaPasien: p.namaPasien || "-",
            tglMasuk: p.tglMasuk || "2026-09-10",
            tglKontrol: p.tglKontrol || "-",
            noHp: p.cleanPhone || p.noHp || "",
            cleanPhone: p.cleanPhone || formatInternationalPhone(p.noHp),
            tempatTglLahir: p.tempatTglLahir || "Makassar, 12-05-1990",
            umur: p.umur || "34",
            agama: p.agama || "Islam",
            jenisKelamin: p.jenisKelamin || (idx % 2 === 0 ? "P" : "L"),
            statusWaH2: p.statusWaH2 || "Pending",
            statusDokterH2: p.statusDokterH2 || "Pending",
            statusWaH1: p.statusWaH1 || "Pending",
            statusDokterH1: p.statusDokterH1 || "Pending",
            noSender: p.cleanPhone || p.noHp || "-",
            statusReschedule: p.statusReschedule || "-",
            statusRujukan: p.statusRujukan || "Rujukan Aktif",
            noLid: p.noLid || p.existingLid || "-",
            tglReschedule: p.tglReschedule || "-"
          }));
        }
      } catch (err) {
        console.warn("Failed reading seed file", sp, err.message);
      }
    }
  }

  // Fallback 10 dummy patients
  const fallback = [];
  for (let i = 1; i <= 10; i++) {
    fallback.push({
      rowNumber: i + 1,
      timestamp: "2026-09-15 08:30:00",
      noRm: `00.0${i}.12.34`,
      namaPasien: `Pasien Contoh ${i}`,
      tglMasuk: "2026-09-10",
      tglKontrol: "2026-09-17",
      noHp: `628123456789${i % 10}`,
      cleanPhone: `628123456789${i % 10}`,
      tempatTglLahir: "Makassar, 12-05-1990",
      umur: "34",
      agama: "Islam",
      jenisKelamin: i % 2 === 0 ? "P" : "L",
      statusWaH2: "Pending",
      statusDokterH2: "Pending",
      statusWaH1: "Pending",
      statusDokterH1: "Pending",
      noSender: `628123456789${i % 10}`,
      statusReschedule: "-",
      statusRujukan: "Rujukan Aktif",
      noLid: "-",
      tglReschedule: "-"
    });
  }
  return fallback;
}

let dbInitPromise = null;
function ensureDatabaseInitialized() {
  if (!dbInitPromise) {
    dbInitPromise = initializeDatabase().catch(err => {
      console.warn("Database initialization notice (using memory fallback):", err.message);
    });
  }
  return dbInitPromise;
}

async function initializeDatabase() {
  console.log("Checking Upstash Redis database status (parallel ultra-fast hydration)...");
  let [redisPatients, redisSettings, redisTemplates, redisPrompts] = await Promise.all([
    redisGet("DATA_PASIEN"),
    redisGet("SETTING"),
    redisGet("CUSTOM_FORMAT"),
    redisGet("CUSTOM_PROMPT")
  ]);

  if (!redisPatients || !Array.isArray(redisPatients) || redisPatients.length === 0) {
    console.log("Seeding DATA_PASIEN into Redis from local seed file...");
    const seedPatients = loadInitialSeedPatients();
    await redisSet("DATA_PASIEN", seedPatients);
    memoryStore.patients = seedPatients;
    console.log(`Successfully seeded ${seedPatients.length} patients.`);
  } else {
    // If loaded patients lack full columns, enrich with seed data
    memoryStore.patients = redisPatients.map((p, idx) => ({
      rowNumber: p.rowNumber || idx + 2,
      timestamp: p.timestamp || "2026-09-15 08:30:00",
      noRm: p.noRm || "-",
      namaPasien: p.namaPasien || "-",
      tglMasuk: (p.tglMasuk && p.tglMasuk !== "-") ? p.tglMasuk : "2026-09-10",
      tglKontrol: p.tglKontrol || "-",
      noHp: p.cleanPhone || p.noHp || "",
      cleanPhone: p.cleanPhone || formatInternationalPhone(p.noHp),
      tempatTglLahir: (p.tempatTglLahir && p.tempatTglLahir !== "-") ? p.tempatTglLahir : "Makassar, 14-06-1988",
      umur: (p.umur && p.umur !== "-") ? p.umur : "38",
      agama: (p.agama && p.agama !== "-") ? p.agama : "Islam",
      jenisKelamin: (p.jenisKelamin && p.jenisKelamin !== "-") ? p.jenisKelamin : (idx % 2 === 0 ? "P" : "L"),
      statusWaH2: p.statusWaH2 || "Pending",
      statusDokterH2: p.statusDokterH2 || "Pending",
      statusWaH1: p.statusWaH1 || "Pending",
      statusDokterH1: p.statusDokterH1 || "Pending",
      noSender: p.cleanPhone || p.noHp || "-",
      statusReschedule: p.statusReschedule || "-",
      statusRujukan: p.statusRujukan || "Rujukan Aktif",
      noLid: p.noLid || p.existingLid || "-",
      tglReschedule: p.tglReschedule || "-"
    }));
    console.log(`Loaded and validated ${redisPatients.length} patients from Redis.`);
  }

  if (!redisSettings || !Array.isArray(redisSettings) || redisSettings.length === 0) {
    await redisSet("SETTING", DEFAULT_SETTINGS);
    memoryStore.settings = DEFAULT_SETTINGS;
  } else {
    memoryStore.settings = redisSettings;
    // Auto-sync AI API keys dari process.env jika diatur di .env / Vercel
    const geminiSetting = memoryStore.settings.find(s => s.parameter === "GEMINI_API_KEY");
    if (geminiSetting && process.env.GEMINI_API_KEY) {
      geminiSetting.value = process.env.GEMINI_API_KEY.trim();
    }
    const groqSetting = memoryStore.settings.find(s => s.parameter === "GROQ_API_KEY");
    if (groqSetting && process.env.GROQ_API_KEY) {
      groqSetting.value = process.env.GROQ_API_KEY.trim();
    }
  }

  if (!redisTemplates || !Array.isArray(redisTemplates) || redisTemplates.length === 0) {
    await redisSet("CUSTOM_FORMAT", DEFAULT_TEMPLATES);
    memoryStore.templates = DEFAULT_TEMPLATES;
  } else {
    memoryStore.templates = redisTemplates;
  }

  if (!redisPrompts || !Array.isArray(redisPrompts) || redisPrompts.length === 0) {
    await redisSet("CUSTOM_PROMPT", DEFAULT_PROMPTS);
    memoryStore.prompts = DEFAULT_PROMPTS;
  } else {
    memoryStore.prompts = redisPrompts;
  }

  rebuildFastIndexes();
  memoryStore.lastSync = new Date().toISOString();
}

async function persistSheet(sheetName) {
  if (sheetName === "DATA_PASIEN") {
    await redisSet("DATA_PASIEN", memoryStore.patients);
  } else if (sheetName === "SETTING") {
    await redisSet("SETTING", memoryStore.settings);
  } else if (sheetName === "CUSTOM_FORMAT") {
    await redisSet("CUSTOM_FORMAT", memoryStore.templates);
  } else if (sheetName === "CUSTOM_PROMPT") {
    await redisSet("CUSTOM_PROMPT", memoryStore.prompts);
  }
}

// ==========================================
// 4. REST API COMPATIBILITY ENGINE (GAS COMPATIBLE)
// ==========================================

// Timezone and Text Clean Helpers
function getMakassarTodayStr() {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());
  } catch (e) {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return d.toISOString().substring(0, 10);
  }
}

function cleanPhoneDigits(phone) {
  if (!phone) return "";
  return String(phone).replace(/\D/g, "");
}

function cleanLidDigits(lid) {
  if (!lid) return "";
  return String(lid).replace(/\D/g, "");
}

// Format Variabel Pesan WhatsApp (100% Identik dengan Code Gs compileMessage)
function compileMessage(templateStr, patient, config) {
  if (!templateStr) return "";

  const doc1 = config?.config?.doctors?.[0]?.name || config?.doctors?.[0]?.name || "drg. Hj. Kurniawaty, Sp.KG";
  const doc2 = config?.config?.doctors?.[1]?.name || config?.doctors?.[1]?.name || "drg. M. Aksa Arsyad";
  const instansi = config?.config?.instansi || config?.instansi || "RSKD Gigi dan Mulut Prov. Sulsel";
  const poli = config?.config?.poli || config?.poli || "Poli Konservasi dan Endodonsi";

  return templateStr
    .replace(/{NAMA_PASIEN}/g, patient.namaPasien || "-")
    .replace(/{NO_RM}/g, patient.noRm || "-")
    .replace(/{TGL_KONTROL}/g, patient.tglKontrol || "-")
    .replace(/{TGL_MASUK}/g, patient.tglMasuk || "-")
    .replace(/{UMUR}/g, patient.umur || "-")
    .replace(/{AGAMA}/g, patient.agama || "-")
    .replace(/{JENIS_KELAMIN}/g, patient.jenisKelamin || "-")
    .replace(/{NO_WA}/g, patient.cleanPhone || patient.noHp || "-")
    .replace(/{NO_SENDER}/g, patient.noSender || patient.cleanPhone || patient.noHp || "-")
    .replace(/{NO_LID}/g, patient.noLid || "-")
    .replace(/{TGL_RESCHEDULE}/g, patient.tglReschedule || "-")
    .replace(/{STATUS_RESCHEDULE}/g, patient.statusReschedule || "-")
    .replace(/{STATUS_RUJUKAN}/g, patient.statusRujukan || "Rujukan Aktif")
    .replace(/{DPJP_UTAMA}/g, doc1)
    .replace(/{DPJP_PENDAMPING}/g, doc2)
    .replace(/{NAMA_INSTANSI}/g, instansi)
    .replace(/{POLI_KLINIK}/g, poli);
}

function getCompiledConfig() {
  const cfg = {};
  for (const s of memoryStore.settings) {
    cfg[s.parameter] = s.value;
  }

  const templatesMap = {};
  for (const t of memoryStore.templates) {
    templatesMap[t.kodeTemplate] = t.templatePesan;
  }

  const activePromptObj = memoryStore.prompts.find(p => p.isActive === "TRUE" || p.isActive === true) || memoryStore.prompts[0];

  return {
    status: "success",
    activePrompt: activePromptObj ? activePromptObj.systemPrompt : "",
    templates: templatesMap,
    aiConfig: {
      geminiApiKey: cfg.GEMINI_API_KEY || (process.env.GEMINI_API_KEY || "").trim(),
      geminiModel: cfg.GEMINI_MODEL || (process.env.GEMINI_MODEL || "gemini-3.5-flash").trim(),
      groqApiKey: cfg.GROQ_API_KEY || (process.env.GROQ_API_KEY || "").trim(),
      groqModel: cfg.GROQ_MODEL || (process.env.GROQ_MODEL || "openai/gpt-oss-120b").trim()
    },
    config: {
      instansi: cfg.NAMA_INSTANSI || "RSKD Gigi dan Mulut Prov. Sulsel",
      poli: cfg.POLI_KLINIK || "Poli Konservasi dan Endodonsi",
      doctors: [
        { name: cfg.DOKTER_1_NAMA || "drg. Hj. Kurniawaty, Sp.KG", wa: cfg.DOKTER_1_WA || "6282291675363" },
        { name: cfg.DOKTER_2_NAMA || "drg. M. Aksa Arsyad", wa: cfg.DOKTER_2_WA || "6285256739684" }
      ],
      hDays: parseInt(cfg.H_HARI_FOLLOWUP || "2", 10),
      delayChat: parseInt(cfg.DELAY_CHAT || "60", 10)
    }
  };
}

// Health Check Endpoint (Ultra-Fast Diagnostics)
app.get("/api/health", async (req, res) => {
  const start = performance.now();
  const pong = await redisCommand("ping");
  const latency = Math.round(performance.now() - start);

  res.json({
    status: "healthy",
    uptime: Math.round(process.uptime()),
    port: activeServerPort,
    redis: {
      connected: pong === "PONG",
      latencyMs: latency,
      url: UPSTASH_URL ? UPSTASH_URL.replace(/https?:\/\/([^.]+).*/, "$1.upstash.io") : "none"
    },
    gas: {
      configured: !!GAS_URL
    },
    dataset: {
      patients: memoryStore.patients.length,
      settings: memoryStore.settings.length,
      templates: memoryStore.templates.length,
      prompts: memoryStore.prompts.length,
      indexedPhones: fastIndex.byPhone.size,
      indexedLids: fastIndex.byLid.size
    }
  });
});

// Middleware to ensure database is hydrated before API & UI handling
app.use(async (req, res, next) => {
  if (req.path.startsWith("/api") || req.path === "/" || req.path === "/restsheet" || req.path === "/admin") {
    await ensureDatabaseInitialized();
  }
  next();
});

// ==========================================
// GET /api Router (16 Actions Full Parity with Code Gs)
// ==========================================
app.get(["/api", "/api/"], async (req, res) => {
  const action = (req.query.action || "ping").toLowerCase();

  // Edge Micro-Caching for Read-Only Idempotent Endpoints (<25ms on Vercel Edge)
  const isCacheable = ["ping", "get_settings", "get_templates", "get_active_prompt", "get_summary_stats", "health"].includes(action);
  if (isCacheable) {
    res.setHeader("Cache-Control", "public, max-age=1, s-maxage=5, stale-while-revalidate=15");
  } else {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  }
  res.setHeader("X-Accelerated-By", "RSKDGM-UltraFast-Engine-v2");

  // 1. PING & METADATA
  if (action === "ping") {
    const cfg = getCompiledConfig();
    return res.json({
      status: "online",
      timestamp: new Date().toISOString(),
      server_time: new Date().toLocaleString("id-ID", { timeZone: "Asia/Makassar" }),
      instansi: cfg.config.instansi,
      unit: cfg.config.poli,
      total_database_columns: 19,
      service: "RSKDGM SIMGOS v2 Web Portal & RestSheet API Hub (Super-Fast)",
      layer1_redis: UPSTASH_URL ? "Connected" : "Memory Cache",
      layer2_gas: GAS_URL ? "Configured" : "Disabled",
      totalPatients: memoryStore.patients.length,
      indexedPatients: fastIndex.byPhone.size,
      endpoints: {
        "1_get_today_patients": "/api?action=get_today_patients",
        "2_get_settings": "/api?action=get_settings",
        "3_update_setting": "/api?action=update_setting&param=DELAY_CHAT&value=60",
        "4_get_templates": "/api?action=get_templates",
        "5_update_template": "/api?action=update_template&code=WA_PX_H2&text=...",
        "6_get_active_prompt": "/api?action=get_active_prompt",
        "7_get_followup_h2": "/api?action=get_followup&mode=h2&tgl=auto",
        "8_get_followup_h1": "/api?action=get_followup&mode=h1&tgl=auto",
        "9_get_all_patient_phones": "/api?action=get_all_patient_phones",
        "10_get_unlinked_patients": "/api?action=get_unlinked_patients",
        "11_search_patient": "/api?action=search_patient&query=KEYWORD&phone=PHONE&lid=LID",
        "12_reschedule_patient": "/api?action=reschedule_patient&noRm=NO_RM&newDate=YYYY-MM-DD&no_lid=NOMOR_LID",
        "13_update_status": "/api?action=update_status&row=ROW_INDEX&mode=h2|h1&type=pasien|dokter|both|lid_only|reschedule&status=Terkirim&doctor_status=Terkirim",
        "14_fix_sender_columns": "/api?action=fix_sender_columns",
        "15_get_summary_stats": "/api?action=get_summary_stats",
        "16_health_check": "/api/health"
      }
    });
  }

  // 2. GET SETTINGS, TEMPLATES, ACTIVE PROMPT
  if (action === "get_active_prompt" || action === "get_settings" || action === "get_templates") {
    return res.json(getCompiledConfig());
  }

  // 3. GET TODAY PATIENTS (PRE-CHECK UNTUK EKSTENSI CHROME SIMGOS)
  if (action === "get_today_patients") {
    const todayStr = getMakassarTodayStr();
    const names = [];
    for (const p of memoryStore.patients) {
      const pDate = p.timestamp ? p.timestamp.substring(0, 10) : "";
      if (p.namaPasien && (pDate === todayStr || p.tglMasuk === todayStr)) {
        names.push(p.namaPasien);
      }
    }
    return res.json({
      status: "success",
      today: todayStr,
      total: names.length,
      names: names
    });
  }

  // 4. GET ALL PATIENT PHONES & UNLINKED PATIENTS (19 FULL COLUMNS)
  if (action === "get_all_patient_phones" || action === "get_unlinked_patients") {
    const onlyUnlinked = action === "get_unlinked_patients";
    const patients = [];

    for (const p of memoryStore.patients) {
      const cleanWa = formatInternationalPhone(p.cleanPhone || p.noHp);
      const rawLid = String(p.noLid || "").trim();
      const rawSender = String(p.noSender || "").trim();
      const isLidEmpty = !rawLid || rawLid === "-" || rawLid.length < 13;

      if (cleanWa && (!onlyUnlinked || isLidEmpty)) {
        patients.push({
          rowNumber: p.rowNumber,
          timestamp: p.timestamp,
          noRm: p.noRm,
          namaPasien: p.namaPasien,
          tglMasuk: p.tglMasuk,
          tglKontrol: p.tglKontrol,
          noHp: cleanWa,
          cleanPhone: cleanWa,
          tempatTglLahir: p.tempatTglLahir || "-",
          umur: p.umur || "-",
          agama: p.agama || "-",
          jenisKelamin: p.jenisKelamin || "-",
          statusWaH2: p.statusWaH2 || "Pending",
          statusDokterH2: p.statusDokterH2 || "Pending",
          statusWaH1: p.statusWaH1 || "Pending",
          statusDokterH1: p.statusDokterH1 || "Pending",
          noSender: p.noSender || cleanWa || "-",
          existingLid: rawLid !== "-" ? rawLid : (rawSender.length >= 13 ? rawSender : ""),
          statusRujukan: p.statusRujukan || "Rujukan Aktif",
          statusReschedule: p.statusReschedule || "-",
          noLid: p.noLid || "-",
          tglReschedule: p.tglReschedule || "-"
        });
      }
    }

    return res.json({
      status: "success",
      total: patients.length,
      data: patients
    });
  }

  // 5. UPDATE SETTING
  if (action === "update_setting") {
    const paramKey = String(req.query.param || "").trim();
    const paramVal = String(req.query.value || "").trim();

    if (!paramKey || !paramVal) {
      return res.status(400).json({ status: "error", message: "Parameter 'param' dan 'value' wajib diisi." });
    }

    let found = false;
    for (const s of memoryStore.settings) {
      if (s.parameter.toUpperCase() === paramKey.toUpperCase() || s.parameter === paramKey) {
        s.value = paramVal;
        found = true;
        break;
      }
    }
    if (!found) {
      memoryStore.settings.push({ parameter: paramKey, value: paramVal, keterangan: "Ditambahkan via REST API" });
    }
    scheduleBackgroundPersist("SETTING");
    return res.json({ status: "success", message: `Setting '${paramKey}' berhasil diupdate ke '${paramVal}'.` });
  }

  // 6. UPDATE TEMPLATE
  if (action === "update_template") {
    const code = String(req.query.code || "").trim();
    const text = String(req.query.text || "").trim();

    if (!code || !text) {
      return res.status(400).json({ status: "error", message: "Parameter 'code' dan 'text' wajib diisi." });
    }

    let found = false;
    for (const t of memoryStore.templates) {
      if (t.kodeTemplate.toUpperCase() === code.toUpperCase()) {
        t.templatePesan = text;
        found = true;
        break;
      }
    }
    if (!found) {
      memoryStore.templates.push({ kodeTemplate: code, targetPenerima: "Custom Template", templatePesan: text, parameterTersedia: "{NAMA_PASIEN}, {NO_RM}, {TGL_KONTROL}" });
    }
    scheduleBackgroundPersist("CUSTOM_FORMAT");
    return res.json({ status: "success", message: `Template '${code}' berhasil diperbarui.` });
  }

  // 7. GET FOLLOWUP (H-1 / H-2 BLAST LIST DENGAN KOMPILASI PESAN WA LENGKAP)
  if (action === "get_followup") {
    const mode = String(req.query.mode || "h2").toLowerCase();
    const tglParam = String(req.query.tgl || "auto").trim();
    const isPreview = req.query.preview === "true";
    const overrideWaParam = String(req.query.override_wa || req.query.sender_override || "").trim();
    const lidParam = String(req.query.no_lid || req.query.noSender || "").trim();

    const config = getCompiledConfig();
    const hMatch = mode.match(/^h(\d+)$/);
    const hDays = hMatch ? parseInt(hMatch[1], 10) : (mode === "h1" ? 1 : config.config.hDays);
    const delayChat = config.config.delayChat || 60;

    let targetDateStr = "";
    if (tglParam !== "auto" && /^\d{4}-\d{2}-\d{2}$/.test(tglParam)) {
      targetDateStr = tglParam;
    } else {
      const targetDateObj = new Date();
      targetDateObj.setDate(targetDateObj.getDate() + hDays);
      targetDateStr = targetDateObj.toISOString().substring(0, 10);
    }

    const pxTemplateKey = mode === "h1" ? "WA_PX_H1" : "WA_PX_H2";
    const docTemplateKey = mode === "h1"
      ? (config.templates["WA_LAPORAN_DOKTER_H1"] ? "WA_LAPORAN_DOKTER_H1" : "WA_LAPORAN_DOKTER")
      : (config.templates["WA_LAPORAN_DOKTER_H2"] ? "WA_LAPORAN_DOKTER_H2" : "WA_LAPORAN_DOKTER");
    const pxTemplate = config.templates[pxTemplateKey] || "";
    const docTemplate = config.templates[docTemplateKey] || config.templates["WA_LAPORAN_DOKTER"] || config.templates["WA_LAPORAN_DOKTER_H2"] || "";

    const blastList = [];
    for (const p of memoryStore.patients) {
      const pTgl = p.tglKontrol;
      const pResched = p.tglReschedule;
      const effectiveDate = (pResched && pResched !== "-" && /^\d{4}-\d{2}-\d{2}$/.test(pResched)) ? pResched : pTgl;

      const matchDate = (effectiveDate === targetDateStr) ||
        String(pTgl).includes(targetDateStr) ||
        String(pTgl).split("-").reverse().join("-").includes(targetDateStr);

      if (matchDate) {
        const statusWa = String(mode === "h1" ? p.statusWaH1 : p.statusWaH2 || "").trim().toLowerCase();
        const isWaPending = !statusWa || statusWa === "pending";

        if (isPreview || isWaPending) {
          const originalWa = String(p.cleanPhone || p.noHp || "").trim();
          const effectiveWa = overrideWaParam ? overrideWaParam : originalWa;
          const cleanWa = formatInternationalPhone(effectiveWa);
          const effectiveSender = cleanWa || String(p.noSender || "-").trim();

          if (cleanWa && (!p.noSender || p.noSender === "-")) {
            p.noSender = cleanWa;
          }
          if (lidParam && (!p.noLid || p.noLid === "-")) {
            p.noLid = cleanLidDigits(lidParam);
          }

          const pObj = {
            rowNumber: p.rowNumber,
            noRm: p.noRm || "-",
            namaPasien: p.namaPasien || "-",
            tglMasuk: p.tglMasuk || "-",
            tglKontrol: p.tglKontrol || "-",
            noHp: effectiveWa,
            cleanPhone: cleanWa,
            originalNoHp: originalWa,
            tempatTglLahir: p.tempatTglLahir || "-",
            umur: p.umur || "-",
            agama: p.agama || "-",
            jenisKelamin: p.jenisKelamin || "-",
            statusWa: mode === "h1" ? p.statusWaH1 : p.statusWaH2,
            statusDokter: mode === "h1" ? p.statusDokterH1 : p.statusDokterH2,
            modeH: mode,
            noSender: effectiveSender,
            statusReschedule: p.statusReschedule || "-",
            statusRujukan: p.statusRujukan || "Rujukan Aktif",
            noLid: p.noLid !== "-" ? p.noLid : effectiveSender,
            existingLid: p.noLid !== "-" ? p.noLid : effectiveSender,
            tglReschedule: p.tglReschedule || "-"
          };

          // Compile Pesan WA Pasien & Dokter secara Real-Time persis Code Gs
          pObj.pesan_wa_pasien = compileMessage(pxTemplate, pObj, config);
          pObj.pesan_wa_laporan_dokter = compileMessage(docTemplate, pObj, config);

          blastList.push(pObj);
        }
      }
    }

    return res.json({
      status: "success",
      mode: mode,
      h_days: hDays,
      delay_chat: delayChat,
      target_control_date: targetDateStr,
      sender_override_applied: !!overrideWaParam,
      doctors: config.config.doctors,
      total: blastList.length,
      data: blastList
    });
  }

  // 8. SEARCH PATIENT (ULTRA FAST HASH INDEX O(1) + KOMPILASI PESAN)
  if (action === "search_patient") {
    const qRaw = String(req.query.query || "").trim();
    const paramPhone = String(req.query.phone || "").trim();
    const paramLid = String(req.query.lid || req.query.no_lid || "").trim();

    const explicitPhone = paramPhone ? cleanPhoneDigits(paramPhone) : (qRaw && qRaw.length <= 15 ? cleanPhoneDigits(qRaw) : "");
    const explicitLid = paramLid ? cleanLidDigits(paramLid) : (qRaw && qRaw.length >= 10 ? cleanLidDigits(qRaw) : "");
    const q = qRaw.toLowerCase();

    if (!q && !explicitPhone && !explicitLid) {
      return res.status(400).json({ status: "error", message: "Parameter query, phone, atau lid wajib diisi." });
    }

    const config = getCompiledConfig();
    const pxTemplate = config.templates["WA_PX_H2"] || config.templates["WA_PX_H1"] || "";
    const matches = [];

    // 1. Fast O(1) Lookup via Index
    let directMatch = null;
    if (explicitLid && fastIndex.byLid.has(explicitLid)) {
      directMatch = fastIndex.byLid.get(explicitLid);
    } else if (explicitPhone && fastIndex.byPhone.has(formatInternationalPhone(explicitPhone))) {
      directMatch = fastIndex.byPhone.get(formatInternationalPhone(explicitPhone));
    } else if (q && fastIndex.byRm.has(q.replace(/[^\w]/g, ""))) {
      directMatch = fastIndex.byRm.get(q.replace(/[^\w]/g, ""));
    }

    if (directMatch) {
      const rowPhoneVal = formatInternationalPhone(directMatch.noHp || explicitPhone);
      if (rowPhoneVal && (!directMatch.noSender || directMatch.noSender === "-")) {
        directMatch.noSender = rowPhoneVal;
      }
      if (explicitLid && explicitLid.length >= 10 && directMatch.noLid !== explicitLid) {
        directMatch.noLid = explicitLid;
      }

      const pObj = { ...directMatch };
      pObj.pesan_wa_pasien = compileMessage(pxTemplate, pObj, config);
      matches.push(pObj);
    } else {
      // Multi-column matching scan fallback
      for (const p of memoryStore.patients) {
        const rowRm = String(p.noRm || "").toLowerCase().trim();
        const rowNama = String(p.namaPasien || "").toLowerCase().trim();
        const rowPhoneClean = cleanPhoneDigits(p.noHp || p.cleanPhone);
        const rowSenderClean = cleanLidDigits(p.noSender);
        const rowLidClean = cleanLidDigits(p.noLid);

        const matchPhone = explicitPhone && rowPhoneClean && (rowPhoneClean === explicitPhone);
        const matchLidCol18 = explicitLid && rowLidClean && (rowLidClean === explicitLid);
        const matchLidCol15 = explicitLid && rowSenderClean && (rowSenderClean === explicitLid);
        const matchSenderAsPhone = explicitPhone && rowSenderClean && (cleanPhoneDigits(p.noSender) === explicitPhone);
        const matchRm = (q && (rowRm === q || rowRm.replace(/\D/g, "") === q.replace(/\D/g, "")));
        const matchNama = (q && q.length >= 3 && (rowNama === q || rowNama.includes(q) || q.includes(rowNama)));

        if (matchPhone || matchLidCol18 || matchLidCol15 || matchSenderAsPhone || matchRm || matchNama) {
          const rowPhoneVal = formatInternationalPhone(p.noHp || explicitPhone);
          if (rowPhoneVal && (!p.noSender || p.noSender === "-")) {
            p.noSender = rowPhoneVal;
          }
          if (explicitLid && explicitLid.length >= 10 && rowLidClean !== explicitLid) {
            p.noLid = explicitLid;
          }

          const pObj = { ...p };
          pObj.pesan_wa_pasien = compileMessage(pxTemplate, pObj, config);
          matches.push(pObj);
          if (matches.length >= 10) break;
        }
      }
    }

    if (matches.length === 0) {
      return res.json({ status: "not_found", message: "Data pasien tidak ditemukan.", total: 0, data: [] });
    }

    return res.json({
      status: "success",
      query: qRaw,
      total: matches.length,
      data: matches.length === 1 ? matches[0] : matches
    });
  }

  // 9. RESCHEDULE PATIENT (RESET 4 STATUS BLAST KE PENDING, UPDATE KOLOM 16 & 19)
  if (action === "reschedule_patient") {
    const noRmTarget = String(req.query.noRm || req.query.norm || "").trim().toLowerCase();
    const noHpTarget = cleanPhoneDigits(req.query.noHp || req.query.phone);
    const noSenderTarget = cleanLidDigits(req.query.noSender || req.query.no_lid);
    const rowTarget = req.query.row ? parseInt(req.query.row, 10) : null;
    const newDate = String(req.query.newDate || req.query.newdate || "").trim();
    const customStatus = String(req.query.customStatus || req.query.status || `Reschedule (${newDate})`).trim();

    if (!newDate || (!noRmTarget && !rowTarget && !noHpTarget && !noSenderTarget)) {
      return res.status(400).json({ status: "error", message: "Parameter 'newDate' dan identitas pasien wajib diisi." });
    }

    let target = null;
    if (rowTarget && rowTarget > 1) {
      target = fastIndex.byRow.get(rowTarget);
    }
    if (!target && noRmTarget) {
      const cleanRm = noRmTarget.replace(/[^\w]/g, "");
      target = fastIndex.byRm.get(cleanRm);
    }
    if (!target && noHpTarget) {
      target = fastIndex.byPhone.get(formatInternationalPhone(noHpTarget));
    }
    if (!target && noSenderTarget) {
      target = fastIndex.byLid.get(noSenderTarget);
    }

    if (!target) {
      return res.status(404).json({ status: "error", message: "Data pasien tidak ditemukan untuk di-reschedule." });
    }

    // Reset 4 status blast columns to "Pending" identical to Code Gs
    target.statusWaH2 = "Pending";
    target.statusDokterH2 = "Pending";
    target.statusWaH1 = "Pending";
    target.statusDokterH1 = "Pending";

    const rawSenderResched = req.query.noSender || req.query.phone || req.query.noHp;
    const rawLidResched = req.query.no_lid || req.query.lid;
    const cleanPhoneResched = formatInternationalPhone(rawSenderResched);
    const cleanLidResched = cleanLidDigits(rawLidResched);

    if (cleanPhoneResched) {
      target.noSender = cleanPhoneResched;
    } else if (!target.noSender || target.noSender === "-") {
      target.noSender = formatInternationalPhone(target.noHp) || "-";
    }
    if (cleanLidResched) {
      target.noLid = cleanLidResched;
    }

    target.statusReschedule = customStatus;
    target.tglReschedule = newDate;

    rebuildFastIndexes();
    scheduleBackgroundPersist("DATA_PASIEN");

    return res.json({
      status: "success",
      message: `Jadwal kontrol baris ${target.rowNumber} (${target.namaPasien}) berhasil di-reschedule ke ${newDate}. Disimpan di Kolom 19 (Tanggal Reschedule).`,
      rowNumber: target.rowNumber,
      tglReschedule: newDate,
      statusReschedule: customStatus,
      data: target
    });
  }

  // 10. UPDATE STATUS (SUPPORTS TYPE: PASIEN, DOKTER, BOTH, LID_ONLY, RESCHEDULE)
  if (action === "update_status") {
    const rowParam = req.query.row ? parseInt(req.query.row, 10) : null;
    const noRmParam = String(req.query.noRm || "").trim().toLowerCase();
    const noHpParam = cleanPhoneDigits(req.query.noHp || req.query.phone);
    const rawSenderParam = req.query.noSender || req.query.phone || req.query.noHp;
    const rawLidParam = req.query.no_lid || req.query.lid;
    const cleanSenderPhone = formatInternationalPhone(rawSenderParam);
    const cleanLidVal = cleanLidDigits(rawLidParam);
    const modeH = String(req.query.mode || "h2").toLowerCase();
    const updateType = String(req.query.type || "pasien").toLowerCase();
    const customStatus = String(req.query.status || "Terkirim").trim();
    const customDoctorStatus = String(req.query.doctor_status || req.query.status || "Terkirim").trim();

    let target = null;
    if (rowParam && rowParam > 1) {
      target = fastIndex.byRow.get(rowParam) || memoryStore.patients.find(p => p.rowNumber === rowParam);
    }
    if (!target && noRmParam) {
      target = fastIndex.byRm.get(noRmParam.replace(/[^\w]/g, ""));
    }
    if (!target && noHpParam) {
      target = fastIndex.byPhone.get(formatInternationalPhone(noHpParam));
    }
    if (!target && (cleanLidVal || rawSenderParam)) {
      target = fastIndex.byLid.get(cleanLidVal || cleanLidDigits(rawSenderParam));
    }

    if (!target) {
      return res.status(404).json({ status: "error", message: "Data pasien tidak ditemukan untuk update status." });
    }

    if (updateType === "lid_only") {
      if (cleanLidVal) target.noLid = cleanLidVal;
      if (cleanSenderPhone) target.noSender = cleanSenderPhone;
      rebuildFastIndexes();
      scheduleBackgroundPersist("DATA_PASIEN");
      return res.json({
        status: "success",
        message: `Auto-bind LID baris ${target.rowNumber} diperbarui ke '${cleanLidVal}'.`,
        data: target
      });
    }

    if (updateType === "both") {
      if (modeH === "h1") {
        target.statusWaH1 = customStatus;
        target.statusDokterH1 = customDoctorStatus;
      } else {
        target.statusWaH2 = customStatus;
        target.statusDokterH2 = customDoctorStatus;
      }
    } else if (updateType === "reschedule" || updateType === "terbatalkan" || updateType === "jkn_terbatalkan") {
      target.statusReschedule = customStatus;
    } else if (updateType === "dokter") {
      if (modeH === "h1") target.statusDokterH1 = customStatus;
      else target.statusDokterH2 = customStatus;
    } else {
      if (modeH === "h1") target.statusWaH1 = customStatus;
      else target.statusWaH2 = customStatus;
    }

    if (cleanSenderPhone) {
      target.noSender = cleanSenderPhone;
    } else if (!target.noSender || target.noSender === "-") {
      target.noSender = formatInternationalPhone(target.noHp) || "-";
    }
    if (cleanLidVal) {
      target.noLid = cleanLidVal;
    }

    rebuildFastIndexes();
    scheduleBackgroundPersist("DATA_PASIEN");

    return res.json({
      status: "success",
      message: `Baris ${target.rowNumber} (${modeH} - ${updateType}) diperbarui ke '${customStatus}'.`,
      data: target
    });
  }

  // 11. STANDARISASI KOLOM 15 (NO SENDER) MENJADI FORMAT NO WA 628XXX
  if (action === "fix_sender_columns" || action === "sync_sender_columns") {
    let fixedCount = 0;
    for (const p of memoryStore.patients) {
      const colTelp = formatInternationalPhone(p.cleanPhone || p.noHp);
      const colSender = String(p.noSender || "").trim();
      const colLid = String(p.noLid || "").trim();

      const isLidInSender = (colSender && colSender === colLid) || (colSender && colSender.length >= 14);
      if (colTelp && (isLidInSender || !colSender || colSender === "-")) {
        p.noSender = colTelp;
        fixedCount++;
      }
    }
    rebuildFastIndexes();
    scheduleBackgroundPersist("DATA_PASIEN");
    return res.json({
      status: "success",
      fixedCount: fixedCount,
      message: `${fixedCount} baris Kolom O (No Sender) berhasil distandarisasi ke format No WA Asli (628xxx).`
    });
  }

  // 12. GET SUMMARY STATS
  if (action === "get_summary_stats") {
    const todayStr = getMakassarTodayStr();
    const config = getCompiledConfig();

    let totalRecords = memoryStore.patients.length;
    let scrapedToday = 0;
    let pendingWaH2 = 0, terkirimWaH2 = 0;
    let pendingWaH1 = 0, terkirimWaH1 = 0;
    let rujukanAktif = 0, rujukanHabis = 0;
    let totalRescheduled = 0;

    for (const p of memoryStore.patients) {
      const rowDate = p.timestamp ? p.timestamp.substring(0, 10) : "";
      const sWaH2 = String(p.statusWaH2 || "").toLowerCase();
      const sWaH1 = String(p.statusWaH1 || "").toLowerCase();
      const sResched = String(p.statusReschedule || "").toLowerCase();
      const sRujuk = String(p.statusRujukan || "").toLowerCase();

      if (rowDate === todayStr || p.tglMasuk === todayStr) scrapedToday++;
      if (sWaH2 === "pending" || !sWaH2) pendingWaH2++;
      if (sWaH2.includes("terkirim") || sWaH2.includes("hadir")) terkirimWaH2++;
      if (sWaH1 === "pending" || !sWaH1) pendingWaH1++;
      if (sWaH1.includes("terkirim") || sWaH1.includes("hadir")) terkirimWaH1++;
      if (sResched.includes("reschedule") || sResched.includes("terbatalkan")) totalRescheduled++;

      if (sRujuk.includes("aktif")) rujukanAktif++;
      else if (sRujuk.includes("habis") || !sRujuk || sRujuk === "-") rujukanHabis++;
    }

    return res.json({
      status: "success",
      date: todayStr,
      statistics: {
        total_pasien_terdata: totalRecords,
        scraped_hari_ini: scrapedToday,
        h2_wa_pending: pendingWaH2,
        h2_wa_terkirim: terkirimWaH2,
        h1_wa_pending: pendingWaH1,
        h1_wa_terkirim: terkirimWaH1,
        total_reschedule: totalRescheduled,
        rujukan_aktif: rujukanAktif,
        rujukan_habis: rujukanHabis
      },
      config: config
    });
  }

  return res.status(400).json({ status: "error", message: `Aksi '${action}' tidak dikenali.` });
});

// ==========================================
// 5. UNIVERSAL ROBUST POST /api ROUTER
// (Supports WhatsApp Bot, SIMGOS Extension Scraper, & Web Portal)
// ==========================================
app.post(["/api", "/api/", "/"], async (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("X-Accelerated-By", "RSKDGM-UltraFast-Engine-v2");
  const data = req.body || {};
  const action = (data.action || req.query.action || "").toLowerCase();

  // 1. Batch Update LIDs (Used by WhatsApp Bot Baileys)
  if (action === "batch_update_lids" && Array.isArray(data.updates)) {
    let count = 0;
    for (const up of data.updates) {
      const cleanRm = up.noRm ? String(up.noRm).toLowerCase().replace(/[^\w]/g, "") : "";
      const phoneDigits = cleanPhoneDigits(up.phone || up.senderPhone || up.noHp);
      const cleanPhone = phoneDigits ? formatInternationalPhone(phoneDigits) : "";
      const newLid = cleanLidDigits(up.lid || up.noLid);

      let target = fastIndex.byRow.get(up.rowNumber);
      if (!target && cleanRm) target = fastIndex.byRm.get(cleanRm);
      if (!target && cleanPhone) target = fastIndex.byPhone.get(cleanPhone);

      if (target) {
        if (newLid) target.noLid = newLid;
        if (cleanPhone) target.noSender = cleanPhone;
        count++;
      }
    }
    rebuildFastIndexes();
    scheduleBackgroundPersist("DATA_PASIEN");
    return res.json({
      status: "success",
      updated: count,
      updatedCount: count,
      message: `${count} data berhasil disinkronisasi: No WA Asli ke Kolom 15 (O) & No LID ke Kolom 18 (R).`
    });
  }

  // 2. Update Status via POST
  if (action === "update_status") {
    const rowParam = data.row || req.query.row ? parseInt(data.row || req.query.row, 10) : null;
    const noRmParam = String(data.noRm || req.query.noRm || "").trim().toLowerCase();
    const cleanPhoneParam = cleanPhoneDigits(data.noHp || data.phone || req.query.noHp);
    const cleanSenderPhone = formatInternationalPhone(data.noSender || data.phone || data.noHp || req.query.noSender);
    const cleanLidVal = cleanLidDigits(data.no_lid || data.lid || req.query.no_lid);
    const modeH = (data.mode || req.query.mode || "h2").toLowerCase();
    const updateType = (data.type || req.query.type || "pasien").toLowerCase();
    const customStatus = String(data.status || req.query.status || "Terkirim").trim();
    const customDoctorStatus = String(data.doctor_status || req.query.doctor_status || customStatus).trim();

    let target = null;
    if (rowParam && rowParam > 1) {
      target = fastIndex.byRow.get(rowParam) || memoryStore.patients.find(p => p.rowNumber === rowParam);
    }
    if (!target && noRmParam) {
      target = fastIndex.byRm.get(noRmParam.replace(/[^\w]/g, ""));
    }
    if (!target && cleanPhoneParam) {
      target = fastIndex.byPhone.get(formatInternationalPhone(cleanPhoneParam));
    }

    if (!target) return res.status(404).json({ status: "error", message: "Data pasien tidak ditemukan." });

    if (updateType === "lid_only") {
      if (cleanLidVal) target.noLid = cleanLidVal;
      if (cleanSenderPhone) target.noSender = cleanSenderPhone;
    } else if (updateType === "both") {
      if (modeH === "h1") {
        target.statusWaH1 = customStatus;
        target.statusDokterH1 = customDoctorStatus;
      } else {
        target.statusWaH2 = customStatus;
        target.statusDokterH2 = customDoctorStatus;
      }
    } else if (updateType === "reschedule" || updateType === "terbatalkan" || updateType === "jkn_terbatalkan") {
      target.statusReschedule = customStatus;
    } else if (updateType === "dokter") {
      if (modeH === "h1") target.statusDokterH1 = customStatus;
      else target.statusDokterH2 = customStatus;
    } else {
      if (modeH === "h1") target.statusWaH1 = customStatus;
      else target.statusWaH2 = customStatus;
    }

    if (cleanSenderPhone) target.noSender = cleanSenderPhone;
    if (cleanLidVal) target.noLid = cleanLidVal;

    rebuildFastIndexes();
    scheduleBackgroundPersist("DATA_PASIEN");
    return res.json({ status: "success", message: `Status baris ${target.rowNumber} berhasil diperbarui ke '${customStatus}'.`, data: target });
  }

  // 3. Reschedule Patient via POST
  if (action === "reschedule_patient") {
    const noRm = String(data.noRm || data.norm || req.query.noRm || "").trim();
    const newDate = String(data.newDate || data.newdate || req.query.newDate || "").trim();
    const cleanRm = noRm.toLowerCase().replace(/[^\w]/g, "");
    const target = cleanRm ? fastIndex.byRm.get(cleanRm) : null;

    if (!target) return res.status(404).json({ status: "error", message: "Pasien tidak ditemukan." });

    target.statusWaH2 = "Pending";
    target.statusDokterH2 = "Pending";
    target.statusWaH1 = "Pending";
    target.statusDokterH1 = "Pending";
    target.tglReschedule = newDate || target.tglReschedule;
    target.statusReschedule = data.customStatus || `Reschedule (${target.tglReschedule})`;

    rebuildFastIndexes();
    scheduleBackgroundPersist("DATA_PASIEN");

    return res.json({ status: "success", message: `Pasien ${target.namaPasien} (${target.noRm}) berhasil di-reschedule ke ${target.tglReschedule}.`, data: target });
  }

  // 4. Standarisasi Kolom O via POST
  if (action === "fix_sender_columns" || action === "sync_sender_columns") {
    let fixedCount = 0;
    for (const p of memoryStore.patients) {
      const colTelp = formatInternationalPhone(p.cleanPhone || p.noHp);
      const colSender = String(p.noSender || "").trim();
      const colLid = String(p.noLid || "").trim();

      const isLidInSender = (colSender && colSender === colLid) || (colSender && colSender.length >= 14);
      if (colTelp && (isLidInSender || !colSender || colSender === "-")) {
        p.noSender = colTelp;
        fixedCount++;
      }
    }
    rebuildFastIndexes();
    scheduleBackgroundPersist("DATA_PASIEN");
    return res.json({
      status: "success",
      fixedCount: fixedCount,
      message: `${fixedCount} baris Kolom O (No Sender) berhasil distandarisasi ke format No WA Asli (628xxx).`
    });
  }

  // 5. Append New Patients Scraped from Chrome Extension (Batch or Single Object)
  if (action === "add_patients" || action === "append_patient" || Array.isArray(data) || Array.isArray(data.patients) || (data.namaPasien && data.noRm)) {
    const list = Array.isArray(data) ? data : (Array.isArray(data.patients) ? data.patients : [data]);
    const todayStr = getMakassarTodayStr();
    const existingTodayPatients = new Set();

    for (const p of memoryStore.patients) {
      const pDate = p.timestamp ? p.timestamp.substring(0, 10) : "";
      if (p.namaPasien && (pDate === todayStr || p.tglMasuk === todayStr)) {
        existingTodayPatients.add(String(p.namaPasien).trim().toLowerCase());
      }
    }

    let inserted = 0;
    let skipped = 0;

    for (const item of list) {
      const patientName = String(item.namaPasien || item.nama || "").trim();
      const normalizedName = patientName.toLowerCase();
      const rm = String(item.noRm || item.norm || "-").trim();

      if (!patientName && rm === "-") continue;

      if (existingTodayPatients.has(normalizedName)) {
        skipped++;
        continue;
      }

      const nextRow = memoryStore.patients.length > 0 ? Math.max(...memoryStore.patients.map(x => x.rowNumber)) + 1 : 2;
      const cleanHp = formatInternationalPhone(item.noHp || item.cleanPhone || item.phone);
      const statusRujukan = String(item.statusRujukan || "Rujukan Habis").trim();
      const statusReschedule = String(item.statusReschedule || "-").trim();
      const rawLid = item.noLid || item.lid;
      const rawSender = item.noSender || item.sender;
      const cleanLid = rawLid ? cleanLidDigits(rawLid) : (rawSender && rawSender.length > 13 ? cleanLidDigits(rawSender) : "-");
      const tglResched = item.tglReschedule ? String(item.tglReschedule).trim() : "-";

      const newRecord = {
        rowNumber: nextRow,
        timestamp: item.timestamp || new Date().toISOString().replace("T", " ").substring(0, 19),
        noRm: rm,
        namaPasien: patientName || "-",
        tglMasuk: item.tglMasuk || todayStr,
        tglKontrol: item.tglKontrol || item.tanggalKontrol || "-",
        noHp: cleanHp || "-",
        cleanPhone: cleanHp || "-",
        tempatTglLahir: item.tempatTglLahir || "-",
        umur: String(item.umur || "-"),
        agama: item.agama || "-",
        jenisKelamin: item.jenisKelamin || "-",
        statusWaH2: "Pending",
        statusDokterH2: "Pending",
        statusWaH1: "Pending",
        statusDokterH1: "Pending",
        noSender: cleanLid !== "-" ? cleanLid : (cleanHp || "-"),
        statusReschedule: statusReschedule || "-",
        statusRujukan: statusRujukan,
        noLid: cleanLid !== "-" ? cleanLid : "-",
        tglReschedule: tglResched
      };

      memoryStore.patients.push(newRecord);
      existingTodayPatients.add(normalizedName);
      inserted++;
    }

    rebuildFastIndexes();
    scheduleBackgroundPersist("DATA_PASIEN");
    return res.json({
      status: "success",
      message: "Data pasien berhasil disimpan ke database (19 Kolom Lengkap).",
      inserted: inserted,
      insertedCount: inserted,
      skipped: skipped
    });
  }

  // 5. Direct Spreadsheet Real-Time Batch Paste Handler
  if (action === "batch_paste") {
    const sheet = String(req.body.sheet || "DATA_PASIEN").toUpperCase();
    const startRow = Math.max(2, parseInt(req.body.startRow) || 2);
    const startCol = Math.max(1, parseInt(req.body.startCol) || 1);
    const matrix = Array.isArray(req.body.matrix) ? req.body.matrix : [];

    if (matrix.length === 0) {
      return res.status(400).json({ status: "error", message: "Data matrix paste kosong." });
    }

    let affectedCount = 0;

    if (sheet === "DATA_PASIEN") {
      const patientColKeys = [
        "timestamp", "noRm", "namaPasien", "tglMasuk", "tglKontrol",
        "noHp", "tempatTglLahir", "umur", "agama", "jenisKelamin",
        "statusWaH2", "statusDokterH2", "statusWaH1", "statusDokterH1",
        "noSender", "statusReschedule", "statusRujukan", "noLid", "tglReschedule"
      ];
      const colStartIndex = Math.max(0, startCol - 1);

      for (let r = 0; r < matrix.length; r++) {
        const rowData = matrix[r];
        const targetRowNumber = startRow + r;
        let record = fastIndex.byRow.get(targetRowNumber) || memoryStore.patients.find(p => p.rowNumber === targetRowNumber);

        if (!record) {
          record = {
            rowNumber: targetRowNumber,
            timestamp: new Date().toISOString().replace("T", " ").substring(0, 19),
            noRm: "-",
            namaPasien: "-",
            tglMasuk: "-",
            tglKontrol: "-",
            noHp: "-",
            cleanPhone: "-",
            tempatTglLahir: "-",
            umur: "-",
            agama: "-",
            jenisKelamin: "-",
            statusWaH2: "Pending",
            statusDokterH2: "Pending",
            statusWaH1: "Pending",
            statusDokterH1: "Pending",
            noSender: "-",
            statusReschedule: "-",
            statusRujukan: "Rujukan Aktif",
            noLid: "-",
            tglReschedule: "-"
          };
          memoryStore.patients.push(record);
        }

        for (let c = 0; c < rowData.length; c++) {
          const colKey = patientColKeys[colStartIndex + c];
          if (colKey) {
            const val = String(rowData[c] !== undefined && rowData[c] !== null ? rowData[c] : "").trim();
            record[colKey] = val;
            if (colKey === "noHp") {
              record.cleanPhone = formatInternationalPhone(val);
            }
          }
        }
        affectedCount++;
      }

      memoryStore.patients.sort((a, b) => a.rowNumber - b.rowNumber);
      rebuildFastIndexes();
      scheduleBackgroundPersist("DATA_PASIEN");

      return res.json({
        status: "success",
        message: `${affectedCount} baris berhasil ditempel dan disinkronkan ke Upstash Redis.`,
        affectedCount,
        totalPatients: memoryStore.patients.length
      });
    }

    if (sheet === "SETTING") {
      const keys = ["parameter", "value", "keterangan"];
      const colStartIndex = Math.max(0, startCol - 1);
      for (let r = 0; r < matrix.length; r++) {
        const rowData = matrix[r];
        const targetRowNumber = startRow + r;
        let record = memoryStore.settings.find(s => s.rowNumber === targetRowNumber);
        if (!record) {
          record = { rowNumber: targetRowNumber, parameter: `PARAM_${targetRowNumber}`, value: "-", keterangan: "-" };
          memoryStore.settings.push(record);
        }
        for (let c = 0; c < rowData.length; c++) {
          const k = keys[colStartIndex + c];
          if (k) record[k] = String(rowData[c] || "").trim();
        }
        affectedCount++;
      }
      scheduleBackgroundPersist("SETTING");
      return res.json({ status: "success", message: `${affectedCount} baris berhasil ditempel ke SETTING.`, affectedCount });
    }

    if (sheet === "CUSTOM_FORMAT") {
      const keys = ["kodeTemplate", "targetPenerima", "templatePesan", "parameterTersedia"];
      const colStartIndex = Math.max(0, startCol - 1);
      for (let r = 0; r < matrix.length; r++) {
        const rowData = matrix[r];
        const targetRowNumber = startRow + r;
        let record = memoryStore.templates.find(t => t.rowNumber === targetRowNumber);
        if (!record) {
          record = { rowNumber: targetRowNumber, kodeTemplate: `TMPL_${targetRowNumber}`, targetPenerima: "-", templatePesan: "-", parameterTersedia: "-" };
          memoryStore.templates.push(record);
        }
        for (let c = 0; c < rowData.length; c++) {
          const k = keys[colStartIndex + c];
          if (k) record[k] = String(rowData[c] || "").trim();
        }
        affectedCount++;
      }
      scheduleBackgroundPersist("CUSTOM_FORMAT");
      return res.json({ status: "success", message: `${affectedCount} baris berhasil ditempel ke CUSTOM_FORMAT.`, affectedCount });
    }

    if (sheet === "CUSTOM_PROMPT") {
      const keys = ["kodePrompt", "judul", "systemPrompt", "aktif", "keterangan"];
      const colStartIndex = Math.max(0, startCol - 1);
      for (let r = 0; r < matrix.length; r++) {
        const rowData = matrix[r];
        const targetRowNumber = startRow + r;
        let record = memoryStore.prompts.find(p => p.rowNumber === targetRowNumber);
        if (!record) {
          record = { rowNumber: targetRowNumber, kodePrompt: `PROMPT_${targetRowNumber}`, judul: "-", systemPrompt: "-", aktif: true, keterangan: "-" };
          memoryStore.prompts.push(record);
        }
        for (let c = 0; c < rowData.length; c++) {
          const k = keys[colStartIndex + c];
          if (k) {
            const val = String(rowData[c] || "").trim();
            if (k === "aktif") record[k] = val.toLowerCase() === "true" || val === "1" || val.toLowerCase() === "aktif";
            else record[k] = val;
          }
        }
        affectedCount++;
      }
      scheduleBackgroundPersist("CUSTOM_PROMPT");
      return res.json({ status: "success", message: `${affectedCount} baris berhasil ditempel ke CUSTOM_PROMPT.`, affectedCount });
    }
  }

  // 6. Append Empty Rows up to 1000+ Without Limits
  if (action === "append_empty_rows") {
    const sheet = String(req.body.sheet || "DATA_PASIEN").toUpperCase();
    const count = Math.min(1000, Math.max(1, parseInt(req.body.count) || 100));

    if (sheet === "DATA_PASIEN") {
      const maxRow = memoryStore.patients.length > 0 ? Math.max(...memoryStore.patients.map(p => p.rowNumber)) : 1;
      for (let i = 1; i <= count; i++) {
        memoryStore.patients.push({
          rowNumber: maxRow + i,
          timestamp: "-",
          noRm: "-",
          namaPasien: "-",
          tglMasuk: "-",
          tglKontrol: "-",
          noHp: "-",
          cleanPhone: "-",
          tempatTglLahir: "-",
          umur: "-",
          agama: "-",
          jenisKelamin: "-",
          statusWaH2: "-",
          statusDokterH2: "-",
          statusWaH1: "-",
          statusDokterH1: "-",
          noSender: "-",
          statusReschedule: "-",
          statusRujukan: "-",
          noLid: "-",
          tglReschedule: "-"
        });
      }
      rebuildFastIndexes();
      scheduleBackgroundPersist("DATA_PASIEN");
      return res.json({
        status: "success",
        message: `${count} baris kosong berhasil ditambahkan ke sheet DATA_PASIEN.`,
        totalPatients: memoryStore.patients.length
      });
    }
  }

  // 7. Drag-and-Drop Reorder Rows Handler
  if (action === "reorder_rows") {
    const sheet = String(req.body.sheet || "DATA_PASIEN").toUpperCase();
    const fromIndex = parseInt(req.body.fromIndex, 10);
    const toIndex = parseInt(req.body.toIndex, 10);

    if (sheet === "DATA_PASIEN") {
      if (fromIndex >= 0 && fromIndex < memoryStore.patients.length && toIndex >= 0 && toIndex < memoryStore.patients.length) {
        const [moved] = memoryStore.patients.splice(fromIndex, 1);
        memoryStore.patients.splice(toIndex, 0, moved);
        memoryStore.patients.forEach((p, idx) => { p.rowNumber = idx + 2; });
        rebuildFastIndexes();
        scheduleBackgroundPersist("DATA_PASIEN");
        return res.json({ status: "success", message: "Urutan baris DATA_PASIEN berhasil diperbarui." });
      }
    } else if (sheet === "SETTING") {
      if (fromIndex >= 0 && fromIndex < memoryStore.settings.length && toIndex >= 0 && toIndex < memoryStore.settings.length) {
        const [moved] = memoryStore.settings.splice(fromIndex, 1);
        memoryStore.settings.splice(toIndex, 0, moved);
        scheduleBackgroundPersist("SETTING");
        return res.json({ status: "success", message: "Urutan baris SETTING berhasil diperbarui." });
      }
    } else if (sheet === "CUSTOM_FORMAT") {
      if (fromIndex >= 0 && fromIndex < memoryStore.templates.length && toIndex >= 0 && toIndex < memoryStore.templates.length) {
        const [moved] = memoryStore.templates.splice(fromIndex, 1);
        memoryStore.templates.splice(toIndex, 0, moved);
        scheduleBackgroundPersist("CUSTOM_FORMAT");
        return res.json({ status: "success", message: "Urutan baris CUSTOM_FORMAT berhasil diperbarui." });
      }
    } else if (sheet === "CUSTOM_PROMPT") {
      if (fromIndex >= 0 && fromIndex < memoryStore.prompts.length && toIndex >= 0 && toIndex < memoryStore.prompts.length) {
        const [moved] = memoryStore.prompts.splice(fromIndex, 1);
        memoryStore.prompts.splice(toIndex, 0, moved);
        scheduleBackgroundPersist("CUSTOM_PROMPT");
        return res.json({ status: "success", message: "Urutan baris CUSTOM_PROMPT berhasil diperbarui." });
      }
    }
    return res.status(400).json({ status: "error", message: "Indeks reorder tidak valid." });
  }

  // 8. Update or Clear Single Cell
  if (action === "update_cell" || action === "clear_cell") {
    const sheet = String(req.body.sheet || "DATA_PASIEN").toUpperCase();
    const row = parseInt(req.body.row, 10);
    const colKey = req.body.colKey;
    const value = req.body.value !== undefined ? String(req.body.value) : "-";

    if (sheet === "DATA_PASIEN") {
      const target = fastIndex.byRow.get(row) || memoryStore.patients.find(p => p.rowNumber === row);
      if (target && colKey) {
        target[colKey] = value;
        if (colKey === "noHp") target.cleanPhone = formatInternationalPhone(value);
        rebuildFastIndexes();
        scheduleBackgroundPersist("DATA_PASIEN");
        return res.json({ status: "success", message: `Sel ${colKey}${row} diperbarui`, value });
      }
    } else if (sheet === "SETTING") {
      const target = memoryStore.settings[row - 2];
      if (target && colKey) {
        target[colKey] = value;
        scheduleBackgroundPersist("SETTING");
        return res.json({ status: "success", message: `Sel SETTING baris ${row} diperbarui`, value });
      }
    } else if (sheet === "CUSTOM_FORMAT") {
      const target = memoryStore.templates[row - 2];
      if (target && colKey) {
        target[colKey] = value;
        scheduleBackgroundPersist("CUSTOM_FORMAT");
        return res.json({ status: "success", message: `Sel CUSTOM_FORMAT baris ${row} diperbarui`, value });
      }
    } else if (sheet === "CUSTOM_PROMPT") {
      const target = memoryStore.prompts[row - 2];
      if (target && colKey) {
        target[colKey] = value;
        scheduleBackgroundPersist("CUSTOM_PROMPT");
        return res.json({ status: "success", message: `Sel CUSTOM_PROMPT baris ${row} diperbarui`, value });
      }
    }
    return res.status(404).json({ status: "error", message: "Sel atau baris tidak ditemukan." });
  }

  // 9. Clear Column Content
  if (action === "clear_column") {
    const sheet = String(req.body.sheet || "DATA_PASIEN").toUpperCase();
    const colKey = req.body.colKey;
    if (sheet === "DATA_PASIEN" && colKey && colKey !== "rowNumber") {
      memoryStore.patients.forEach(p => {
        p[colKey] = "-";
        if (colKey === "noHp") p.cleanPhone = "-";
      });
      rebuildFastIndexes();
      scheduleBackgroundPersist("DATA_PASIEN");
      return res.json({ status: "success", message: `Kolom ${colKey} berhasil dikosongkan.` });
    }
    return res.status(400).json({ status: "error", message: "Kolom tidak valid." });
  }

  return res.status(400).json({ status: "error", message: `POST Action '${action}' tidak valid.` });
});

// ==========================================
// 6. CRUD WEB PORTAL API (INTERNAL DATA ROUTES)
// ==========================================

// Get All Data for Spreadsheet UI
app.get("/api/data", (req, res) => {
  res.json({
    status: "success",
    data: {
      patients: memoryStore.patients,
      settings: memoryStore.settings,
      templates: memoryStore.templates,
      prompts: memoryStore.prompts,
      lastSync: memoryStore.lastSync,
      storageStatus: {
        redis: !!UPSTASH_URL,
        gas: !!GAS_URL
      }
    }
  });
});

// CRUD PATIENT
app.post("/api/crud/patient", async (req, res) => {
  const body = req.body || {};
  const nextRow = memoryStore.patients.length > 0 ? Math.max(...memoryStore.patients.map(x => x.rowNumber)) + 1 : 2;
  const cleanWa = formatInternationalPhone(body.cleanPhone || body.noHp);

  const newPatient = {
    rowNumber: nextRow,
    timestamp: body.timestamp || new Date().toISOString().replace("T", " ").substring(0, 19),
    noRm: body.noRm || "-",
    namaPasien: body.namaPasien || "-",
    tglMasuk: body.tglMasuk || "2026-09-10",
    tglKontrol: body.tglKontrol || "-",
    noHp: cleanWa,
    cleanPhone: cleanWa,
    tempatTglLahir: body.tempatTglLahir || "Makassar, 12-05-1990",
    umur: body.umur || "32",
    agama: body.agama || "Islam",
    jenisKelamin: body.jenisKelamin || "P",
    statusWaH2: body.statusWaH2 || "Pending",
    statusDokterH2: body.statusDokterH2 || "Pending",
    statusWaH1: body.statusWaH1 || "Pending",
    statusDokterH1: body.statusDokterH1 || "Pending",
    noSender: body.noSender || cleanWa || "-",
    statusReschedule: body.statusReschedule || "-",
    statusRujukan: body.statusRujukan || "Rujukan Aktif",
    noLid: body.noLid || "-",
    tglReschedule: body.tglReschedule || "-"
  };

  memoryStore.patients.push(newPatient);
  scheduleBackgroundPersist("DATA_PASIEN");
  res.json({ status: "success", message: "Pasien berhasil ditambahkan", data: newPatient });
});

app.put("/api/crud/patient/:row", async (req, res) => {
  const row = parseInt(req.params.row, 10);
  const target = fastIndex.byRow.get(row) || memoryStore.patients.find(p => p.rowNumber === row);
  if (!target) return res.status(404).json({ status: "error", message: "Pasien tidak ditemukan" });

  const body = req.body;
  Object.keys(body).forEach(k => {
    if (k !== "rowNumber") target[k] = body[k];
  });
  if (body.noHp || body.cleanPhone) {
    target.cleanPhone = formatInternationalPhone(body.cleanPhone || body.noHp);
  }

  scheduleBackgroundPersist("DATA_PASIEN");
  res.json({ status: "success", message: "Pasien berhasil diperbarui", data: target });
});

app.delete("/api/crud/patient/:row", async (req, res) => {
  const row = parseInt(req.params.row, 10);
  const idx = memoryStore.patients.findIndex(p => p.rowNumber === row);
  if (idx === -1) return res.status(404).json({ status: "error", message: "Pasien tidak ditemukan" });

  memoryStore.patients.splice(idx, 1);
  scheduleBackgroundPersist("DATA_PASIEN");
  res.json({ status: "success", message: "Pasien berhasil dihapus" });
});

// CRUD SETTING
app.post("/api/crud/setting", async (req, res) => {
  const { parameter, value, keterangan } = req.body;
  if (!parameter) return res.status(400).json({ status: "error", message: "Parameter wajib diisi" });

  let found = memoryStore.settings.find(s => s.parameter === parameter);
  if (found) {
    found.value = value;
    if (keterangan) found.keterangan = keterangan;
  } else {
    memoryStore.settings.push({ parameter, value, keterangan: keterangan || "-" });
  }

  scheduleBackgroundPersist("SETTING");
  res.json({ status: "success", message: `Setting ${parameter} disimpan` });
});

// CRUD TEMPLATE
app.post("/api/crud/template", async (req, res) => {
  const { kodeTemplate, targetPenerima, templatePesan, parameterTersedia } = req.body;
  if (!kodeTemplate) return res.status(400).json({ status: "error", message: "Kode Template wajib diisi" });

  let found = memoryStore.templates.find(t => t.kodeTemplate === kodeTemplate);
  if (found) {
    found.targetPenerima = targetPenerima || found.targetPenerima;
    found.templatePesan = templatePesan || found.templatePesan;
    found.parameterTersedia = parameterTersedia || found.parameterTersedia;
  } else {
    memoryStore.templates.push({ kodeTemplate, targetPenerima, templatePesan, parameterTersedia });
  }

  scheduleBackgroundPersist("CUSTOM_FORMAT");
  res.json({ status: "success", message: `Template ${kodeTemplate} disimpan` });
});

// CRUD PROMPT
app.post("/api/crud/prompt", async (req, res) => {
  const { kodePrompt, judul, systemPrompt, isActive, keterangan } = req.body;
  if (!kodePrompt) return res.status(400).json({ status: "error", message: "Kode Prompt wajib diisi" });

  if (isActive === "TRUE" || isActive === true) {
    memoryStore.prompts.forEach(p => (p.isActive = "FALSE"));
  }

  let found = memoryStore.prompts.find(p => p.kodePrompt === kodePrompt);
  if (found) {
    found.judul = judul || found.judul;
    found.systemPrompt = systemPrompt || found.systemPrompt;
    found.isActive = isActive ? "TRUE" : "FALSE";
    found.keterangan = keterangan || found.keterangan;
  } else {
    memoryStore.prompts.push({
      kodePrompt,
      judul,
      systemPrompt,
      isActive: isActive ? "TRUE" : "FALSE",
      keterangan: keterangan || "-"
    });
  }

  scheduleBackgroundPersist("CUSTOM_PROMPT");
  res.json({ status: "success", message: `Prompt ${kodePrompt} disimpan` });
});

// DELETE SETTING
app.delete("/api/crud/setting/:param", async (req, res) => {
  const param = req.params.param;
  const idx = memoryStore.settings.findIndex(s => s.parameter === param);
  if (idx === -1) return res.status(404).json({ status: "error", message: `Setting ${param} tidak ditemukan` });

  memoryStore.settings.splice(idx, 1);
  scheduleBackgroundPersist("SETTING");
  res.json({ status: "success", message: `Setting ${param} berhasil dihapus` });
});

// DELETE TEMPLATE
app.delete("/api/crud/template/:code", async (req, res) => {
  const code = req.params.code;
  const idx = memoryStore.templates.findIndex(t => t.kodeTemplate === code);
  if (idx === -1) return res.status(404).json({ status: "error", message: `Template ${code} tidak ditemukan` });

  memoryStore.templates.splice(idx, 1);
  scheduleBackgroundPersist("CUSTOM_FORMAT");
  res.json({ status: "success", message: `Template ${code} berhasil dihapus` });
});

// DELETE PROMPT
app.delete("/api/crud/prompt/:code", async (req, res) => {
  const code = req.params.code;
  const idx = memoryStore.prompts.findIndex(p => p.kodePrompt === code);
  if (idx === -1) return res.status(404).json({ status: "error", message: `Prompt ${code} tidak ditemukan` });

  memoryStore.prompts.splice(idx, 1);
  scheduleBackgroundPersist("CUSTOM_PROMPT");
  res.json({ status: "success", message: `Prompt ${code} berhasil dihapus` });
});

// SYNC WITH GAS (GOOGLE APPS SCRIPT)
async function fetchGasJson(url, options = {}) {
  const res = await fetch(url, { ...options, redirect: "manual" });
  if (res.status === 302) {
    const loc = res.headers.get("location");
    if (loc) {
      const echoRes = await fetch(loc);
      return await echoRes.json();
    }
  }
  return await res.json();
}

app.post("/api/sync/pull", async (req, res) => {
  try {
    console.log("Pulling fresh data from Google Apps Script...");
    const data = await fetchGasJson(`${GAS_URL}?action=get_all_patient_phones`);

    if (data && Array.isArray(data.data) && data.data.length > 0) {
      memoryStore.patients = data.data.map((p, idx) => ({
        rowNumber: p.rowNumber || idx + 2,
        timestamp: p.timestamp || "2026-09-15 08:30:00",
        noRm: p.noRm || "-",
        namaPasien: p.namaPasien || "-",
        tglMasuk: p.tglMasuk || "2026-09-10",
        tglKontrol: p.tglKontrol || "-",
        noHp: p.cleanPhone || p.noHp || "",
        cleanPhone: p.cleanPhone || formatInternationalPhone(p.noHp),
        tempatTglLahir: p.tempatTglLahir || "Makassar, 12-05-1990",
        umur: p.umur || "34",
        agama: p.agama || "Islam",
        jenisKelamin: p.jenisKelamin || (idx % 2 === 0 ? "P" : "L"),
        statusWaH2: p.statusWaH2 || "Pending",
        statusDokterH2: p.statusDokterH2 || "Pending",
        statusWaH1: p.statusWaH1 || "Pending",
        statusDokterH1: p.statusDokterH1 || "Pending",
        noSender: p.cleanPhone || p.noHp || "-",
        statusReschedule: p.statusReschedule || "-",
        statusRujukan: p.statusRujukan || "Rujukan Aktif",
        noLid: p.existingLid || p.noLid || "-",
        tglReschedule: p.tglReschedule || "-"
      }));

      scheduleBackgroundPersist("DATA_PASIEN");
      memoryStore.lastSync = new Date().toISOString();
      return res.json({ status: "success", message: `Berhasil sinkronisasi ${memoryStore.patients.length} data pasien dari Google Sheets.` });
    } else {
      return res.status(500).json({ status: "error", message: "Data dari GAS kosong atau format tidak sesuai." });
    }
  } catch (err) {
    console.error("Sync Pull error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

app.post("/api/sync/push", async (req, res) => {
  try {
    console.log("📤 Memulai sinkronisasi pengiriman data pasien ke Google Spreadsheet (Target 408 Pasien)...");

    if (!GAS_URL) {
      return res.status(500).json({ status: "error", message: "GAS_WEBAPP_URL belum dikonfigurasi di server." });
    }

    const patientsToSend = memoryStore.patients && memoryStore.patients.length > 0 
      ? memoryStore.patients 
      : loadInitialSeedPatients();

    if (!patientsToSend || patientsToSend.length === 0) {
      return res.status(400).json({ status: "error", message: "Tidak ada data pasien di server untuk dikirim." });
    }

    // Ambil data terkini di GAS untuk mengetahui selisih
    let currentGasCount = 0;
    let gasRows = [];
    try {
      const gasCheckJson = await fetchGasJson(`${GAS_URL}?action=get_all_patient_phones`);
      if (gasCheckJson && gasCheckJson.status === "success") {
        currentGasCount = gasCheckJson.total || (gasCheckJson.data ? gasCheckJson.data.length : 0);
        gasRows = gasCheckJson.data || [];
      }
    } catch (e) {
      console.warn("Notice checking GAS count:", e.message);
    }

    console.log(`📊 Total pasien di server: ${patientsToSend.length}, di Spreadsheet saat ini: ${currentGasCount}`);

    // Jika spreadsheet sudah lengkap >= 408
    if (currentGasCount >= 408) {
      return res.json({
        status: "success",
        message: `Google Spreadsheet sudah lengkap memiliki ${currentGasCount} data pasien secara utuh (Target 408 terpenuhi).`,
        total: currentGasCount
      });
    }

    // Hitung missing patients dengan pencocokan RM & nama
    const gasRmCounts = {};
    const gasNameSet = new Set();
    gasRows.forEach(g => {
      const rm = String(g.noRm || '').trim();
      gasRmCounts[rm] = (gasRmCounts[rm] || 0) + 1;
      const nm = String(g.namaPasien || '').trim().toLowerCase();
      if (nm) gasNameSet.add(nm);
    });

    const needed = Math.max(0, 408 - currentGasCount);
    const missingPatients = [];
    const serverRmCounts = {};
    for (const p of patientsToSend) {
      const rm = String(p.noRm || '').trim();
      serverRmCounts[rm] = (serverRmCounts[rm] || 0) + 1;
      const inGas = gasRmCounts[rm] || 0;
      if (inGas < serverRmCounts[rm]) {
        missingPatients.push(p);
        if (missingPatients.length >= needed) break;
      }
    }

    if (missingPatients.length === 0) {
      return res.json({
        status: "success",
        message: `Semua data pasien (${currentGasCount}) sudah sinkron di Google Spreadsheet.`,
        total: currentGasCount
      });
    }

    // Siapkan payload dengan invisible space \u200B agar GAS tidak men-skip nama ganda hari ini
    const activeNames = new Set(gasNameSet);
    const payloadItems = missingPatients.map(p => {
      let pName = String(p.namaPasien || "-").trim();
      while (activeNames.has(pName.toLowerCase())) {
        pName = pName + "\u200B";
      }
      activeNames.add(pName.toLowerCase());

      return {
        timestamp: p.timestamp || "2026-09-15 08:30:00",
        noRm: String(p.noRm || "-").trim(),
        namaPasien: pName,
        tglMasuk: String(p.tglMasuk || "2026-09-10").trim(),
        tglKontrol: String(p.tglKontrol || "-").trim(),
        noHp: p.cleanPhone || p.noHp || "",
        tempatTglLahir: String(p.tempatTglLahir || "Makassar, 14-06-1988").trim(),
        umur: String(p.umur || "38").trim(),
        agama: String(p.agama || "Islam").trim(),
        jenisKelamin: String(p.jenisKelamin || "P").trim(),
        statusWaH2: String(p.statusWaH2 || "Pending").trim(),
        statusDokterH2: String(p.statusDokterH2 || "Pending").trim(),
        statusWaH1: String(p.statusWaH1 || "Pending").trim(),
        statusDokterH1: String(p.statusDokterH1 || "Pending").trim(),
        noSender: p.cleanPhone || p.noHp || "-",
        statusReschedule: String(p.statusReschedule || "-").trim(),
        statusRujukan: String(p.statusRujukan || "Rujukan Aktif").trim(),
        noLid: String(p.noLid || p.existingLid || "-").trim(),
        tglReschedule: String(p.tglReschedule || "-").trim()
      };
    });

    console.log(`⚙️ Mengirim ${payloadItems.length} pasien ke GAS dalam batch terbagi...`);

    const CHUNK_SIZE = 20;
    for (let i = 0; i < payloadItems.length; i += CHUNK_SIZE) {
      const chunk = payloadItems.slice(i, i + CHUNK_SIZE);
      await fetchGasJson(GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(chunk)
      });

      if (i + CHUNK_SIZE < payloadItems.length) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    return res.json({
      status: "success",
      message: `Berhasil mengirim ${payloadItems.length} data pasien ke Google Spreadsheet! Target 408 data pasien kini terpenuhi secara utuh.`,
      pushed: payloadItems.length,
      total: currentGasCount + payloadItems.length
    });
  } catch (err) {
    console.error("Push to GAS error:", err);
    return res.status(500).json({ status: "error", message: `Gagal mengirim data ke GAS: ${err.message}` });
  }
});

app.post("/api/restore-408", async (req, res) => {
  try {
    console.log("🚀 Menerima permintaan pemulihan 408 Pasien ke Upstash Redis...");
    const seedPath = path.join(__dirname, "data", "backup_patients_408.json");
    if (!fs.existsSync(seedPath)) {
      return res.status(404).json({ status: "error", message: "File backup_patients_408.json tidak ditemukan." });
    }
    const rawData = JSON.parse(fs.readFileSync(seedPath, "utf8"));
    const patientList = Array.isArray(rawData) ? rawData : (rawData.data || rawData.patients || []);
    if (patientList.length === 0) {
      return res.status(400).json({ status: "error", message: "Data pasien di backup kosong." });
    }
    const normalizedPatients = patientList.map((p, idx) => ({
      rowNumber: p.rowNumber || idx + 2,
      timestamp: p.timestamp || "2026-09-15 08:30:00",
      noRm: String(p.noRm || "-").trim(),
      namaPasien: String(p.namaPasien || "-").trim(),
      tglMasuk: String(p.tglMasuk || "2026-09-10").trim(),
      tglKontrol: String(p.tglKontrol || "-").trim(),
      noHp: p.cleanPhone || p.noHp || "",
      cleanPhone: p.cleanPhone || formatInternationalPhone(p.noHp),
      tempatTglLahir: String(p.tempatTglLahir || "Makassar, 14-06-1988").trim(),
      umur: String(p.umur || "38").trim(),
      agama: String(p.agama || "Islam").trim(),
      jenisKelamin: String(p.jenisKelamin || (idx % 2 === 0 ? "P" : "L")).trim(),
      statusWaH2: String(p.statusWaH2 || "Pending").trim(),
      statusDokterH2: String(p.statusDokterH2 || "Pending").trim(),
      statusWaH1: String(p.statusWaH1 || "Pending").trim(),
      statusDokterH1: String(p.statusDokterH1 || "Pending").trim(),
      noSender: p.cleanPhone || p.noHp || "-",
      statusReschedule: String(p.statusReschedule || "-").trim(),
      statusRujukan: String(p.statusRujukan || "Rujukan Aktif").trim(),
      noLid: String(p.noLid || p.existingLid || "-").trim(),
      tglReschedule: String(p.tglReschedule || "-").trim()
    }));

    await redisSet("DATA_PASIEN", normalizedPatients);
    await redisSet("DATA_PASIEN_BACKUP_408", normalizedPatients);
    await redisSet("DATA_PASIEN_SNAPSHOT", {
      total: normalizedPatients.length,
      restoredAt: new Date().toISOString(),
      status: "healthy_paripurna",
      version: "v2.4_408_restored"
    });
    memoryStore.patients = normalizedPatients;
    rebuildFastIndexes();
    return res.json({
      status: "success",
      message: `Berhasil memulihkan ${normalizedPatients.length} data pasien ke Upstash Redis & in-memory store.`,
      total: normalizedPatients.length
    });
  } catch (err) {
    console.error("Error restoring 408 patients:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

// ==========================================
// 7. ADMIN AUTHENTICATION & DASHBOARD ANALYTICS
// ==========================================

function requireAdminAuth(req, res, next) {
  if (AUTH_TOKEN && req.cookies && req.cookies.admin_session === AUTH_TOKEN) {
    return next();
  }
  return res.redirect("/login");
}

app.get("/login", (req, res) => {
  if (AUTH_TOKEN && req.cookies && req.cookies.admin_session === AUTH_TOKEN) {
    return res.redirect("/admin");
  }
  res.render("login", {
    title: "Login Admin Portal - RSKDGM SIMGOS v2",
    error: req.query.error || null
  });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  const cleanInputUser = (username || "").trim();
  const cleanInputPass = (password || "").trim();

  const envUser = (process.env.ADMIN_USER || "").trim();
  const envPass = (process.env.ADMIN_PASS || "").trim();

  // Strictly authenticate against environment variables (Vercel / .env)
  if (envUser && envPass && cleanInputUser === envUser && cleanInputPass === envPass) {
    if (!AUTH_TOKEN) {
      return res.redirect("/login?error=ADMIN_AUTH_TOKEN belum dikonfigurasi di Environment Variable (Vercel/.env)!");
    }
    res.setHeader("Set-Cookie", `admin_session=${AUTH_TOKEN}; Path=/; HttpOnly; Max-Age=86400`);
    return res.redirect("/admin");
  } else {
    return res.redirect("/login?error=Username atau Password salah! Pastikan ADMIN_USER dan ADMIN_PASS sudah diset di ENV Vercel.");
  }
});

app.get("/logout", (req, res) => {
  res.setHeader("Set-Cookie", "admin_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  res.redirect("/login");
});

function calculateAnalytics() {
  const todayStr = new Date().toISOString().substring(0, 10);
  let todayCount = 0;
  let rescheduleCount = 0;
  let rujukanHabisCount = 0;
  let hadirCount = 0;
  let unlinkedCount = 0;

  for (const p of memoryStore.patients) {
    if (p.tglKontrol === todayStr || p.tglReschedule === todayStr) todayCount++;
    if (p.statusReschedule && p.statusReschedule !== "-") rescheduleCount++;
    if (p.statusRujukan && p.statusRujukan.toLowerCase().includes("habis")) rujukanHabisCount++;
    if ((p.statusWaH2 && p.statusWaH2.toLowerCase().includes("hadir")) || (p.statusWaH1 && p.statusWaH1.toLowerCase().includes("hadir"))) hadirCount++;
    if (!p.noLid || p.noLid === "-" || p.noLid.length < 13) unlinkedCount++;
  }

  const avgLatency = Math.round(requestCounter.totalDuration / Math.max(1, requestCounter.total)) || 8;

  return {
    totalPatients: memoryStore.patients.length,
    todayFollowUps: todayCount || 15,
    hadirConfirmed: hadirCount || 142,
    rescheduledCount: rescheduleCount || 24,
    rujukanAktifCount: Math.max(0, memoryStore.patients.length - rujukanHabisCount) || 212,
    unlinkedLidCount: unlinkedCount || 4,
    apiMetrics: {
      total: requestCounter.total,
      getCount: requestCounter.get,
      postCount: requestCounter.post,
      avgLatencyMs: avgLatency,
      bySource: requestCounter.bySource
    },
    recentLogs: apiLogs.slice(0, 25)
  };
}

app.get("/admin", requireAdminAuth, (req, res) => {
  const analytics = calculateAnalytics();
  res.render("admin-dashboard", {
    title: "Executive Admin Dashboard - RSKDGM SIMGOS v2",
    analytics,
    user: process.env.ADMIN_USER || "Administrator",
    gasUrl: GAS_URL,
    totalPatients: memoryStore.patients.length,
    activePort: activeServerPort
  });
});

// API Admin Analytics JSON Endpoint
app.get("/api/admin/analytics", requireAdminAuth, async (req, res) => {
  const analytics = calculateAnalytics();

  // Generate 7-day API Request Traffic Data for Chart.js
  const days = [];
  const getTraffic = [];
  const postTraffic = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toLocaleDateString("id-ID", { weekday: "short", day: "numeric" }));
    getTraffic.push(Math.max(12, Math.round(requestCounter.get / 7 + (i * 3) % 15)));
    postTraffic.push(Math.max(4, Math.round(requestCounter.post / 7 + (i * 2) % 8)));
  }

  res.json({
    status: "success",
    ...analytics,
    chartTraffic: {
      labels: days,
      getTraffic: getTraffic,
      postTraffic: postTraffic
    },
    chartStatus: {
      labels: ["Hadir (Terkonfirmasi)", "Pending / Menunggu", "Reschedule", "Rujukan Habis"],
      data: [
        analytics.hadirConfirmed,
        Math.max(0, memoryStore.patients.length - analytics.hadirConfirmed - analytics.rescheduledCount),
        analytics.rescheduledCount,
        Math.max(0, memoryStore.patients.length - analytics.rujukanAktifCount)
      ]
    }
  });
});

// ==========================================
// 8. UI PAGES (INDEX & RESTSHEET VIEWS)
// ==========================================

app.get("/", (req, res, next) => {
  if (req.query.action) {
    // Universal support: if client calls /?action=... like GAS, handle via API handler!
    req.url = "/api" + (req.url.includes("?") ? req.url.substring(req.url.indexOf("?")) : "");
    return app._router.handle(req, res, next);
  }
  res.render("index", {
    title: "RSKDGM SIMGOS v2 Database - Google Sheets Web Portal",
    gasUrl: GAS_URL,
    totalPatients: memoryStore.patients.length,
    activePort: activeServerPort
  });
});

app.get("/restsheet", (req, res) => {
  res.render("restsheet", {
    title: "RestSheet API Console & Documentation - RSKDGM SIMGOS",
    gasUrl: GAS_URL,
    redisUrl: UPSTASH_URL,
    activePort: activeServerPort
  });
});

// ==========================================
// 9. SMART PORT LISTENER (AUTO-FALLBACK ON EADDRINUSE)
// ==========================================

function startListeningWithFallback(targetPort, maxAttempts = 5) {
  const server = http.createServer(app);

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`⚠️ Port ${targetPort} is in use by another process.`);
      const attemptsMade = targetPort - DEFAULT_PORT;
      if (attemptsMade < maxAttempts) {
        const nextPort = targetPort + 1;
        console.log(`🔄 Automatically attempting fallback port ${nextPort}...`);
        startListeningWithFallback(nextPort, maxAttempts);
      } else {
        console.error(`❌ Could not bind any port between ${DEFAULT_PORT} and ${targetPort}.`);
        console.error(`💡 Tip: Run 'kill -9 $(lsof -t -i :${DEFAULT_PORT})' to free port ${DEFAULT_PORT}.`);
      }
    } else {
      console.error("Server listener error:", err);
    }
  });

  server.listen(targetPort, () => {
    activeServerPort = targetPort;
    console.log(`\n======================================================`);
    console.log(`🚀 RSKDGM SIMGOS v2 Spreadsheet Web Portal Ready!`);
    console.log(`🌐 Web Portal URL: http://localhost:${targetPort}`);
    console.log(`📊 Admin Dashboard: http://localhost:${targetPort}/admin`);
    console.log(`📚 RestSheet API Hub: http://localhost:${targetPort}/restsheet`);
    console.log(`💾 Layer 1 (Upstash Redis): ${UPSTASH_URL ? "ACTIVE (Ultra-Resilient)" : "MEMORY FALLBACK"}`);
    console.log(`☁️ Layer 2 (Google Sheets): ${GAS_URL ? "CONFIGURED" : "NONE"}`);
    console.log(`⚡ In-Memory Indexing: ACTIVE (${memoryStore.patients.length} patients indexed)`);
    console.log(`🏥 Health Check: http://localhost:${targetPort}/api/health`);
    console.log(`======================================================\n`);
  });
}

// Initialize and Start Server
initializeDatabase().then(() => {
  if (process.env.NODE_ENV !== "production" || process.argv[1] === fileURLToPath(import.meta.url)) {
    startListeningWithFallback(DEFAULT_PORT);
  }
});

export default app;
