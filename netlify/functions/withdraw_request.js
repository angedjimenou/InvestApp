// netlify/functions/withdraw_request.js

const admin = require('firebase-admin');
const { FedaPay, Disbursement } = require('fedapay'); // <--- MODIFICATION 1 (Destructuring)

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

// Utilisez FedaPay.init() qui est plus récent et plus stable
FedaPay.init({
    apiKey: process.env.FEDAPAY_SECRET_KEY,
    environment: 'live' 
}); // <--- MODIFICATION 2 (Utilisation de init())

// --------------------------------------------------------
// --- Fonction Principale ---
// --------------------------------------------------------
exports.handler = async (event, context) => {
    // 1. Vérification HTTP
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: "Méthode non autorisée." }) };
    }

    // 2. Récupération du POST
    let data;
    try {
        data = JSON.parse(event.body);
    } catch (error) {
        return { statusCode: 400, body: JSON.stringify({ error: "Format de requête invalide." }) };
    }
    
    const { idToken, amount } = data; 

    if (!idToken || !amount || amount <= 0) {
        return { statusCode: 400, body: JSON.stringify({ error: "Montant requis manquant." }) };
    }

    // 3. Vérification de l'utilisateur
    let user;
    try {
        user = await admin.auth().verifyIdToken(idToken);
    } catch (error) {
        return { statusCode: 401, body: JSON.stringify({ error: "Token d'authentification invalide." }) };
    }
    const userId = user.uid;

    // 4. Transaction de Retrait
    try {
        const result = await db.runTransaction(async (t) => {
            const userRef = db.collection('users').doc(userId);
            const userDoc = await t.get(userRef);
            
            if (!userDoc.exists) throw new Error("ERR_USER_NOT_FOUND");

            const userData = userDoc.data();
            const currentBalance = userData.balance || 0;
            const newBalance = currentBalance - amount;

            if (newBalance < 0) throw new Error("ERR_INSUFFICIENT_FUNDS");

            const now = admin.firestore.FieldValue.serverTimestamp();
            
            // Étape 1: Créer le décaissement (Disbursement) via FedaPay
            // Note: Le montant est en XOF, currency doit correspondre à FedaPay.
            const disbursement = await Disbursement.create({
                amount: amount,
                currency: 'XOF', 
                // Assurez-vous que l'ID de la méthode de paiement est bien dans les données utilisateur
                payment_method_id: userData.paymentMethodId, 
                callback_url: process.env.DISBURSEMENT_CALLBACK_URL,
            });

            // Étape 2: Débit du solde dans Firestore
            t.update(userRef, {
                balance: newBalance,
                updatedAt: now,
            });

            // Étape 3: Enregistrement de la transaction en attente de décaissement
            t.set(db.collection("pending_disbursements").doc(disbursement.id), {
                fedaPayId: disbursement.id,
                userId: userId,
                amount: amount,
                status: 'pending',
                createdAt: now,
                updatedAt: now,
            });
            
            // Étape 4: Enregistrement de la transaction (Débit)
            t.set(db.collection("transactions").doc(), {
                uid: userId,
                type: "external",
                category: "withdrawal",
                amount: amount,
                direction: "debit",
                source: "Balance",
                target: "Disbursement",
                details: `Retrait FedaPay ID: ${disbursement.id}`,
                timestamp: now,
            });

            return { newBalance, disbursementId: disbursement.id };
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                success: true, 
                message: "Retrait initié avec succès. En attente de traitement FedaPay.",
                newBalance: result.newBalance,
                disbursementId: result.disbursementId
            })
        };

    } catch (e) {
        let errorCode = 500;
        let errorMessage = "Échec de l'initiation du retrait.";

        if (e.message === "ERR_INSUFFICIENT_FUNDS") {
            errorCode = 403; 
            errorMessage = "Solde insuffisant pour ce retrait.";
        } else if (e.message === "ERR_USER_NOT_FOUND") {
            errorCode = 404;
            errorMessage = "Utilisateur non trouvé.";
        } else {
            console.error("Erreur serveur lors de la transaction de retrait:", e);
        }

        return { statusCode: errorCode, body: JSON.stringify({ error: errorMessage }) };
    }
};