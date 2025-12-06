const admin = require("firebase-admin");

// Initialisation Firebase Admin
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.applicationDefault(),
    });
}
const db = admin.firestore();
const auth = admin.auth();

// Générateur de code de parrainage aléatoire
function generateReferralCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Handler Netlify Function
exports.handler = async (event, context) => {
    try {
        if (event.httpMethod !== "POST") {
            return {
                statusCode: 405,
                body: JSON.stringify({ error: "Méthode non autorisée" }),
            };
        }

        const body = JSON.parse(event.body);

        const { phone, countryCode, password, confirmPassword, inviteCode } = body;

        // Validation côté serveur
        if (!phone || !countryCode || !password || !confirmPassword || !inviteCode) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Tous les champs sont requis." }),
            };
        }

        if (password !== confirmPassword) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Les mots de passe ne correspondent pas." }),
            };
        }

        if (password.length < 6) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Le mot de passe doit contenir au moins 6 caractères." }),
            };
        }

        if (phone.length < 8 || phone.length > 10) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Numéro de téléphone invalide (8 à 10 chiffres)." }),
            };
        }

        // Vérification du code d’invitation
        const codeRef = db.collection("referralCodes").doc(inviteCode);
        const codeSnap = await codeRef.get();
        if (!codeSnap.exists) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Code d’invitation invalide." }),
            };
        }
        const referrerUid = codeSnap.data().userIdParrain;

        // Création email fictif
        const email = `${countryCode}${phone}@investapp.local`;

        // Création utilisateur Firebase
        let userRecord;
        try {
            userRecord = await auth.createUser({ email, password });
        } catch (err) {
            if (err.code === "auth/email-already-exists") {
                // Si déjà existant, on récupère l'UID
                const existingUser = await auth.getUserByEmail(email);
                userRecord = existingUser;
            } else {
                throw err;
            }
        }

        const uid = userRecord.uid;
        const newCode = generateReferralCode();
        const now = admin.firestore.Timestamp.now();

        // Batch Firestore
        const batch = db.batch();

        // Document user
        const userRef = db.collection("users").doc(uid);
        batch.set(userRef, {
            phone: phone,
            countryCode: countryCode,
            balance: 0,
            daily: { invest: 0, referral: 0 },
            totalRevenue: { invest: 0, referral: 0 },
            referrerUid: referrerUid,
            myReferralCode: newCode,
            firstInvestmentDone: false,
            createdAt: now
        });

        // Document referralCodes
        const refCodeRef = db.collection("referralCodes").doc(newCode);
        batch.set(refCodeRef, { userIdParrain: uid });

        // Document filleuls du parrain
        const parentFilleulRef = db.collection("filleuls").doc(referrerUid);
        const parentFilleulSnap = await parentFilleulRef.get();

        const filleulMapData = {
            totalEarned: 0,
            createdAt: now
        };

        const updateObject = { [uid]: filleulMapData };

        if (parentFilleulSnap.exists) {
            batch.update(parentFilleulRef, updateObject);
        } else {
            batch.set(parentFilleulRef, updateObject);
        }

        // Document filleuls de l’utilisateur (vide pour le moment)
        batch.set(db.collection("filleuls").doc(uid), {});

        // Commit batch
        await batch.commit();

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Compte créé avec succès.",
                uid: uid,
                referralCode: newCode
            }),
        };

    } catch (err) {
        console.error("Erreur inscription:", err);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Impossible de créer le compte. Vérifiez vos informations." }),
        };
    }
};