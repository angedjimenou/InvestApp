// netlify/functions/fedapay_webhook.js

const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const crypto = require('crypto');

// Initialisation Firebase Admin
if (!admin.apps.length) {
    const decodedServiceAccount = Buffer.from(
        process.env.FIREBASE_ADMIN_CREDENTIALS,
        'base64'
    ).toString('utf8');
    const serviceAccount = JSON.parse(decodedServiceAccount);

    initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = getFirestore();

// Vérification de la signature FedaPay
const verifySignature = (payload, signature) => {
    const secret = process.env.FEDAPAY_WEBHOOK_SECRET;
    const hash = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return hash === signature;
};

exports.handler = async (event) => {
    try {
        if (event.httpMethod !== 'POST') {
            return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Méthode non autorisée.' }) };
        }

        const signature = event.headers['x-fedapay-signature'];
        if (!verifySignature(event.body, signature)) {
            return { statusCode: 403, body: JSON.stringify({ success: false, error: 'Signature invalide.' }) };
        }

        const data = JSON.parse(event.body);

        // ID de la transaction FedaPay
        const transactionId = data.id;
        const status = data.status; // pending, approved, declined, canceled, refunded, transferred, expired

        // Récupérer le dépôt correspondant dans Firestore
        const depositRef = db.collection('deposits').doc(transactionId);
        const depositDoc = await depositRef.get();

        if (!depositDoc.exists) {
            return { statusCode: 404, body: JSON.stringify({ success: false, error: 'Dépôt non trouvé.' }) };
        }

        // Mettre à jour le statut du dépôt
        await depositRef.update({
            status: status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Actions internes selon le statut
        if (status === 'approved') {
            const depositData = depositDoc.data();
            const userRef = db.collection('users').doc(depositData.uid);
            await userRef.update({
                balance: admin.firestore.FieldValue.increment(depositData.amount)
            });
            // Ici tu peux notifier l’admin ou l’utilisateur si nécessaire
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true })
        };

    } catch (error) {
        console.error('Erreur webhook FedaPay:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: 'Erreur interne serveur.' })
        };
    }
};