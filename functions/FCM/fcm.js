/* eslint-disable */
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

// Pastikan app sudah diinisialisasi
if (admin.apps.length === 0) {
  admin.initializeApp();
}

exports.onNewCompanyMessage = onDocumentCreated(
  {
    document: "companies/{companyId}/messages/{messageId}",
    region: "asia-southeast2",
  },
  async (event) => {
    console.log("🔥 FCM Trigger Fired");

    const snap = event.data;
    if (!snap) return;

    const message = snap.data();
    const { companyId } = event.params;
    
    const authorId = message.authorId;
    const authorEmail = message.authorEmail; 
    const type = message.type;
    const textContent = message.text || ""; // Pastikan string aman

    // =====================================================
    // 1️⃣ Tentukan Title (Nama Pengirim)
    // =====================================================
    const authorName = message.authorName || "Anggota Tim";

    // =====================================================
    // 2️⃣ Persiapkan Body Dasar & Deteksi Mention
    // =====================================================
    const truncate = (str, n) => (str && str.length > n) ? str.substr(0, n - 1) + "..." : str;

    // Helper untuk cek apakah text mengandung mention @Name atau @{Name}
    const isUserMentioned = (text, userName) => {
      if (!text || !userName) return false;
      const t = text.toLowerCase();
      const u = userName.toLowerCase();
      // Cek format @{Name} atau @Name
      return t.includes(`@{${u}}`) || t.includes(`@${u}`);
    };

    // Cari tahu apakah ada orang lain yang disebut (Support format @{Name Spasi} dan @Name)
    let mentionedSomeoneElse = "";
    // Regex ini menangkap isi di dalam @{...} (Group 1) atau @Kata (Group 2)
    const mentionMatch = textContent.match(/@(?:\{([^}]+)\}|(\w+))/);
    
    if (type === "text" && mentionMatch) {
      // Ambil nama dari Group 1 (format kurung) atau Group 2 (format biasa)
      mentionedSomeoneElse = (mentionMatch[1] || mentionMatch[2] || "").trim();
    }

    // Siapkan konten pesan yang bersih (tanpa tag @User) untuk ditampilkan di notif
    let displayContent = textContent;
    if (mentionedSomeoneElse) {
      // Hapus tag mention dari teks agar notif rapi. Contoh: "@{Budi} woy" -> "woy"
      displayContent = textContent.replace(/@(?:\{[^}]+\}|[a-zA-Z0-9_]+)/, "").trim();
      // Jika pesan cuma mention doang, kasih teks default
      if (!displayContent) displayContent = "mencolek"; 
    }
    const truncatedContent = truncate(displayContent, 100);

    // =====================================================
    // 3️⃣ Ambil token & Pisahkan Group (Disebut vs General)
    // =====================================================
    const usersSnap = await admin
      .firestore()
      .collection("users")
      .where("idCompany", "==", companyId)
      .get();

    // Group 1: User yang di-mention secara spesifik ("Menyebut anda")
    const tokensMentioned = [];
    
    // Group 2: User sisanya ("Menyebut [Orang Lain]" atau pesan biasa)
    const tokensGeneral = [];

    // Map untuk cleanup (berlaku untuk semua token)
    const tokenOwnerMap = {}; 

    usersSnap.forEach((doc) => {
      const userData = doc.data();
      const docId = doc.id; // Email

      // 🛡️ FILTER PENGIRIM
      if (authorEmail && docId === authorEmail) return;
      if (docId === authorId) return;
      if (userData.uid === authorId) return;
      if (userData.email === authorEmail) return;

      const userTokens = userData.fcmTokens;
      if (!userTokens) return;

      // Logic Penentuan Group
      let targetGroup = tokensGeneral; // Default ke general

      // Hanya proses logic mention jika tipe pesan adalah text
      if (type === "text") {
        const userName = userData.name || userData.username;
        if (isUserMentioned(textContent, userName)) {
          targetGroup = tokensMentioned;
        }
      }

      const userId = docId;
      
      if (Array.isArray(userTokens)) {
        userTokens.forEach(t => {
          targetGroup.push(t);
          tokenOwnerMap[t] = userId; 
        });
      } else if (typeof userTokens === "string") {
        targetGroup.push(userTokens);
        tokenOwnerMap[userTokens] = userId;
      }
    });

    // Clean duplicate di masing-masing group
    const uniqueTokensMentioned = [...new Set(tokensMentioned)];
    const uniqueTokensGeneral = [...new Set(tokensGeneral)];

    // =====================================================
    // 4️⃣ Bangun Payload & Kirim (Ada 2 Variasi)
    // =====================================================
    
    // Base Payload Config
    const basePayload = {
      data: {
        click_action: "FLUTTER_NOTIFICATION_CLICK",
        companyId: companyId,
        messageId: snap.id,
        type: type,
        authorId: authorId,
        route: "chat_screen",
      },
      android: {
        priority: "high",
        notification: { sound: "default", channelId: "chat_messages", tag: companyId },
      },
      apns: {
        payload: { aps: { sound: "default", threadId: companyId } },
      },
    };

    const promises = [];

    // --- KIRIM BATCH 1: Ke User yang Di-Mention ---
    if (uniqueTokensMentioned.length > 0) {
      // Format: "Menyebut anda : hiii" (tag @Daffa sudah dihapus dari hiii)
      const bodyMentioned = `Menyebut anda : ${truncatedContent}`;
      
      const payloadMentioned = {
        ...basePayload,
        notification: {
          title: authorName,
          body: bodyMentioned,
        },
      };

      promises.push(
        admin.messaging().sendEachForMulticast({
          tokens: uniqueTokensMentioned,
          ...payloadMentioned,
        })
      );
    }

    // --- KIRIM BATCH 2: Ke User General (Sisanya) ---
    if (uniqueTokensGeneral.length > 0) {
      let bodyGeneral = "";

      if (type === "text") {
        if (mentionedSomeoneElse) {
          // Format: "Menyebut Daffa Rendra : hiii"
          bodyGeneral = `Menyebut ${mentionedSomeoneElse} : ${truncatedContent}`;
        } else {
          // Format biasa
          bodyGeneral = truncate(textContent, 100);
        }
      } else if (type === "custom") {
        if (message.subtype === "recording" || message.subtype === "voice") {
          bodyGeneral = "🎤 Mengirim pesan suara";
        } else {
          bodyGeneral = "✨ Mengirim pesan baru";
        }
      } else if (type === "file") {
        const mime = message.mimeType || "";
        if (mime.startsWith("image/")) {
          bodyGeneral = "📷 Mengirim foto";
        } else if (mime.startsWith("video/")) {
          bodyGeneral = "🎥 Mengirim video";
        } else {
          const fileName = message.fileName || "dokumen";
          bodyGeneral = `📄 Mengirim file: ${truncate(fileName, 20)}`;
        }
      } else {
        bodyGeneral = "📩 Mengirim pesan";
      }

      const payloadGeneral = {
        ...basePayload,
        notification: {
          title: authorName,
          body: bodyGeneral,
        },
      };

      promises.push(
        admin.messaging().sendEachForMulticast({
          tokens: uniqueTokensGeneral,
          ...payloadGeneral,
        })
      );
    }

    // =====================================================
    // 5️⃣ Eksekusi & Cleanup
    // =====================================================
    if (promises.length === 0) return;

    try {
      const results = await Promise.all(promises);
      
      // Gabungkan hasil dari kedua batch (jika ada) untuk cleanup
      let allResponses = [];
      let allTokens = [];

      // Mapping hasil batch 1
      if (uniqueTokensMentioned.length > 0 && results[0]) {
        allResponses = allResponses.concat(results[0].responses);
        allTokens = allTokens.concat(uniqueTokensMentioned);
      }

      // Mapping hasil batch 2
      const generalResultIndex = uniqueTokensMentioned.length > 0 ? 1 : 0;
      if (uniqueTokensGeneral.length > 0 && results[generalResultIndex]) {
        allResponses = allResponses.concat(results[generalResultIndex].responses);
        allTokens = allTokens.concat(uniqueTokensGeneral);
      }

      // Logic Cleanup Token Mati
      const cleanupPromises = [];
      
      allResponses.forEach((resp, idx) => {
        if (!resp.success) {
          const error = resp.error;
          const badToken = allTokens[idx];
          
          if (
            error.code === 'messaging/invalid-registration-token' ||
            error.code === 'messaging/registration-token-not-registered'
          ) {
            const ownerId = tokenOwnerMap[badToken];
            if (ownerId) {
              const p = admin.firestore()
                .collection("users")
                .doc(ownerId)
                .update({
                  fcmTokens: FieldValue.arrayRemove(badToken)
                })
                .catch(err => console.error(`Failed cleanup ${ownerId}:`, err));
              cleanupPromises.push(p);
            }
          }
        }
      });

      if (cleanupPromises.length > 0) {
        await Promise.all(cleanupPromises);
        console.log(`✨ Cleaned ${cleanupPromises.length} invalid tokens.`);
      }

    } catch (error) {
      console.error("❌ Error sending notification:", error);
    }
  }
);