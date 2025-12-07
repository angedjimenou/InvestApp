// netlify/functions/deposit_request.js

const admin = require("firebase-admin");
const { FedaPay, Transaction } = require('fedapay'); // Déstructuration confirmée

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
// (Déjà corrigée dans la version précédente)
// --------------------------------------------------------
FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY); 
FedaPay.setEnvironment('live'); // N'oubliez pas de mettre 'sandbox' si vous testez

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

    const { idToken, amount, paymentMethod } = data; // paymentMethod est l'ID du document Firestore

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
    const now = admin.firestore.FieldValue.serverTimestamp();

    try {
        // 1. Récupération des informations de la méthode de paiement
        const methodRef = db.collection("users").doc(userId).collection("payment_methods").doc(paymentMethod);
        const methodDoc = await methodRef.get();

        if (!methodDoc.exists) {
            return { statusCode: 404, body: JSON.stringify({ error: "Méthode de paiement non trouvée." }) };
        }
        const methodData = methodDoc.data();
        const fullPhoneNumber = methodData.fullPhoneNumber; // Numéro de téléphone du client
        const operator = methodData.operator; // ex: mtn_mobilemoney, moov_money
        const firstName = methodData.fullName ? methodData.fullName.split(' ')[0] : 'Client';
        const lastName = methodData.fullName ? methodData.fullName.split(' ').slice(1).join(' ') : 'Invest';


        // 2. Détermination du mode FedaPay (crucial pour le 500)
        // Les modes FedaPay dépendent de l'opérateur (ex: mtn_mobilemoney, moov_money).
        // Si vous utilisez 'mtn_mobilemoney', le mode peut être 'mtn_open' ou 'mtn_mobilemoney'
        const fedaPayMode = `${operator}_open`; // Ex: 'mtn_mobilemoney' -> 'mtn_mobilemoney_open'
        if (fedaPayMode.includes('open')) {
             // FedaPay aime le format "operateur_open" pour les transactions de paiement initiées
             // depuis l'API, ou simplement le nom de l'opérateur.
        }
        
        // 3. Création de la transaction FedaPay (avec tous les champs requis)
        const transaction = await Transaction.create({ 
            description: `Dépôt InvestApp`,
            amount: amount,
            currency: 'XOF', // Adapter selon votre monnaie
            callback_url: process.env.DEPOSIT_CALLBACK_URL, // Assurez-vous que cette URL est correcte
            mode: operator, // Utiliser le nom de l'opérateur (ex: 'mtn_mobilemoney')
            customer: { // <-- CORRECTION: Détails Client
                firstname: firstName,
                lastname: lastName,
                email: user.email || `${userId}@investapp.co`, // Utiliser l'email Firebase
                phone_number: {
                    number: fullPhoneNumber.replace(/\+\d{1,3}/, ''), // Enlever le code pays pour le format FedaPay
                    country: fullPhoneNumber.substring(1, fullPhoneNumber.length - methodData.phoneNumber.length) || 'BJ' // Déduire le code pays
                }
            }
        });

        // 4. Enregistrement de la transaction en attente dans Firestore
        await db.collection("pending_transactions").doc(transaction.id).set({
            fedaPayId: transaction.id,
            userId: userId,
            amount: amount,
            type: "deposit",
            status: "pending",
            createdAt: now,
            paymentMethodId: paymentMethod, // L'ID du document de méthode
            fedaPayToken: transaction.token
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
        // Afficher l'erreur FedaPay au lieu du message générique
        let errorMessage = "Erreur lors de la requête de dépôt (Serveur).";
        if (err.httpResponse && err.httpResponse.data) {
             // Si FedaPay retourne un message d'erreur dans le corps, l'afficher
             try {
                const fedaPayError = JSON.parse(err.httpResponse.data);
                if (fedaPayError.message) errorMessage = fedaPayError.message;
             } catch (e) {
                 // Ignore si non JSON
             }
        } else if (err.message.includes('500')) {
            errorMessage = "Erreur de connexion FedaPay (Code 500). Vérifiez les clés et les paramètres.";
        }
        
        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                error: errorMessage
            })
        };
    }
};