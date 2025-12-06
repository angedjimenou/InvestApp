// netlify/functions/register_securise.js

const admin = require('firebase-admin');

// --------------------------------------------------------
// --- Initialisation Firebase Admin ---
// --------------------------------------------------------
const initializeAdmin = () => {
    if (!admin.apps.length) {
        const creds = process.env.FIREBASE_ADMIN_CREDENTIALS;
        if (!creds) throw new Error("FIREBASE_ADMIN_CREDENTIALS non défini");
        const decoded = Buffer.from(creds, 'base64').toString();
        const serviceAccount = JSON.parse(decoded);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }
};
const db = () => admin.firestore();

// --------------------------------------------------------
// --- Générateur de code de parrainage ---
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
// --- Fonction principale ---
// --------------------------------------------------------
exports.handler = async (event) => {
    try {
        initializeAdmin();

        if (event.httpMethod !== 'POST') {
            return { statusCode: 405, body: JSON.stringify({ error: "Méthode non autorisée" }) };
        }

        const { phone, countryCode, password, inviteCode } = JSON.parse(event.body);

        if (!phone || !countryCode || !password || !inviteCode) {
            return { statusCode: 400, body: JSON.stringify({ error: "Données manquantes." }) };
        }
        if (password.length < 6 || phone.length < 8 || phone.length > 10) {
            return { statusCode: 400, body: JSON.stringify({ error: "Numéro ou mot de passe invalide." }) };
        }

        // Vérifier code d’invitation
        const codeRef = db().collection("referralCodes").doc(inviteCode);
        const codeSnap = await codeRef.get();
        if (!codeSnap.exists) {
            return { statusCode: 403, body: JSON.stringify({ error: "Code d’invitation invalide." }) };
        }
        const referrerUid = codeSnap.data().userIdParrain;

        const email = `${countryCode}${phone}@investapp.local`;

        // Création utilisateur Firebase Auth
        let userRecord;
        try {
            userRecord = await admin.auth().createUser({
                email,
                password,
                displayName: phone,
                phoneNumber: `${countryCode}${phone}`
            });
        } catch (err) {
            if (err.code === "auth/email-already-exists") {
                return { statusCode: 403, body: JSON.stringify({ error: "Ce numéro est déjà utilisé." }) };
            }
            console.error("Erreur Auth:", err);
            return { statusCode: 500, body: JSON.stringify({ error: "Erreur création utilisateur." }) };
        }

        const uid = userRecord.uid;

        // Générer un code de parrainage unique
        let newReferralCode, unique = false;
        while (!unique) {
            newReferralCode = generateReferralCode();
            const check = await db().collection("referralCodes").doc(newReferralCode).get();
            if (!check.exists) unique = true;
        }

        const now = admin.firestore.Timestamp.now();

        // Transaction Firestore pour créer tous les documents
        await db().runTransaction(async (t) => {
            const userRef = db().collection("users").doc(uid);
            t.set(userRef, {
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

            const refCodeRef = db().collection("referralCodes").doc(newReferralCode);
            t.set(refCodeRef, { userIdParrain: uid });

            const parentFilleulRef = db().collection("filleuls").doc(referrerUid);
            const parentFilleulSnap = await t.get(parentFilleulRef);
            const updateObject = { [uid]: { totalEarned: 0, createdAt: now } };

            if (parentFilleulSnap.exists) {
                t.update(parentFilleulRef, updateObject);
            } else {
                t.set(parentFilleulRef, updateObject);
            }

            t.set(db().collection("filleuls").doc(uid), {});
        });

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                uid,
                myReferralCode: newReferralCode
            })
        };

    } catch (error) {
        console.error("Erreur inscription:", error);
        return { statusCode: 500, body: JSON.stringify({ error: "Erreur interne lors de l'inscription." }) };
    }
};