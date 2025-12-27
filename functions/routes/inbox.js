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
// HELPER: Connection Logic (Agar tidak duplikat di tiap route)
// ---------------------------------------------------------
const connectToImap = async (userId, emailAccount) => {
    // 1. Ambil Kredensial
    const accRef = db.collection("users").doc(userId).collection("mail_accounts").doc(emailAccount);
    const accDoc = await accRef.get();

    if (!accDoc.exists) throw new Error("ACCOUNT_NOT_FOUND");
    
    const accData = accDoc.data();
    
    // Decrypt password
    let password;
    try {
        password = decrypt(accData.encryptedCredentials);
    } catch (e) {
        throw new Error("DECRYPT_FAILED");
    }

    if (!password) throw new Error("INVALID_PASSWORD");

    // 2. Setup Config
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
        authTimeout: 10000, 
      },
    };

    console.log(`Connecting to ${host}...`);
    const connection = await imap.connect(config);
    return { connection, accData };
};

// Helper Box Name
const getBoxName = (provider, folderType) => {
    const type = folderType ? folderType.toLowerCase() : "inbox";
    if (provider === 'gmail') {
        switch (type) {
            case "sent": return "[Gmail]/Sent Mail";
            case "draft": return "[Gmail]/Drafts";
            case "spam": return "[Gmail]/Spam";
            case "trash": return "[Gmail]/Trash";
            case "starred": return "[Gmail]/Starred";
            case "important": return "[Gmail]/Important";
            default: return "INBOX";
        }
    } else {
        // Standar IMAP
        switch (type) {
            case "sent": return "Sent Items"; 
            case "draft": return "Drafts";
            case "spam": return "Junk";
            case "trash": return "Trash";
            default: return "INBOX";
        }
    }
};

