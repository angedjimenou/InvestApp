// netlify/functions/fedapay_webhook.js

const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const FedaPay = require('fedapay');
const crypto = require('crypto');

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

// Clé secrète du webhook FedaPay (À définir dans Netlify)
const WEBHOOK_SECRET = process.env.FEDAPAY_WEBHOOK_SECRET;

/**
 * Fonction de vérification de la signature FedaPay pour garantir l'authenticité
 * @param {string} signature - La signature envoyée dans l'entête X-FedaPay-Signature
 * @param {string} payload - Le corps de la requête Webhook (JSON brut)
 * @returns {boolean} - Vrai si la signature correspond
 */
function verifySignature(signature, payload) {
    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
    hmac.update(payload);
    const expectedSignature = hmac.digest('hex');
    // Comparaison sécurisée (évite les attaques de temporisation)
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}

exports.handler = async (event) => {
    // 1. Vérification de la méthode
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    // 2. Récupération des données et de la signature
    const signature = event.headers['x-fedapay-signature'];
    const payload = event.body; // Le corps est toujours une chaîne JSON brut

    // 3. Vérification de la signature (CRUCIAL pour la sécurité)
    if (!verifySignature(signature, payload)) {
        console.error("Signature FedaPay invalide.");
        return { statusCode: 401, body: "Signature Invalide" };
    }

    try {
        const data = JSON.parse(payload);
        const transactionId = data.id;
        const transactionStatus = data.status;
        const transactionAmount = data.amount / 100; // FedaPay utilise des centimes

        // Nous nous concentrons uniquement sur les événements de transaction 'approved'
        if (transactionStatus !== 'approved') {
            return { statusCode: 200, body: `Statut non pertinent: ${transactionStatus}` };
        }

        // 4. Recherche de la transaction 'pending' dans Firestore
        const transactionsRef = db.collection('transactions');
        const querySnapshot = await transactionsRef
            .where('fedapay_id', '==', transactionId)
            .where('status', '==', 'pending')
            .limit(1)
            .get();

        if (querySnapshot.empty) {
            // Transaction déjà traitée ou non trouvée (erreur côté Fedapay ou DB)
            console.warn(`Transaction FedaPay ${transactionId} non trouvée ou déjà complétée.`);
            return { statusCode: 200, body: "Transaction déjà traitée ou inexistante" };
        }

        const transactionDoc = querySnapshot.docs[0];
        const transactionData = transactionDoc.data();
        const userId = transactionData.uid;
        
        // Sécurité : Vérifiez que le montant correspond (important)
        if (transactionAmount !== transactionData.amount) {
             console.error(`Montant incohérent pour ${transactionId}. Attendu: ${transactionData.amount}, Reçu: ${transactionAmount}`);
             // Laisser le statut en 'pending' et enregistrer l'erreur pour examen manuel
             await transactionDoc.ref.update({ status: 'error', error_details: 'Amount mismatch' });
             return { statusCode: 400, body: "Erreur de montant" };
        }

        // 5. Mise à jour atomique du statut et du solde de l'utilisateur (Transaction Firestore)
        const userRef = db.collection('users').doc(userId);

        await db.runTransaction(async (t) => {
            const userSnap = await t.get(userRef);
            if (!userSnap.exists) throw "Utilisateur non trouvé.";

            const newBalance = (userSnap.data().balance || 0) + transactionAmount;
            
            // 5a. Créditer l'utilisateur
            t.update(userRef, { balance: newBalance });
            
            // 5b. Mettre à jour la transaction
            t.update(transactionDoc.ref, { 
                status: 'completed',
                completedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        console.log(`Dépôt ${transactionId} de ${transactionAmount} F réussi pour l'utilisateur ${userId}.`);

        // 6. Réponse à FedaPay
        return { statusCode: 200, body: "OK" };

    } catch (error) {
        console.error("Erreur fatale Webhook:", error);
        return { statusCode: 500, body: "Erreur Serveur Interne" };
    }
};
