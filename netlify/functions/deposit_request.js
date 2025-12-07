// netlify/functions/deposit_request.js

const admin = require("firebase-admin");
const FedaPay = require('fedapay'); // <-- Rétabli à l'original

// --- Initialisation Firebase Admin (Sécurisée) ---
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

// --------------------------------------------------------
// --- Initialisation FedaPay ---
// --------------------------------------------------------

// Rétabli aux méthodes originales qui étaient dans le code
FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY); 
FedaPay.setEnvironment('live'); // Ou 'sandbox'

// --------------------------------------------------------
// --- Fonction Principale ---
// --------------------------------------------------------
exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: "Méthode non autorisée." }) };
    }

    let data;
    try {
        data = JSON.parse(event.body);
    } catch (error) {
        return { statusCode: 400, body: JSON.stringify({ error: "Format de requête invalide." }) };
    }

    const { idToken, amount, paymentMethod } = data;

    if (!idToken || !amount || amount <= 0 || !paymentMethod) {
        return { statusCode: 400, body: JSON.stringify({ error: "Données requises manquantes." }) };
    }

    let user;
    try {
        user = await admin.auth().verifyIdToken(idToken);
    } catch (error) {
        return { statusCode: 401, body: JSON.stringify({ error: "Token d'authentification invalide." }) };
    }
    const userId = user.uid;

    const transactionTitle = `Dépôt sur InvestApp`;
    const transactionDescription = `Augmentation de solde pour ${userId}`;
    const now = admin.firestore.FieldValue.serverTimestamp();

    try {
        // Création de la transaction FedaPay
        const transaction = await FedaPay.Transaction.create({ // Utilisation de FedaPay.Transaction
            description: transactionDescription,
            amount: amount,
            currency: 'XOF', // Adapter selon votre monnaie
            callback_url: process.env.DEPOSIT_CALLBACK_URL,
            customer: {
                // Vous pouvez ajouter plus de détails client ici
            }
        });

        // Enregistrement de la transaction en attente dans Firestore
        await db.collection("pending_transactions").doc(transaction.id).set({
            fedaPayId: transaction.id,
            userId: userId,
            amount: amount,
            type: "deposit",
            status: "pending",
            createdAt: now,
            paymentMethod: paymentMethod
        });

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: "Requête de dépôt réussie.",
                fedaPayToken: transaction.token // Jeton utilisé par le frontend
            })
        };

    } catch (err) {
        console.error("Erreur FedaPay ou Firebase:", err);
        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                error: "Erreur lors de la requête de dépôt (Serveur)."
            })
        };
    }
};