// ---------------------------------------------------------
// ROUTE 1: GET MESSAGES LIST (Pagination Supported)
// ---------------------------------------------------------
router.get("/messages", verifyToken, async (req, res) => {
  let connection;
  try {
    const { emailAccount, folder, page } = req.query; 
    const userId = req.user.email;
    const pageNum = parseInt(page) || 1; // Default page 1

    if (!emailAccount) return res.status(400).json({ message: "Email Account target diperlukan" });

    // Gunakan Helper Connection
    try {
        const connResult = await connectToImap(userId, emailAccount);
        connection = connResult.connection;
        var accData = connResult.accData;
    } catch (err) {
        if(err.message === "ACCOUNT_NOT_FOUND") return res.status(404).json({ message: "Akun email tidak ditemukan." });
        return res.status(500).json({ message: "Gagal login ke email.", error: err.message });
    }

    // Open Box
    let boxName = getBoxName(accData.provider, folder);
    let box;
    try {
        box = await connection.openBox(boxName);
    } catch (boxError) {
        console.log(`Gagal membuka box ${boxName}, fallback ke INBOX.`);
        boxName = "INBOX";
        box = await connection.openBox("INBOX");
    }

    // --- LOGIC PAGINATION ---
    const totalMessages = box.messages.total;
    const limit = 15; 

    if (totalMessages === 0) {
        connection.end();
        return res.status(200).json({ provider: accData.provider, folder: boxName, count: 0, data: [] });
    }

    // Hitung Start & End berdasarkan Page
    // Page 1: (Total) s/d (Total - 15)
    // Page 2: (Total - 15) s/d (Total - 30)
    const endSeq = totalMessages - ((pageNum - 1) * limit);
    const startSeq = Math.max(1, endSeq - limit + 1);

    // Jika user minta halaman yang sudah tidak ada isinya (misal page 999)
    if (endSeq < 1) {
        connection.end();
        return res.status(200).json({ 
            provider: accData.provider, 
            folder: boxName, 
            page: pageNum,
            totalInBox: totalMessages, 
            data: [] 
        });
    }

    const range = `${startSeq}:${endSeq}`; 
    console.log(`Fetching page ${pageNum} (Range: ${range})`);

    const fetchOptions = {
      bodies: ["HEADER", "TEXT"], 
      markSeen: false,
      struct: true
    };

    const messages = await connection.search([range], fetchOptions);
    
    // Sorting Descending (Terbaru diatas)
    const sortedMessages = messages.sort((a, b) => b.seqno - a.seqno);

    const results = await Promise.all(
        sortedMessages.map(async (item) => {
            const id = item.attributes.uid;
            const headerPart = item.parts.find((part) => part.which === "HEADER");
            const headerBody = headerPart && headerPart.body ? headerPart.body : {};

            return {
                id: id,
                seq: item.seqno, // Info sequence untuk debugging
                subject: headerBody.subject ? headerBody.subject[0] : "(No Subject)",
                from: headerBody.from ? headerBody.from[0] : "Unknown",
                date: headerBody.date ? headerBody.date[0] : "",
                isRead: item.attributes.flags && item.attributes.flags.includes("\\Seen"),
                snippet: "Tap to read..." 
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
        data: results 
    });

  } catch (error) {
    if(connection) connection.end();
    console.error("Fetch List Error:", error);
    return res.status(500).json({ message: "Gagal mengambil list email", error: error.message });
  }
});

// ---------------------------------------------------------
// ROUTE 2: GET EMAIL DETAIL (Read Full HTML)
// ---------------------------------------------------------
router.get("/message-detail", verifyToken, async (req, res) => {
    let connection;
    try {
      // Kita butuh UID untuk mengambil email spesifik
      const { emailAccount, folder, uid } = req.query; 
      const userId = req.user.email;
  
      if (!emailAccount || !uid) return res.status(400).json({ message: "Email Account dan UID diperlukan" });
  
      // Gunakan Helper Connection
      try {
          const connResult = await connectToImap(userId, emailAccount);
          connection = connResult.connection;
          var accData = connResult.accData;
      } catch (err) {
          return res.status(500).json({ message: "Gagal login ke email.", error: err.message });
      }
  
      let boxName = getBoxName(accData.provider, folder);
      
      // Buka Box (Read Write karena kita mau tandai sebagai 'Read' / Seen)
      await connection.openBox(boxName); 
  
      // Fetch Full Body (Source)
      const searchCriteria = [['UID', uid]];
      const fetchOptions = {
        bodies: [''], // Kosong berarti ambil seluruh raw source (Header + Body + HTML + Attachment)
        markSeen: true // Tandai sudah dibaca!
      };
  
      const messages = await connection.search(searchCriteria, fetchOptions);
  
      if (messages.length === 0) {
          connection.end();
          return res.status(404).json({ message: "Email tidak ditemukan (Mungkin sudah dihapus)." });
      }
  
      const item = messages[0];
      // Ambil Raw Source dari parts
      const allPart = item.parts.find((part) => part.which === "");
      
      // Parsing Raw Source menjadi HTML cantik menggunakan mailparser
      const parsed = await simpleParser(allPart.body);
  
      connection.end();

      // Return Data Bersih
      return res.status(200).json({ 
          id: item.attributes.uid,
          subject: parsed.subject,
          from: parsed.from ? parsed.from.text : "Unknown",
          to: parsed.to ? parsed.to.text : "Me",
          date: parsed.date,
          // Prioritaskan HTML, kalau gak ada pake plain text, kalau gak ada pake ashtml
          htmlContent: parsed.html || parsed.textAsHtml || parsed.text, 
          attachments: parsed.attachments.map(att => ({
              filename: att.filename,
              contentType: att.contentType,
              size: att.size,
              // Nanti attachment perlu logic download terpisah jika besar, 
              // tapi mailparser kadang ngasih buffer langsung (hati-hati memori)
              type: "attachment" 
          }))
      });
  
    } catch (error) {
      if(connection) connection.end();
      console.error("Fetch Detail Error:", error);
      return res.status(500).json({ message: "Gagal membuka email", error: error.message });
    }
  });

module.exports = router;
