// netlify/functions/fedapay_disbursement_webhook.js

const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
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

// Clé secrète du webhook FedaPay (Même clé que pour le dépôt, ou une différente si configuré ainsi)
const WEBHOOK_SECRET = process.env.FEDAPAY_WEBHOOK_SECRET; 

// Fonction de vérification de la signature (réutilisée du webhook de dépôt)
function verifySignature(signature, payload) {
    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
    hmac.update(payload);
    const expectedSignature = hmac.digest('hex');
    // Comparaison sécurisée (évite les attaques de temporisation)
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    const signature = event.headers['x-fedapay-signature'];
    const payload = event.body;

    // Sécurité : Vérification de la signature
    if (!verifySignature(signature, payload)) {
        console.error("Signature FedaPay (Décaissement) invalide.");
        return { statusCode: 401, body: "Signature Invalide" };
    }

    try {
        const data = JSON.parse(payload);
        const disbursementId = data.id;
        const disbursementStatus = data.status;
        const disbursementAmount = data.amount / 100; // FedaPay utilise des centimes

        // Nous nous concentrons sur les événements finaux de décaissement
        if (disbursementStatus === 'transferred' || disbursementStatus === 'failed') {
            
            const transactionsRef = db.collection('transactions');
            const querySnapshot = await transactionsRef
                .where('fedapay_id', '==', disbursementId)
                .where('status', '==', 'pending_disbursement')
                .limit(1)
                .get();

            if (querySnapshot.empty) {
                console.warn(`Décaissement FedaPay ${disbursementId} non trouvé ou déjà finalisé.`);
                return { statusCode: 200, body: "Décaissement déjà traité" };
            }

            const transactionDoc = querySnapshot.docs[0];
            const transactionData = transactionDoc.data();
            const userId = transactionData.uid;
            
            // Sécurité : Vérifiez que le montant correspond
            if (disbursementAmount !== transactionData.amount) {
                 console.error(`Montant décaissement incohérent pour ${disbursementId}.`);
                 await transactionDoc.ref.update({ status: 'error', error_details: 'Amount mismatch in disbursement webhook' });
                 return { statusCode: 400, body: "Erreur de montant" };
            }

            if (disbursementStatus === 'transferred') {
                // Succès : Le retrait est complet.
                await transactionDoc.ref.update({
                    status: 'completed',
                    completedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`Retrait ${disbursementId} de ${disbursementAmount} F réussi pour ${userId}.`);

            } else if (disbursementStatus === 'failed') {
                // Échec : Le décaissement a échoué. Nous devons annuler la déduction de solde.
                const userRef = db.collection('users').doc(userId);
                const amountToRefund = transactionData.amount;
                
                await db.runTransaction(async (t) => {
                    const userSnap = await t.get(userRef);
                    if (!userSnap.exists) throw "Utilisateur non trouvé.";

                    const newBalance = (userSnap.data().balance || 0) + amountToRefund;
                    
                    // 1. Rembourser l'utilisateur
                    t.update(userRef, { balance: newBalance });
                    
                    // 2. Mettre à jour la transaction comme échouée
                    t.update(transactionDoc.ref, { 
                        status: 'failed',
                        error_reason: 'FedaPay Disbursement Failed',
                        refundedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                });
                console.warn(`Retrait ${disbursementId} échoué pour ${userId}. Solde remboursé.`);
            }

        } else {
            // Statuts intermédiaires (e.g., pending)
            return { statusCode: 200, body: `Statut non final pertinent: ${disbursementStatus}` };
        }
        
        return { statusCode: 200, body: "OK" };

    } catch (error) {
        console.error("Erreur fatale Webhook Décaissement:", error);
        return { statusCode: 500, body: "Erreur Serveur Interne" };
    }
};
