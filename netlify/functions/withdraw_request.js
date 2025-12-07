// netlify/functions/withdraw_request.js

const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const FedaPay = require('fedapay'); // Assurez-vous d'avoir la librairie installée

// Initialisation de Firebase Admin SDK (CORRECTION Base64)
if (!admin.apps.length) {
    // 1. Décodage de la chaîne Base64
    const decodedServiceAccount = Buffer.from(
        process.env.FIREBASE_ADMIN_CREDENTIALS,
        'base64'
    ).toString('utf8');

    // 2. Parsage du JSON décodé
    const serviceAccount = JSON.parse(decodedServiceAccount);
    
    initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = getFirestore();

// Initialisation de FedaPay (pour le décaissement)
FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY); 
FedaPay.setEnvironment('live'); // Ou 'sandbox'

const MIN_WITHDRAWAL = 1000;
const INITIAL_INVESTMENT_KEY = 'initialInvestment'; 
// UTILISATION DE LA VARIABLE D'ENVIRONNEMENT
const DISBURSEMENT_CALLBACK_URL = process.env.DISBURSEMENT_CALLBACK_URL; 

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, error: "Méthode non autorisée." }) };
    }

    try {
        const { uid, amount, operator, receiverPhone, methodId } = JSON.parse(event.body);

        // ... [Vérification des données] ...
        if (!uid || !amount || amount < MIN_WITHDRAWAL || !operator || !receiverPhone || !methodId) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Données de retrait invalides ou montant trop bas." }) };
        }

        if (!DISBURSEMENT_CALLBACK_URL) {
             console.error("Variable DISBURSEMENT_CALLBACK_URL manquante.");
             return { statusCode: 500, body: JSON.stringify({ success: false, error: "Erreur serveur: URL de rappel de décaissement non configurée." }) };
        }
        
        const userRef = db.collection('users').doc(uid);
        let transactionDocId = null; // Renommé pour plus de clarté

        // --- 1. DÉDUCTION DU SOLDE ET ENREGISTREMENT DE LA REQUÊTE (TRANSACTION FIRESTORE) ---
        await db.runTransaction(async (t) => {
            const userSnap = await t.get(userRef);
            if (!userSnap.exists) throw new Error("Utilisateur non trouvé.");
            
            const userData = userSnap.data();
            const currentBalance = userData.balance || 0;
            const initialInvestment = userData[INITIAL_INVESTMENT_KEY] || 0; 
            const withdrawableBalance = currentBalance - initialInvestment;
            
            if (withdrawableBalance < amount) {
                throw new Error(`Solde retirable insuffisant. Disponible: ${withdrawableBalance.toLocaleString('fr-FR')} F`);
            }
            
            // Déduction du solde
            const newBalance = currentBalance - amount;
            t.update(userRef, { balance: newBalance });

            // Enregistrement initial de la transaction (avant l'appel FedaPay)
            const newTransactionRef = db.collection("transactions").doc();
            
            t.set(newTransactionRef, {
                uid: uid,
                type: 'withdrawal',
                amount: amount,
                status: 'deducted_pending_disbursement', 
                operator: operator,
                receiverPhone: receiverPhone,
                methodId: methodId,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // Enregistre l'ID du document pour l'utiliser si l'appel FedaPay échoue
            transactionDocId = newTransactionRef.id;
        });

        // --- 2. APPEL DE L'API FEDAPAY POUR LE DÉCAISSEMENT ---
        const disbursement = await FedaPay.Disbursement.create({
            amount: amount,
            currency: { code: 'XOF' },
            description: "Retrait Sabot Invest",
            customer: { phone: receiverPhone },
            // Utilisation de la variable d'environnement
            callback_url: DISBURSEMENT_CALLBACK_URL 
        });

        // Mise à jour de la transaction dans Firestore avec l'ID FedaPay
        await db.collection("transactions").doc(transactionDocId).update({
            fedapay_id: disbursement.id,
            status: 'pending_disbursement' // Statut clair pour le suivi
        });
        
        // 3. Réponse au client
        return {
            statusCode: 200,
            body: JSON.stringify({ 
                success: true, 
                message: "Demande de retrait initiée. Le paiement est en cours de traitement.",
                disbursement_id: disbursement.id
            })
        };

    } catch (error) {
        console.error("Erreur Retrait Serveur FedaPay:", error.message);
        
        if (error.message.includes('Solde retirable insuffisant')) {
            return {
                statusCode: 400,
                body: JSON.stringify({ success: false, error: error.message })
            };
        }
        
        // Cas d'erreur où le solde a été déduit mais l'appel FedaPay a échoué
        // Idéalement, une transaction Firestore devrait tenter de renverser la déduction ici.
        // Pour une solution rapide, on marque l'erreur
        if (transactionDocId) {
             await db.collection("transactions").doc(transactionDocId).update({
                 status: 'failed_api_call',
                 error_details: error.message
             });
        }
        
        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: "Erreur interne lors du traitement du décaissement." })
        };
    }
};
