// netlify/functions/fedapay_webhook.js
const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// Initialisation Firebase Admin SDK
if (!admin.apps.length) {
    const decodedServiceAccount = Buffer.from(
        process.env.FIREBASE_ADMIN_CREDENTIALS,
        'base64'
    ).toString('utf8');
    const serviceAccount = JSON.parse(decodedServiceAccount);
    initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = getFirestore();

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ success: false, error: "Méthode non autorisée." })
        };
    }

    try {
        const payload = JSON.parse(event.body);
        const eventType = payload.type;  // ex: transaction.canceled
        const transactionData = payload.data;

        console.log("FedaPay Event Received:", eventType, transactionData);

        // Seulement traiter les transactions liées aux dépôts
        if (!transactionData || !transactionData.id) {
            return {
                statusCode: 400,
                body: JSON.stringify({ success: false, error: "Transaction invalide." })
            };
        }

        let statusToSet = "pending";

        if (eventType === "transaction.approved" || eventType === "payment_request.approved") {
            statusToSet = "approved";
        } else if (eventType === "transaction.declined" || eventType === "payment_request.declined") {
            statusToSet = "declined";
        } else if (eventType === "transaction.canceled" || eventType === "payment_request.canceled") {
            statusToSet = "canceled";
        }

        const txRef = db.collection("transactions").doc(String(transactionData.id));

        // Mettre à jour le document avec merge: true
        await txRef.set({
            status: statusToSet,
            amount: transactionData.amount,
            currencyIso: transactionData.currency?.iso || "XOF",
            uid: transactionData.custom_metadata?.uid || transactionData.uid || null,
            paymentMethodId: transactionData.custom_metadata?.paymentMethodId || transactionData.paymentMethodId || null,
            operator: transactionData.operator || null,
            merchantReference: transactionData.merchant_reference || null,
            phone: transactionData.phone || null,
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });

        console.log(`Transaction ${transactionData.id} mise à jour avec status: ${statusToSet}`);

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true })
        };

    } catch (err) {
        console.error("Erreur webhook FedaPay :", err);
        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: "Erreur serveur." })
        };
    }
};