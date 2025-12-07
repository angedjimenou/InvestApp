// netlify/functions/deposit_request.js

const admin = require("firebase-admin");
const { FedaPay, Transaction } = require('fedapay'); // Déstructuration confirmée (requis pour setApiKey)

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
// Assurez-vous que FEDAPAY_SECRET_KEY est une clé "live" ou "sandbox" selon le mode ci-dessous.
FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY); 
FedaPay.setEnvironment('live'); // Si vous testez, mettez 'sandbox'

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
        return { statusCode: 400, body: JSON.stringify({ error: "Données requises manquantes. (idToken, amount, paymentMethod)" }) };
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
            return { statusCode: 404, body: JSON.stringify({ error: "Méthode de paiement non trouvée en base de données." }) };
        }
        const methodData = methodDoc.data();
        const fullPhoneNumber = methodData.fullPhoneNumber; // Ex: +22997000000
        const operator = methodData.operator; // Ex: mtn_mobilemoney, moov_money
        
        // --- GESTION DU NOM (Sécurisée) ---
        // S'assurer que fullName existe avant de le manipuler
        const fullName = methodData.fullName || 'Client Invest'; 
        const nameParts = fullName.split(' ');
        const firstName = nameParts[0] || 'Client';
        const lastName = nameParts.slice(1).join(' ') || 'Invest';

        // --- GESTION DU NUMÉRO DE TÉLÉPHONE (Sécurisée - Correction du TypeError) ---
        // Utilisation d'une regex pour isoler le code pays du numéro local
        const countryCodeMatch = fullPhoneNumber.match(/^\+(\d{1,4})/);
        
        let countryCode = '229'; // Défaut : Bénin
        let localNumber = fullPhoneNumber;

        if (countryCodeMatch && countryCodeMatch[1]) {
            // Le code pays est le chiffre après le '+'
            countryCode = countryCodeMatch[1]; 
            // Le numéro local est la partie restante
            localNumber = fullPhoneNumber.substring(countryCodeMatch[0].length); 
        } else {
             // Si le format n'est pas +XXX..., on enlève juste le premier '+' et on assume le pays par défaut
             if (localNumber.startsWith('+')) {
                 localNumber = localNumber.substring(1);
             }
        }
        
        // Assurez-vous que l'email est rempli pour le client FedaPay
        const customerEmail = user.email || `${userId}@investapp.co`; 

        // 2. Création de la transaction FedaPay (avec tous les champs requis)
        const transaction = await Transaction.create({ 
            description: `Dépôt InvestApp`,
            amount: amount,
            currency: 'XOF', 
            callback_url: process.env.DEPOSIT_CALLBACK_URL, // Doit être configuré sur Netlify
            mode: operator, // Ex: 'mtn_mobilemoney' (FedaPay gère la redirection)
            customer: { // Détails Client
                firstname: firstName,
                lastname: lastName,
                email: customerEmail,
                phone_number: {
                    number: localNumber, 
                    country: countryCode, 
                }
            }
        });

        // 3. Enregistrement de la transaction en attente dans Firestore
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
                fedaPayToken: transaction.token // Jeton utilisé par le frontend
            })
        };

    } catch (err) {
        console.error("Erreur FedaPay ou Firebase:", err);
        
        let errorMessage = "Erreur lors de la requête de dépôt (Serveur).";
        
        // Tente de décoder l'erreur spécifique de FedaPay (si elle existe)
        if (err.httpResponse && err.httpResponse.data) {
             try {
                const fedaPayError = JSON.parse(err.httpResponse.data);
                // Si FedaPay renvoie une erreur détaillée
                if (fedaPayError.message) {
                    errorMessage = `Erreur FedaPay : ${fedaPayError.message}`;
                } else if (fedaPayError.errors) {
                    // Parfois FedaPay envoie un tableau d'erreurs
                    errorMessage = `Erreur FedaPay : ${JSON.stringify(fedaPayError.errors)}`;
                }
             } catch (e) {
                 // Ignore si la réponse n'est pas JSON
             }
        } else if (err.message.includes('40')) {
             // Erreur de client (ex: 400 Bad Request)
             errorMessage = "Erreur de paramètres envoyés à FedaPay. (Code 4xx)";
        } else if (err.message.includes('500')) {
             // Erreur de serveur (API FedaPay)
             errorMessage = "Erreur interne de FedaPay. Réessayez plus tard. (Code 500)";
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