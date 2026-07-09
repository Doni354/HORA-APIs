const admin = require("firebase-admin");

const serviceAccount = require('./FirebaseServiceKey.json');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

const OLD_URL_PREFIX1 = "https://storage.googleapis.com/hora-7394b.firebasestorage.app";
const OLD_URL_PREFIX2 = "https://storage.googleapis.com/vorce"; // If they already used the new bucket name with GCS URL
const NEW_URL_PREFIX = "https://cdn.vorce.id";

function updateStringField(value) {
  if (typeof value === "string") {
    if (value.includes(OLD_URL_PREFIX1)) {
      return value.replace(OLD_URL_PREFIX1, NEW_URL_PREFIX);
    }
    if (value.includes(OLD_URL_PREFIX2)) {
      return value.replace(OLD_URL_PREFIX2, NEW_URL_PREFIX);
    }
  }
  return value;
}

// Deeply traverse and update object
function updateObjectFields(obj) {
  let updated = false;
  const newObj = Array.isArray(obj) ? [] : {};
  
  for (const [key, val] of Object.entries(obj)) {
    if (val !== null && typeof val === "object" && !val.toDate) {
      // Exclude Firestore specific objects like Timestamps
      const result = updateObjectFields(val);
      newObj[key] = result.newObj;
      if (result.updated) updated = true;
    } else if (typeof val === "string") {
      const newVal = updateStringField(val);
      newObj[key] = newVal;
      if (newVal !== val) updated = true;
    } else {
      newObj[key] = val;
    }
  }
  return { updated, newObj };
}

async function processQuery(query) {
  try {
    const snapshot = await query.get();
    let updatedCount = 0;
    
    // Batch writes for efficiency (max 500 per batch)
    let batch = db.batch();
    let batchCount = 0;
    
    for (const doc of snapshot.docs) {
      const data = doc.data();
      let docNeedsUpdate = false;
      const newData = {};
      
      for (const [key, val] of Object.entries(data)) {
        if (typeof val === "string") {
          const newVal = updateStringField(val);
          newData[key] = newVal;
          if (newVal !== val) docNeedsUpdate = true;
        } else if (val !== null && typeof val === "object" && !val.toDate) {
          const result = updateObjectFields(val);
          newData[key] = result.newObj;
          if (result.updated) docNeedsUpdate = true;
        } else {
          newData[key] = val; // leave intact
        }
      }
      
      if (docNeedsUpdate) {
        batch.update(doc.ref, newData);
        batchCount++;
        updatedCount++;
        
        if (batchCount === 500) {
          await batch.commit();
          batch = db.batch();
          batchCount = 0;
        }
      }
    }
    
    if (batchCount > 0) {
      await batch.commit();
    }
    return updatedCount;
  } catch (err) {
    console.error("Error processing query:", err);
    return 0;
  }
}

async function run() {
  console.log("Starting Firestore URL replacement...");
  let totalUpdated = 0;

  const collectionsToProcess = [
    { type: 'collection', name: 'users' },
    { type: 'collection', name: 'companies' },
    { type: 'collectionGroup', name: 'absensi' },
    { type: 'collectionGroup', name: 'izin' },
    { type: 'collectionGroup', name: 'berkas' },
    { type: 'collectionGroup', name: 'tugas' },
    { type: 'collectionGroup', name: 'inbox' },
    { type: 'collectionGroup', name: 'reimburse' },
    { type: 'collectionGroup', name: 'files' },
  ];

  for (const coll of collectionsToProcess) {
    let query;
    if (coll.type === 'collection') {
      query = db.collection(coll.name);
    } else {
      query = db.collectionGroup(coll.name);
    }
    console.log(`Processing ${coll.type} '${coll.name}'...`);
    const c = await processQuery(query);
    console.log(` -> Updated ${c} documents.`);
    totalUpdated += c;
  }

  console.log(`Finished! Total documents updated: ${totalUpdated}`);
}

run();
