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
// HELPER: Mapping Nama Folder (FIX SPASI INDONESIA)
// ---------------------------------------------------------
const getBoxName = (provider, folderType) => {
  if (!folderType) return "INBOX";

  // Jika user mengirim Path Lengkap (misal: "[Gmail]/Tong Sampah"), langsung pakai.
  // PENTING: Pastikan spasi di URL di-encode (%20)
  if (folderType.includes("/") || folderType.includes("[")) {
    return folderType;
  }

  const type = folderType.toLowerCase().trim(); // Trim spasi tidak sengaja

  if (provider === "gmail") {
    switch (type) {
      // --- INGGRIS ---
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

      // --- INDONESIA (Fix Spasi) ---
      case "draf":
        return "[Gmail]/Draf";
      case "terkirim":
        return "[Gmail]/Surat Terkirim";
      case "surat terkirim":
        return "[Gmail]/Surat Terkirim"; // Tambahan
      case "berbintang":
        return "[Gmail]/Berbintang";
      case "penting":
        return "[Gmail]/Penting";
      case "sampah":
        return "[Gmail]/Tong Sampah";
      case "tong sampah":
        return "[Gmail]/Tong Sampah"; // Tambahan Penting!
      case "semua email":
        return "[Gmail]/Semua Email"; // Tambahan

      // --- KATEGORI ---
      case "social":
        return "Category/Social";
      case "promotions":
        return "Category/Promotions";

      // Fallback: Jika tidak ada di list, kembalikan apa adanya (Case Sensitive)
      // Ini agar folder custom user (misal "Project A") tetap bisa dibuka
      default:
        return folderType;
    }
  } else {
    // Provider lain
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
      return res.status(200).json({
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
// ROUTE: GET EMAIL DETAIL (Attachments & Replies Fix)
// ---------------------------------------------------------
router.get("/message-detail", verifyToken, async (req, res) => {
  let connection;
  try {
    const { emailAccount, folder, uid } = req.query; 
    const userId = req.user.email;

    // --- TOKEN INJECTION ---
    const authHeader = req.headers.authorization;
    const rawToken = authHeader ? authHeader.split(" ")[1] : "";

    if (!emailAccount || !uid) return res.status(400).json({ message: "Email Account dan UID diperlukan" });

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

    const searchCriteria = [['UID', uid]];
    const metaFetchOptions = { 
        bodies: ['HEADER'], 
        struct: true, 
        markSeen: true 
    };

    const metaMessages = await connection.search(searchCriteria, metaFetchOptions);
    if (metaMessages.length === 0) {
        connection.end();
        return res.status(404).json({ message: "Email tidak ditemukan." });
    }

    const item = metaMessages[0];
    const struct = item.attributes.struct;
    const headerPart = item.parts.find(p => p.which === 'HEADER');
    
    const subject = headerPart.body.subject ? headerPart.body.subject[0] : "(No Subject)";
    const from = headerPart.body.from ? headerPart.body.from[0] : "Unknown";
    const to = headerPart.body.to ? headerPart.body.to[0] : "Me";
    const date = headerPart.body.date ? headerPart.body.date[0] : "";
    
    // 2. Logic Attachment (PREVIEW & DOWNLOAD)
    let attachments = [];
    const findAttachments = (node, partId) => {
        if (Array.isArray(node)) {
            node.forEach((child, idx) => findAttachments(child, partId ? `${partId}.${idx+1}` : `${idx+1}`));
            return;
        }
        
        const isAttachment = (node.disposition && node.disposition.type && node.disposition.type.toLowerCase() === 'attachment');
        const isFile = ['image', 'application', 'video', 'audio'].includes(node.type);
        
        if (isAttachment || (isFile && node.type !== 'text')) {
            const filename = node.params ? (node.params.name || node.params.fileName) : 'Unknown File';
            
            // BASE URL Attachment
            const baseUrl = `https://api-y4ntpb3uvq-et.a.run.app/api/inbox/attachment?emailAccount=${encodeURIComponent(emailAccount)}&folder=${encodeURIComponent(folder || boxName)}&uid=${uid}&partId=${partId || '1'}&filename=${encodeURIComponent(filename)}&userId=${encodeURIComponent(userId)}`;

            // Download Link (Force Download)
            const downloadUrl = baseUrl;
            
            // Preview Link (Open in Browser) - Tambah &mode=preview
            const previewUrl = `${baseUrl}&mode=preview`;

            attachments.push({
                filename: filename,
                contentType: node.type + '/' + node.subtype,
                size: node.size,
                partId: partId,
                downloadUrl: downloadUrl,
                previewUrl: previewUrl // URL baru buat di-klik 'View'
            });
        }
        if (node.parts) {
            findAttachments(node.parts, partId);
        }
    };
    if (struct) {
        if (Array.isArray(struct)) struct.forEach((child, idx) => findAttachments(child, `${idx+1}`));
        else findAttachments(struct, '1');
    }

    // 3. Logic Threading
    let replies = [];
    if (accData.provider === 'gmail' && item.attributes['x-gm-thrid']) {
        const threadId = item.attributes['x-gm-thrid'];
        try {
            const currentBoxMessages = await connection.search([['X-GM-THRID', threadId]], { 
                bodies: ['HEADER.FIELDS (FROM SUBJECT DATE)'], 
                struct: false
            });
            
            const inboxReplies = currentBoxMessages.map(tm => {
                const tmHeader = tm.parts.find(p => p.which === 'HEADER.FIELDS (FROM SUBJECT DATE)')?.body;
                return {
                    id: tm.attributes.uid,
                    folder: boxName,
                    from: tmHeader?.from ? tmHeader.from[0] : "Unknown",
                    subject: tmHeader?.subject ? tmHeader.subject[0] : "(No Subject)",
                    date: tmHeader?.date ? tmHeader.date[0] : "",
                    isCurrent: tm.attributes.uid == uid 
                };
            });
            
            replies = [...inboxReplies];

            const sentCandidates = ["[Gmail]/Sent Mail", "[Gmail]/Surat Terkirim", "[Gmail]/Terkirim", "Sent Items", "Sent"];
            const candidatesToTry = sentCandidates.filter(c => c !== boxName);
            
            let sentBoxFound = false;
            let sentBoxMessages = [];
            let activeSentFolderName = "";

            for (const candidate of candidatesToTry) {
                if (sentBoxFound) break;
                try {
                    await connection.openBox(candidate);
                    sentBoxMessages = await connection.search([['X-GM-THRID', threadId]], { 
                        bodies: ['HEADER.FIELDS (FROM SUBJECT DATE)'], 
                        struct: false
                    });
                    sentBoxFound = true;
                    activeSentFolderName = candidate;
                } catch (e) {}
            }

            if (sentBoxFound) {
                const sentReplies = sentBoxMessages.map(tm => {
                    const tmHeader = tm.parts.find(p => p.which === 'HEADER.FIELDS (FROM SUBJECT DATE)')?.body;
                    return {
                        id: tm.attributes.uid,
                        folder: activeSentFolderName, 
                        from: tmHeader?.from ? tmHeader.from[0] : "Unknown",
                        subject: tmHeader?.subject ? tmHeader.subject[0] : "(No Subject)",
                        date: tmHeader?.date ? tmHeader.date[0] : "",
                        isCurrent: false 
                    };
                });
                replies = [...replies, ...sentReplies];
            }
            replies.sort((a, b) => new Date(a.date) - new Date(b.date));
        } catch (threadErr) {}
    } else {
        replies.push({ id: item.attributes.uid, folder: boxName, from: from, subject: subject, date: date, isCurrent: true });
    }

    connection.end();

    return res.status(200).json({ 
        id: item.attributes.uid,
        subject: subject,
        from: from,
        to: to,
        date: date,
        attachments: attachments,
        replies: replies, 
        contentUrlParams: {
            emailAccount: emailAccount,
            folder: folder, 
            uid: uid
        }
    });

  } catch (error) {
    if(connection) connection.end();
    return res.status(500).json({ message: "Gagal membuka email", error: error.message });
  }
});

// ---------------------------------------------------------
// ROUTE: DOWNLOAD ATTACHMENT (PUBLIC / NO AUTH)
// Updated with PREVIEW Support (mode=preview)
// ---------------------------------------------------------
router.get("/attachment", async (req, res) => {
  let connection;
  try {
      const { emailAccount, folder, uid, partId, filename, userId, mode } = req.query;

      // Validasi minimal
      if (!userId) return res.status(400).send("Unauthorized Access: Missing User Identity");
      if (!partId) return res.status(400).send("Part ID missing");

      const connResult = await connectToImap(userId, emailAccount);
      connection = connResult.connection;
      const accData = connResult.accData;

      let boxName = getBoxName(accData.provider, folder);
      try { await connection.openBox(boxName || "INBOX"); } 
      catch (e) { await connection.openBox("INBOX"); }

      let fileBuffer;
      let mimeType = 'application/octet-stream';

      // STRATEGI 1: Coba ambil Part ID Spesifik (Cepat)
      try {
          console.log(`Attachment: Attempting fetch specific part ${partId}`);
          const searchCriteria = [['UID', uid]];
          const fetchOptions = { bodies: [partId], markSeen: false };
          const messages = await connection.search(searchCriteria, fetchOptions);
          
          if (messages.length > 0) {
              const partData = messages[0].parts.find(p => p.which === partId);
              if (partData && partData.body) {
                  const rawBody = partData.body;
                  const cleanBody = rawBody.replace(/\r?\n|\r/g, "");
                  fileBuffer = Buffer.from(cleanBody, 'base64');
              }
          }
      } catch (err) {
          console.log(`Attachment: Specific fetch failed (${err.message}). Switching to Fallback.`);
      }

      // STRATEGI 2: Fallback ke Full Message Fetch & Parse (Robust)
      if (!fileBuffer) {
          console.log("Attachment: Fetching full message for extraction...");
          const messages = await connection.search([['UID', uid]], { bodies: [''], markSeen: false });
          
          if (messages.length === 0) {
              connection.end();
              return res.status(404).send("File not found");
          }

          const rawContent = messages[0].parts.find(p => p.which === '').body;
          const parsed = await simpleParser(rawContent);
          const targetAttachment = parsed.attachments.find(att => att.filename === filename);
          
          if (targetAttachment) {
              fileBuffer = targetAttachment.content; 
              mimeType = targetAttachment.contentType || mimeType;
          }
      }

      connection.end();

      if (!fileBuffer) {
          return res.status(404).send("Attachment data not found.");
      }

      // Tentukan Content-Disposition berdasarkan MODE
      // inline = Preview di browser
      // attachment = Download paksa
      const dispositionType = mode === 'preview' ? 'inline' : 'attachment';

      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `${dispositionType}; filename="${filename || 'download'}"`);
      res.setHeader('Content-Length', fileBuffer.length);
      return res.end(fileBuffer);

  } catch (error) {
      if (connection) connection.end();
      console.error("Attachment Error:", error);
      return res.status(500).send("Gagal download attachment");
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
    } catch (e) {
      // Fallback jika folder spesifik gagal (misal nama folder beda bahasa)
      await connection.openBox("INBOX");
    }

    // 3. AMBIL SELURUH SUMBER EMAIL (RAW)
    // Gunakan bodies: [''] untuk mendapatkan header + body lengkap sekaligus
    // Ini cara 'brute force' yang paling aman untuk menghindari kesalahan parsing parsial
    const searchCriteria = [["UID", uid]];
    const fetchOptions = {
      bodies: [""],
      markSeen: true,
    };

    const messages = await connection.search(searchCriteria, fetchOptions);

    if (messages.length === 0) {
      connection.end();
      return res.status(404).send("<h3>Email tidak ditemukan</h3>");
    }

    // Ambil raw source (part '' adalah entire message)
    const rawContent = messages[0].parts.find((p) => p.which === "").body;
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
      const safeText = (parsed.text || "")
        .replace(/&/g, "&amp;")
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
