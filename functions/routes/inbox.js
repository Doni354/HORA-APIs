/* eslint-disable */
const express = require("express");
const router = express.Router();
const { db } = require("../config/firebase");
const { verifyToken } = require("../middleware/token"); // Middleware kamu yang tadi
const { encrypt, decrypt } = require("../helper/security");
const imap = require("imap-simple");
const simpleParser = require("mailparser").simpleParser;
// ---------------------------------------------------------
// ADD EMAIL ACCOUNT (Connect New Account)
// ---------------------------------------------------------
router.post("/add-account", verifyToken, async (req, res) => {
  try {
    // Data dari frontend
    const { provider, emailAddress, password, authType } = req.body;
    const userId = req.user.email; // Dari token JWT login HoraApp

    // 0. Sanitize Password (PENTING: Hapus spasi dari App Password)
    // Google ngasih "abcd efgh...", tapi IMAP butuh "abcdefgh..."
    const cleanPassword = String(password).replace(/\s+/g, "").trim();

    // Config IMAP berdasarkan Provider
    let imapConfig = {
      user: emailAddress,
      password: cleanPassword,
      host: "",
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false }, // Tambahan biar gak error sertifikat SSL
      authTimeout: 15000, // Naikkan ke 15 Detik (3 detik terlalu cepat buat Gmail)
    };

    // Tentukan Host IMAP (Bisa diperluas)
    switch (provider) {
      case "gmail":
        imapConfig.host = "imap.gmail.com";
        break;
      case "yahoo":
        imapConfig.host = "imap.mail.yahoo.com";
        break;
      case "outlook":
        imapConfig.host = "outlook.office365.com";
        break;
      case "yandex":
        imapConfig.host = "imap.yandex.com";
        break;
      case "icloud":
        imapConfig.host = "imap.mail.me.com";
        break;
      default:
        return res.status(400).json({ message: "Provider tidak didukung" });
    }

    // 1. Validasi Koneksi (Coba login ke server email)
    // Ini penting biar gak nyimpen sampah di database
    try {
      console.log(
        `Mencoba menghubungkan ${emailAddress} ke ${imapConfig.host}...`
      );
      const connection = await imap.connect({ imap: imapConfig });

      // Sukses connect, langsung tutup
      await connection.end();
      console.log("Koneksi IMAP Sukses!");
    } catch (err) {
      console.log("IMAP Error Detail:", err);
      return res.status(401).json({
        message: "Gagal login ke email. Pastikan Email & App Password benar.",
        detail:
          "Cek kembali App Password Anda. Pastikan IMAP sudah aktif di pengaturan Gmail.",
        originalError: err.message,
      });
    }

    // 2. Enkripsi Password (yang sudah bersih) sebelum simpan
    const encryptedPassword = encrypt(cleanPassword);

    // 3. Simpan ke Sub-Collection Firestore
    const accountData = {
      provider,
      email: emailAddress,
      authType: authType || "basic",
      encryptedCredentials: encryptedPassword, // Password aman di sini
      connectedAt: new Date().toISOString(),
      isActive: true,
    };

    // Gunakan emailAddress sebagai ID dokumen agar tidak duplikat
    await db
      .collection("users")
      .doc(userId)
      .collection("mail_accounts")
      .doc(emailAddress)
      .set(accountData);

    return res
      .status(200)
      .json({ message: "Akun email berhasil dihubungkan!" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server Error" });
  }
});
// ---------------------------------------------------------
// HELPER: Connection Logic
// ---------------------------------------------------------
const connectToImap = async (userId, emailAccount) => {
  const accRef = db
    .collection("users")
    .doc(userId)
    .collection("mail_accounts")
    .doc(emailAccount);
  const accDoc = await accRef.get();

  if (!accDoc.exists) throw new Error("ACCOUNT_NOT_FOUND");

  const accData = accDoc.data();

  let password;
  try {
    password = decrypt(accData.encryptedCredentials);
  } catch (e) {
    throw new Error("DECRYPT_FAILED");
  }

  if (!password) throw new Error("INVALID_PASSWORD");

  let host = "";
  if (accData.provider === "gmail") host = "imap.gmail.com";
  else if (accData.provider === "yahoo") host = "imap.mail.yahoo.com";
  else if (accData.provider === "outlook") host = "outlook.office365.com";
  else if (accData.provider === "icloud") host = "imap.mail.me.com";
  else if (accData.provider === "yandex") host = "imap.yandex.com";

  const config = {
    imap: {
      user: accData.email,
      password: password,
      host: host,
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 20000,
    },
  };

  console.log(`Connecting to ${host}...`);
  const connection = await imap.connect(config);
  return { connection, accData };
};

// ---------------------------------------------------------
// HELPER: Mapping Nama Folder
// ---------------------------------------------------------
const getBoxName = (provider, folderType) => {
  if (!folderType) return "INBOX";
  if (folderType.includes("/") || folderType.includes("[")) return folderType;

  const type = folderType.toLowerCase();

  if (provider === "gmail") {
    switch (type) {
      case "inbox":
        return "INBOX";
      case "sent":
        return "[Gmail]/Sent Mail";
      case "draft":
        return "[Gmail]/Drafts";
      case "spam":
        return "[Gmail]/Spam";
      case "trash":
        return "[Gmail]/Trash";
      case "starred":
        return "[Gmail]/Starred";
      case "important":
        return "[Gmail]/Important";
      case "all":
        return "[Gmail]/All Mail";
      case "draf":
        return "[Gmail]/Draf";
      case "terkirim":
        return "[Gmail]/Surat Terkirim";
      case "berbintang":
        return "[Gmail]/Berbintang";
      case "penting":
        return "[Gmail]/Penting";
      case "social":
        return "Category/Social";
      case "promotions":
        return "Category/Promotions";
      default:
        return folderType;
    }
  } else {
    switch (type) {
      case "sent":
        return "Sent Items";
      case "draft":
        return "Drafts";
      case "spam":
        return "Junk";
      case "trash":
        return "Trash";
      default:
        return folderType;
    }
  }
};

// ---------------------------------------------------------
// ROUTE: CEK DAFTAR FOLDER
// ---------------------------------------------------------
router.get("/folders", verifyToken, async (req, res) => {
  let connection;
  try {
    const { emailAccount } = req.query;
    const userId = req.user.email;

    if (!emailAccount)
      return res.status(400).json({ message: "Email Account diperlukan" });

    const connResult = await connectToImap(userId, emailAccount);
    connection = connResult.connection;

    const boxes = await connection.getBoxes();

    const folderList = [];
    const parseBoxes = (boxList, prefix = "") => {
      for (const key in boxList) {
        const fullPath = prefix ? prefix + key : key;
        folderList.push({
          name: key,
          path: fullPath,
          delimiter: boxList[key].delimiter,
        });
        if (boxList[key].children) {
          parseBoxes(boxList[key].children, fullPath + boxList[key].delimiter);
        }
      }
    };

    parseBoxes(boxes);
    connection.end();

    return res.status(200).json({
      provider: connResult.accData.provider,
      folders: folderList,
    });
  } catch (error) {
    if (connection) connection.end();
    return res
      .status(500)
      .json({ message: "Gagal mengambil daftar folder", error: error.message });
  }
});

// ---------------------------------------------------------
// ROUTE: GET MESSAGES LIST (Hanya Header)
// ---------------------------------------------------------
router.get("/messages", verifyToken, async (req, res) => {
  let connection;
  try {
    const { emailAccount, folder, page } = req.query;
    const userId = req.user.email;
    const pageNum = parseInt(page) || 1;

    if (!emailAccount)
      return res
        .status(400)
        .json({ message: "Email Account target diperlukan" });

    let connResult;
    try {
      connResult = await connectToImap(userId, emailAccount);
      connection = connResult.connection;
    } catch (err) {
      if (err.message === "ACCOUNT_NOT_FOUND")
        return res.status(404).json({ message: "Akun email tidak ditemukan." });
      return res
        .status(500)
        .json({ message: "Gagal login ke email.", error: err.message });
    }

    const accData = connResult.accData;
    let boxName = getBoxName(accData.provider, folder);

    let box;
    try {
      box = await connection.openBox(boxName);
    } catch (boxError) {
      console.log(`Gagal membuka box '${boxName}'. Fallback ke INBOX.`);
      boxName = "INBOX";
      box = await connection.openBox("INBOX");
    }

    const totalMessages = box.messages.total;
    const limit = 15;

    if (totalMessages === 0) {
      connection.end();
      return res
        .status(200)
        .json({
          provider: accData.provider,
          folder: boxName,
          count: 0,
          data: [],
        });
    }

    const endSeq = totalMessages - (pageNum - 1) * limit;
    const startSeq = Math.max(1, endSeq - limit + 1);

    if (endSeq < 1) {
      connection.end();
      return res.status(200).json({
        provider: accData.provider,
        folder: boxName,
        page: pageNum,
        totalInBox: totalMessages,
        data: [],
      });
    }

    const range = `${startSeq}:${endSeq}`;
    console.log(`Fetching ${boxName} page ${pageNum} (Range: ${range})`);

    const fetchOptions = {
      bodies: ["HEADER"],
      markSeen: false,
      struct: true,
    };

    const messages = await connection.search([range], fetchOptions);
    const sortedMessages = messages.sort((a, b) => b.seqno - a.seqno);

    const results = await Promise.all(
      sortedMessages.map(async (item) => {
        const id = item.attributes.uid;
        const headerPart = item.parts.find((part) => part.which === "HEADER");
        const headerBody = headerPart && headerPart.body ? headerPart.body : {};

        return {
          id: id,
          subject: headerBody.subject ? headerBody.subject[0] : "(No Subject)",
          from: headerBody.from ? headerBody.from[0] : "Unknown",
          date: headerBody.date ? headerBody.date[0] : "",
          isRead:
            item.attributes.flags && item.attributes.flags.includes("\\Seen"),
          snippet: "Tap to read...",
        };
      })
    );

    connection.end();
    return res.status(200).json({
      provider: accData.provider,
      folder: boxName,
      page: pageNum,
      totalInBox: totalMessages,
      fetchedCount: results.length,
      data: results,
    });
  } catch (error) {
    if (connection) connection.end();
    console.error("Fetch List Error:", error);
    return res
      .status(500)
      .json({ message: "Gagal mengambil list email", error: error.message });
  }
});

// ---------------------------------------------------------
// ROUTE: GET EMAIL METADATA (FAST - NO BODY)
// Dipakai untuk menampilkan info dasar sebelum WebView loading
// ---------------------------------------------------------
router.get("/message-detail", verifyToken, async (req, res) => {
  let connection;
  try {
    const { emailAccount, folder, uid } = req.query;
    const userId = req.user.email;

    if (!emailAccount || !uid)
      return res
        .status(400)
        .json({ message: "Email Account dan UID diperlukan" });

    const connResult = await connectToImap(userId, emailAccount);
    connection = connResult.connection;
    const accData = connResult.accData;

    let boxName = getBoxName(accData.provider, folder);
    try {
      await connection.openBox(boxName);
    } catch (e) {
      console.log(`Fallback box to INBOX`);
      await connection.openBox("INBOX");
    }

    // Fetch HANYA Header & Struct (Sangat Cepat)
    const searchCriteria = [["UID", uid]];
    const metaFetchOptions = {
      bodies: ["HEADER"],
      struct: true,
      markSeen: true,
    };

    const metaMessages = await connection.search(
      searchCriteria,
      metaFetchOptions
    );
    if (metaMessages.length === 0) {
      connection.end();
      return res.status(404).json({ message: "Email tidak ditemukan." });
    }

    const item = metaMessages[0];
    const struct = item.attributes.struct;
    const headerPart = item.parts.find((p) => p.which === "HEADER");

    const subject = headerPart.body.subject
      ? headerPart.body.subject[0]
      : "(No Subject)";
    const from = headerPart.body.from ? headerPart.body.from[0] : "Unknown";
    const to = headerPart.body.to ? headerPart.body.to[0] : "Me";
    const date = headerPart.body.date ? headerPart.body.date[0] : "";

    // Analisis Attachment Saja
    let attachments = [];
    const findAttachments = (node) => {
      if (Array.isArray(node)) {
        node.forEach((child) => findAttachments(child));
        return;
      }
      const isAttachment =
        node.disposition &&
        node.disposition.type &&
        node.disposition.type.toLowerCase() === "attachment";
      const isFile = ["image", "application", "video", "audio"].includes(
        node.type
      );
      if (isAttachment || isFile) {
        attachments.push({
          filename: node.params
            ? node.params.name || node.params.fileName
            : "Unknown File",
          contentType: node.type + "/" + node.subtype,
          size: node.size,
        });
      }
      if (node.parts) findAttachments(node.parts);
    };
    if (struct) findAttachments(struct);

    connection.end();

    // KEMBALIKAN JSON
    // Perhatikan field 'contentUrl' -> Ini yang nanti dipanggil WebView
    // Kita asumsikan API base URL bisa disusun di Frontend
    return res.status(200).json({
      id: item.attributes.uid,
      subject: subject,
      from: from,
      to: to,
      date: date,
      attachments: attachments,
      // URL ini nanti diload oleh WebView di Flutter
      // Format URL: /api/inbox/message-body?emailAccount=...&folder=...&uid=...
      contentUrlParams: {
        emailAccount: emailAccount,
        folder: folder,
        uid: uid,
      },
    });
  } catch (error) {
    if (connection) connection.end();
    return res
      .status(500)
      .json({ message: "Gagal membuka email", error: error.message });
  }
});

// ---------------------------------------------------------
// ROUTE: GET RAW HTML CONTENT (WEBVIEW ENDPOINT)
// REVISED: FULL RAW FETCH (Metode Paling Stabil)
// Mengambil seluruh isi pesan dan membiarkan simpleParser menanganinya
// ---------------------------------------------------------
router.get("/message-body", verifyToken, async (req, res) => {
  let connection;
  try {
    const { emailAccount, folder, uid } = req.query;
    const userId = req.user.email;

    // 1. Connect
    const connResult = await connectToImap(userId, emailAccount);
    connection = connResult.connection;
    const accData = connResult.accData;
    
    // 2. Open Box
    let boxName = getBoxName(accData.provider, folder);
    try { 
        await connection.openBox(boxName || "INBOX");
    } catch(e) {
        // Fallback jika folder spesifik gagal (misal nama folder beda bahasa)
        await connection.openBox("INBOX");
    }

    // 3. AMBIL SELURUH SUMBER EMAIL (RAW)
    // Gunakan bodies: [''] untuk mendapatkan header + body lengkap sekaligus
    // Ini cara 'brute force' yang paling aman untuk menghindari kesalahan parsing parsial
    const searchCriteria = [["UID", uid]];
    const fetchOptions = {
      bodies: [''], 
      markSeen: true
    };

    const messages = await connection.search(searchCriteria, fetchOptions);

    if (messages.length === 0) {
      connection.end();
      return res.status(404).send("<h3>Email tidak ditemukan</h3>");
    }

    // Ambil raw source (part '' adalah entire message)
    const rawContent = messages[0].parts.find(p => p.which === '').body;
    connection.end();

    // 4. PARSING TOTAL DENGAN MAILPARSER
    // Ini otomatis menangani mixed, related (inline image), dan alternative
    const parsed = await simpleParser(rawContent);

    // 5. LOGIC RENDERING SEDERHANA
    let renderedContent = "";
    
    // Prioritaskan HTML, lalu Text converted to HTML, lalu Raw Text
    if (parsed.html) {
      renderedContent = parsed.html;
    } else if (parsed.textAsHtml) {
      renderedContent = parsed.textAsHtml;
    } else {
      // Escape HTML chars jika menampilkan raw text untuk keamanan
      const safeText = (parsed.text || '').replace(/&/g, "&amp;")
                                        .replace(/</g, "&lt;")
                                        .replace(/>/g, "&gt;")
                                        .replace(/"/g, "&quot;")
                                        .replace(/'/g, "&#039;");
      renderedContent = `<div style="white-space: pre-wrap;">${safeText}</div>`;
    }

    // 6. TEMPLATE OUTPUT (Styling untuk WebView)
    const pageTemplate = `
      <!DOCTYPE html>
      <html>
      <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <base target="_blank">
          <style>
              body { 
                  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
                  margin: 0; padding: 16px; line-height: 1.6; color: #202124; 
                  word-wrap: break-word;
              }
              /* Mencegah gambar melebar melebihi layar */
              img { max-width: 100% !important; height: auto !important; display: block; margin: 10px 0; }
              /* Styling Quote Reply */
              blockquote { border-left: 3px solid #ccc; margin: 10px 0; padding-left: 10px; color: #666; }
              /* Styling Code Block/Pre */
              pre { white-space: pre-wrap; word-wrap: break-word; background: #f5f5f5; padding: 10px; border-radius: 4px; }
              a { color: #1a73e8; text-decoration: none; }
          </style>
      </head>
      <body>
          ${renderedContent}
      </body>
      </html>
    `;

    res.setHeader("Content-Type", "text/html");
    return res.send(pageTemplate);

  } catch (error) {
    if (connection) connection.end();
    console.error("Render Error:", error);
    return res.status(500).send(`<h3>Error</h3><p>${error.message}</p>`);
  }
});
module.exports = router;
