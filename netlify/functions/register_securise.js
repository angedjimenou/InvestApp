// register_securise.js
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.firestore();
const auth = admin.auth();

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: "Méthode non autorisée" }),
      };
    }

    const { phone, countryCode, password, inviteCode } = JSON.parse(event.body || "{}");

    // Vérification des champs requis
    if (!phone || !countryCode || !password || !inviteCode) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Tous les champs sont requis" }),
      };
    }

    if (password.length < 6) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Le mot de passe doit contenir au moins 6 caractères" }),
      };
    }

    if (phone.length < 8 || phone.length > 10) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Numéro de téléphone invalide" }),
      };
    }

    // Vérifier le code d'invitation
    const codeRef = db.collection("referralCodes").doc(inviteCode);
    const codeSnap = await codeRef.get();
    if (!codeSnap.exists) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Code d’invitation invalide" }),
      };
    }
    const referrerUid = codeSnap.data().userIdParrain;

    // Génération de l'email fictif
    const email = `${countryCode}${phone}@investapp.local`;

    // Création de l'utilisateur Firebase
    let userRecord;
    try {
      userRecord = await auth.createUser({ email, password });
    } catch (err) {
      if (err.code === "auth/email-already-exists") {
        userRecord = await auth.getUserByEmail(email); // récupérer UID existant
      } else {
        console.error("Erreur Auth:", err);
        return {
          statusCode: 500,
          body: JSON.stringify({ error: "Impossible de créer le compte." }),
        };
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
    const myReferralCode = generateReferralCode();
    const now = new Date();

    // Préparer batch Firestore
    const batch = db.batch();

    // Document utilisateur
    const userRef = db.collection("users").doc(uid);
    batch.set(userRef, {
      phone,
      countryCode,
      balance: 0,
      daily: { invest: 0, referral: 0 },
      totalRevenue: { invest: 0, referral: 0 },
      referrerUid,
      myReferralCode,
      firstInvestmentDone: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Document referral code
    const refCodeRef = db.collection("referralCodes").doc(myReferralCode);
    batch.set(refCodeRef, { userIdParrain: uid });

    // Document filleuls du parrain
    const parentFilleulRef = db.collection("filleuls").doc(referrerUid);
    const parentFilleulSnap = await parentFilleulRef.get();

    const filleulMapData = { totalEarned: 0, createdAt: now };
    const updateObject = { [uid]: filleulMapData };

    if (parentFilleulSnap.exists) {
      batch.update(parentFilleulRef, updateObject);
    } else {
      batch.set(parentFilleulRef, updateObject);
    }

    // Document filleuls du nouvel utilisateur (vide pour l'instant)
    batch.set(db.collection("filleuls").doc(uid), {});

    // Commit batch
    await batch.commit();

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, myReferralCode }),
    };

  } catch (err) {
    console.error("Erreur inscription:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Erreur serveur lors de l'inscription." }),
    };
  }
};