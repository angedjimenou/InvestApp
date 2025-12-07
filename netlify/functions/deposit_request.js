const admin = require("firebase-admin");
const { FedaPay, Transaction } = require('fedapay'); 

// --- Initialisation Firebase Admin ---
if (!admin.apps.length) {
    const creds = process.env.FIREBASE_ADMIN_CREDENTIALS;
    if (!creds) throw new Error("Variable FIREBASE_ADMIN_CREDENTIALS non définie.");

    const decodedCreds = Buffer.from(creds, 'base64').toString();
    const serviceAccount = JSON.parse(decodedCreds);

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

// --- Initialisation FedaPay ---
FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
FedaPay.setEnvironment(process.env.FEDAPAY_ENV || 'live'); // live ou sandbox

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: "Méthode non autorisée." }) };
    }

    let data;
    try {
        data = JSON.parse(event.body);
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: "Format JSON invalide." }) };
    }

    const { idToken, amount, paymentMethod } = data;
    if (!idToken || !amount || amount <= 0 || !paymentMethod) {
        return { statusCode: 400, body: JSON.stringify({ error: "Données manquantes (idToken, amount, paymentMethod)." }) };
    }

    // --- Vérification utilisateur ---
    let user;
    try {
        user = await admin.auth().verifyIdToken(idToken);
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: "Token invalide." }) };
    }
    const userId = user.uid;
    const now = admin.firestore.FieldValue.serverTimestamp();

    try {
        // --- Récupération de la méthode de paiement ---
        const methodRef = db.collection("users").doc(userId).collection("payment_methods").doc(paymentMethod);
        const methodDoc = await methodRef.get();
        if (!methodDoc.exists) return { statusCode: 404, body: JSON.stringify({ error: "Méthode de paiement non trouvée." }) };

        const methodData = methodDoc.data();
        let operator = methodData.operator; // ex: "mtn_bj"
        let phoneNumber = methodData.fullPhoneNumber;

        // --- Adaptation numéro pour FedaPay ---
        if (phoneNumber.startsWith('+')) phoneNumber = phoneNumber.slice(1);
        if (phoneNumber.startsWith('229')) phoneNumber = phoneNumber.slice(3); // retirer le code pays local

        // --- Adaptation prénom/nom ---
        const fullName = methodData.fullName || 'Client Invest';
        const nameParts = fullName.split(' ');
        const firstName = nameParts[0] || 'Client';
        const lastName = nameParts.slice(1).join(' ') || 'Invest';

        // --- Email forcé ---
        const customerEmail = process.env.FORCED_EMAIL || "Sylvstare12@gmail.com";

        // --- Création de la transaction FedaPay ---
        const transaction = await Transaction.create({
            description: `Dépôt InvestApp`,
            amount: amount,
            currency: 'XOF',
            callback_url: process.env.DEPOSIT_CALLBACK_URL,
            mode: operator,
            customer: {
                firstname: firstName,
                lastname: lastName,
                email: customerEmail,
                phone_number: {
                    number: phoneNumber,
                    country: '229'
                }
            }
        });

        // --- Enregistrement dans Firestore ---
        await db.collection("pending_transactions").doc(transaction.id).set({
            fedaPayId: transaction.id,
            userId: userId,
            amount: amount,
            type: "deposit",
            status: "pending",
            createdAt: now,
            paymentMethodId: paymentMethod,
            fedaPayToken: transaction.token
        });

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: "Requête de dépôt réussie.",
                fedaPayToken: transaction.token
            })
        };

    } catch (err) {
        console.error("Erreur dépôt :", err);
        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                error: "Erreur serveur lors de la création du dépôt."
            })
        };
    }
};