// netlify/functions/deposit_request.js

const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { FedaPay, Customer, Transaction } = require('fedapay');

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

        // Générer email fictif (obligation FedaPay)
        const email = `${uid}@investapp.local`;

        // Vérifier création Customer FedaPay
        let customerId = method.fedapayCustomerId || null;
        if (!customerId) {
            const customer = await Customer.create({
                firstname: method.firstName,
                lastname: method.lastName,
                email,
                phone_number: {
                    number: method.phone,
                    country: method.countryIso
                }
            });

            customerId = customer.id;
            await methodRef.update({ fedapayCustomerId: customerId });
        }

        // Créer la collecte de paiement
        const transaction = await Transaction.create({
            description: "Dépôt mobile money",
            amount,
            currency: { iso: currencyIso },
            callback_url: process.env.DEPOSIT_CALLBACK_URL,
            customer: { id: customerId },
            merchant_reference: `DEP-${uid}-${Date.now()}`,
            custom_metadata: { uid }
        });

        // Générer token
        const token = (await transaction.generateToken()).token;

        // ❗ENVOI DE LA DEMANDE MOBILE (ce qui manquait)
        await transaction.sendNowWithToken(
            method.operator,  // mtn, moov, etc.
            token,
            {
                number: method.phone,
                country: method.countryIso
            }
        );

        // Stockage Firestore
        await db.collection('deposits').doc(String(transaction.id)).set({
            transactionId: transaction.id,
            status: "pending",
            amount,
            currencyIso,
            uid,
            paymentMethodId,
            operator: method.operator,
            merchantReference: transaction.merchant_reference,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
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