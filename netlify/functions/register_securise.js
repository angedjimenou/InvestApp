const admin = require("firebase-admin");

// --- PARSE LE JSON ENCODÉ EN BASE64 ---
if (!process.env.FIREBASE_ADMIN_CREDENTIALS) {
  throw new Error("FIREBASE_ADMIN_CREDENTIALS n'est pas défini !");
}

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_ADMIN_CREDENTIALS, "base64").toString("utf8")
);

// INITIALISATION FIREBASE ADMIN
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const auth = admin.auth();

exports.handler = async (event, context) => {
  try {
    const body = JSON.parse(event.body);
    const { phone, countryCode, password, inviteCode } = body;

    if (!phone || !countryCode || !password || !inviteCode) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: "Tous les champs sont requis." })
      };
    }

    // Création de l'email fictif
    const email = `${countryCode}${phone}@investapp.local`;

    // Vérification du code d'invitation
    const codeRef = db.collection("referralCodes").doc(inviteCode);
    const codeSnap = await codeRef.get();
    if (!codeSnap.exists) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: "Code d’invitation invalide." })
      };
    }
    const referrerUid = codeSnap.data().userIdParrain;

    // Création de l'utilisateur Firebase Auth
    let userRecord;
    try {
      userRecord = await auth.createUser({ email, password });
    } catch (err) {
      if (err.code === 'auth/email-already-exists') {
        userRecord = await auth.getUserByEmail(email);
      } else {
        throw err;
      }
    }

    const uid = userRecord.uid;

    // Génération du code de parrainage pour le nouvel utilisateur
    const generateReferralCode = () => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return code;
    };
    const newReferralCode = generateReferralCode();
    const now = new Date();

    // BATCH FIRESTORE
    const batch = db.batch();

    const userRef = db.collection("users").doc(uid);
    batch.set(userRef, {
      phone,
      countryCode,
      balance: 0,
      daily: { invest: 0, referral: 0 },
      totalRevenue: { invest: 0, referral: 0 },
      referrerUid,
      myReferralCode: newReferralCode,
      firstInvestmentDone: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const refCodeRef = db.collection("referralCodes").doc(newReferralCode);
    batch.set(refCodeRef, { userIdParrain: uid });

    const parentFilleulRef = db.collection("filleuls").doc(referrerUid);
    const parentFilleulSnap = await parentFilleulRef.get();

    const filleulData = { totalEarned: 0, createdAt: now };
    const updateObj = { [uid]: filleulData };

    if (parentFilleulSnap.exists) {
      batch.update(parentFilleulRef, updateObj);
    } else {
      batch.set(parentFilleulRef, updateObj);
    }

    // Document vide pour le nouvel utilisateur dans 'filleuls'
    batch.set(db.collection("filleuls").doc(uid), {});

    await batch.commit();

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, myReferralCode: newReferralCode })
    };

  } catch (err) {
    console.error("Erreur inscription:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: "Impossible de créer le compte. Vérifiez vos informations."
      })
    };
  }
};