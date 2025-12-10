// netlify/functions/deposit_request.js
const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { FedaPay, Transaction } = require('fedapay');

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

// Configuration FedaPay
FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
FedaPay.setEnvironment('live');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, error: "Méthode non autorisée." }) };
    }

    try {
        const { uid, paymentMethodId, amount, currencyIso } = JSON.parse(event.body);

        if (!uid || !paymentMethodId || !amount) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Données manquantes." }) };
        }

        // Récupération du moyen de paiement
        const methodRef = db.collection('users').doc(uid)
            .collection('payment_methods').doc(paymentMethodId);

        const methodSnap = await methodRef.get();
        if (!methodSnap.exists) {
            return { statusCode: 404, body: JSON.stringify({ success: false, error: "Moyen de paiement introuvable." }) };
        }

        const method = methodSnap.data();

        if (!method.customerId) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Customer FedaPay manquant pour ce moyen de paiement." }) };
        }

        // Créer la transaction FedaPay
        const transaction = await Transaction.create({
            description: "Dépôt mobile money",
            amount,
            currency: { iso: currencyIso },
            callback_url: process.env.DEPOSIT_CALLBACK_URL,
            customer: { id: method.customerId },
            merchant_reference: `DEP-${uid}-${Date.now()}`,
            custom_metadata: { uid, paymentMethodId }
        });

        // Générer token
        const token = (await transaction.generateToken()).token;

        // Envoi du paiement mobile sans redirection
        await transaction.sendNowWithToken(
            method.operator, // mtn_open, moov, etc.
            token,
            {
                number: method.phone,  // numéro enregistré
                country: method.countryIso
            }
        );

        // 🔹 Stockage dans transactions (et non plus deposits)
        await db.collection('transactions').doc(String(transaction.id)).set({
            uid,
            type: "external",
            category: "deposit",
            amount,
            currencyIso,
            paymentMethodId,
            operator: method.operator,
            merchantReference: transaction.merchant_reference,
            transactionId: transaction.id,
            status: "pending",  // statut initial
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            metadata: {
                phone: method.phone,
                customerId: method.customerId,
                operator: method.operator
            }
        });

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                transactionId: transaction.id
            })
        };

    } catch (err) {
        console.error("Erreur dépôt :", err);
        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: "Erreur serveur." })
        };
    }
};