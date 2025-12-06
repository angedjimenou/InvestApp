// netlify/functions/register_securise.js

const admin = require('firebase-admin');

// --------------------------------------------------------
// --- Initialisation Firebase Admin (Sécurisée) ---
// --------------------------------------------------------
const initializeAdmin = () => {
    try {
        if (!admin.apps.length) {
            const creds = process.env.FIREBASE_ADMIN_CREDENTIALS;
            if (!creds) throw new Error("Variable FIREBASE_ADMIN_CREDENTIALS non définie.");

            const decodedCreds = Buffer.from(creds, 'base64').toString();
            const serviceAccount = JSON.parse(decodedCreds);

            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });

            console.log("Firebase Admin initialisé.");
        }
    } catch (error) {
        console.error("Erreur d'initialisation Admin SDK:", error);
        return false;
    }
    return true;
};

// --------------------------------------------------------
// --- Firestore Helper ---
// --------------------------------------------------------
const db = () => admin.firestore();

// --------------------------------------------------------
// --- Génération code de parrainage ---
// --------------------------------------------------------
function generateReferralCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// --------------------------------------------------------
// --- Handler principal ---
// --------------------------------------------------------
exports.handler = async (event, context) => {

    // 1. Initialisation Firebase Admin
    if (!initializeAdmin()) {
        return { statusCode: 500, body: JSON.stringify({ error: "Configuration serveur invalide." }) };
    }

    // 2. Vérification de la méthode HTTP
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: "Méthode non autorisée." }) };
    }

    // 3. Récupération et validation des données
    let data;
    try {
        data = JSON.parse(event.body);
    } catch (error) {
        return { statusCode: 400, body: JSON.stringify({ error: "Format de requête invalide." }) };
    }

    const { phone, countryCode, password, inviteCode } = data;

    if (!phone || !countryCode || !password || !inviteCode || password.length < 6 || phone.length < 8 || phone.length > 10) {
        return { statusCode: 400, body: JSON.stringify({ error: "Données manquantes ou invalides." }) };
    }

    const email = `${countryCode}${phone}@investapp.local`;

    // 4. Vérification du code d’invitation
    const codeRef = db().collection("referralCodes").doc(inviteCode);
    const codeSnap = await codeRef.get();
    if (!codeSnap.exists) {
        return { statusCode: 403, body: JSON.stringify({ error: "Code d’invitation invalide." }) };
    }
    const referrerUid = codeSnap.data().userIdParrain;

    // 5. Création de l'utilisateur Firebase Auth
    let authUser;
    try {
        authUser = await admin.auth().createUser({
            email: email,
            password: password,
            displayName: phone,
            phoneNumber: countryCode + phone,
        });
    } catch (authError) {
        if (authError.code === "auth/email-already-in-use") {
            return { statusCode: 403, body: JSON.stringify({ error: "Ce numéro est déjà utilisé." }) };
        }
        console.error("Erreur Firebase Auth:", authError);
        return { statusCode: 500, body: JSON.stringify({ error: "Erreur de création d'utilisateur." }) };
    }

    const uid = authUser.uid;

    // 6. Génération d’un code de parrainage unique
    let newReferralCode;
    let isCodeUnique = false;

    while (!isCodeUnique) {
        newReferralCode = generateReferralCode();
        const check = await db().collection("referralCodes").doc(newReferralCode).get();
        if (!check.exists) {
            isCodeUnique = true;
        }
    }

    const now = admin.firestore.Timestamp.now();

    // 7. Transaction Firestore
    try {
        await db().runTransaction(async (transaction) => {

            // a) Création document utilisateur
            const userRef = db().collection("users").doc(uid);
            transaction.set(userRef, {
                phone,
                countryCode,
                balance: 0,
                daily: { invest: 0, referral: 0 },
                totalRevenue: { invest: 0, referral: 0 },
                referrerUid,
                myReferralCode: newReferralCode,
                firstInvestmentDone: false,
                createdAt: now
            });

            // b) Création document code parrainage
            const refCodeRef = db().collection("referralCodes").doc(newReferralCode);
            transaction.set(refCodeRef, { userIdParrain: uid });

            // c) Mise à jour filleuls du parrain
            const parentFilleulRef = db().collection("filleuls").doc(referrerUid);
            const parentFilleulSnap = await transaction.get(parentFilleulRef);

            const filleulMapData = { totalEarned: 0, createdAt: now };
            const updateObject = { [uid]: filleulMapData };

            if (parentFilleulSnap.exists) {
                transaction.update(parentFilleulRef, updateObject);
            } else {
                transaction.set(parentFilleulRef, updateObject);
            }

            // d) Création document vide pour le nouvel utilisateur
            transaction.set(db().collection("filleuls").doc(uid), {});
        });

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                myReferralCode: newReferralCode
            }),
        };

    } catch (error) {
        console.error("Erreur Inscription (Transaction):", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Erreur interne lors de l'inscription." }),
        };
    }
};