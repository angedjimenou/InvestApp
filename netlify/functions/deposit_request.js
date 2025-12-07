// netlify/functions/deposit_request.js

const admin = require("firebase-admin");
const { FedaPay, Transaction } = require('fedapay'); 

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
        const fullPhoneNumber = methodData.fullPhoneNumber; // Ex: +2290152761079
        const operator = methodData.operator; 
        
        // --- GESTION DU NOM ---
        const fullName = methodData.fullName || 'Client Invest'; 
        const nameParts = fullName.split(' ');
        const firstName = nameParts[0] || 'Client';
        const lastName = nameParts.slice(1).join(' ') || 'Invest';

        // 2. GESTION DU NUMÉRO DE TÉLÉPHONE (CORRIGÉ POUR FedaPay Bénin)
        let countryCode = '229'; 
        let localNumber = fullPhoneNumber;

        // 1. Nettoyer le numéro: Enlever le '+'
        if (localNumber.startsWith('+')) {
            localNumber = localNumber.substring(1); 
        }
        
        // 2. Enlever explicitement le code pays '229' si le numéro nettoyé commence par '229'
        if (localNumber.startsWith('229')) {
            localNumber = localNumber.substring(3); // Reste: 0152761079
        }
        
        // localNumber est maintenant : 0152761079 (10 chiffres)
        // Nous le laissons tel quel comme FedaPay l'exige.
        
        // 3. Utilisation de l'email Firebase (Sécurisée)
        const customerEmail = user.email || `${userId}@investapp.co`; 

        // 4. Création de la transaction FedaPay 
        const transaction = await Transaction.create({ 
            description: `Dépôt InvestApp`,
            amount: amount,
            currency: 'XOF', 
            callback_url: process.env.DEPOSIT_CALLBACK_URL, 
            mode: operator, 
            customer: { // Détails Client
                firstname: firstName,
                lastname: lastName,
                email: customerEmail,
                phone_number: {
                    number: localNumber, // Ex: 0152761079 (10 chiffres, avec le 0 initial)
                    country: countryCode, // Ex: 229
                }
            }
        });

        // 5. Enregistrement de la transaction en attente dans Firestore
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
        console.error("Erreur FedaPay ou Firebase:", err);
        
        let errorMessage = "Erreur lors de la requête de dépôt (Serveur).";
        
        // Tente de décoder l'erreur spécifique de FedaPay
        if (err.httpResponse && err.httpResponse.data) {
             try {
                const fedaPayError = JSON.parse(err.httpResponse.data);
                if (fedaPayError.message) {
                    errorMessage = `Erreur FedaPay : ${fedaPayError.message}`;
                } else if (fedaPayError.errors) {
                    errorMessage = `Erreur FedaPay : ${JSON.stringify(fedaPayError.errors)}`;
                }
             } catch (e) { /* Non JSON */ }
        } else if (err.message.includes('500')) {
             errorMessage = "Erreur interne de FedaPay. Vérifiez vos paramètres ou contactez le support FedaPay. (Code 500)";
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
