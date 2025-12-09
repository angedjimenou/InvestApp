// netlify/functions/fedapay_disbursement_webhook.js

const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const crypto = require('crypto');

if (!admin.apps.length) {
    const decodedServiceAccount = Buffer.from(
        process.env.FIREBASE_ADMIN_CREDENTIALS,
        'base64'
    ).toString('utf8');
    const serviceAccount = JSON.parse(decodedServiceAccount);
    initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = getFirestore();

// Vérifier la signature du webhook
function verifyWebhookSignature(reqBody, signature) {
    const secret = process.env.FEDAPAY_WEBHOOK_SECRET;
    const hash = crypto.createHmac('sha256', secret).update(reqBody).digest('hex');
    return hash === signature;
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, error: "Méthode non autorisée." }) };
    }

    try {
        const signature = event.headers['x-fedapay-signature'];
        if (!verifyWebhookSignature(event.body, signature)) {
            return { statusCode: 403, body: JSON.stringify({ success: false, error: "Signature invalide." }) };
        }

        const payload = JSON.parse(event.body);
        const transactionId = payload.data.id;
        const status = payload.data.status; // pending, approved, declined, canceled, refunded, transferred, expired
        const merchantReference = payload.data.merchant_reference;
        const uid = payload.data.custom_metadata?.uid;

        if (!uid || !transactionId) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Données manquantes." }) };
        }

        // Trouver le retrait correspondant dans Firestore
        const withdrawalsRef = db.collection('users').doc(uid).collection('withdrawals');
        const snapshot = await withdrawalsRef.where('transactionId', '==', transactionId).get();

        if (snapshot.empty) {
            return { statusCode: 404, body: JSON.stringify({ success: false, error: "Transaction non trouvée." }) };
        }

        // Mettre à jour le statut
        snapshot.forEach(async doc => {
            await doc.ref.update({
                status: status,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // Actions internes selon le statut
            if (status === 'approved') {
                console.log(`Retrait ${transactionId} approuvé, montant crédité côté admin ou déclencher notification.`);
            } else if (status === 'declined' || status === 'canceled') {
                console.log(`Retrait ${transactionId} échoué ou annulé.`);
            }
        });

        return { statusCode: 200, body: JSON.stringify({ success: true }) };

    } catch (error) {
        console.error("Erreur webhook retrait:", error);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: "Erreur interne serveur." }) };
    }
};