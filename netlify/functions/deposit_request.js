// netlify/functions/deposit_request.js
const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { FedaPay, Transaction, Customer } = require('fedapay');

// Initialisation Firebase Admin
if (!admin.apps.length) {
    const decodedServiceAccount = Buffer.from(process.env.FIREBASE_ADMIN_CREDENTIALS, 'base64').toString('utf8');
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

        // Récupération du moyen de paiement depuis Firestore
        const methodSnap = await db.collection('users').doc(uid)
            .collection('payment_methods').doc(paymentMethodId).get();

        if (!methodSnap.exists) {
            return { statusCode: 404, body: JSON.stringify({ success: false, error: "Moyen de paiement introuvable." }) };
        }

        const method = methodSnap.data();

        // 1. Création d'un nouveau Customer FedaPay à chaque transaction
        const customer = await Customer.create({
            firstname: method.firstName || "Client",
            lastname: method.lastName || "Sabot",
            email: `${uid}.${Date.now()}@sabotinvest.site`,
            phone_number: {
                number: method.phone,
                country: method.countryIso
            }
        });

        // 2. Création de la transaction avec l'ID du nouveau customer
        const transaction = await Transaction.create({
            description: "Dépôt mobile money",
            amount,
            currency: { iso: currencyIso },
            callback_url: process.env.DEPOSIT_CALLBACK_URL,
            customer: { id: customer.id }, // Structure correcte
            merchant_reference: `DEP-${uid}-${Date.now()}`,
            custom_metadata: { uid, paymentMethodId }
        });

        // 3. Génération du token et envoi du push MMS
        const token = (await transaction.generateToken()).token;

        await transaction.sendNowWithToken(
            method.operator,
            token,
            {
                number: method.phone,
                country: method.countryIso
            }
        );

        // 4. Enregistrement dans la collection transactions
        await db.collection('transactions').doc(String(transaction.id)).set({
            uid,
            type: "external",
            category: "deposit",
            amount,
            currencyIso,
            paymentMethodId,
            operator: method.operator,
            transactionId: transaction.id,
            status: "pending",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            metadata: {
                phone: method.phone,
                customerId: customer.id
            }
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, transactionId: transaction.id })
        };

    } catch (err) {
        console.error("Erreur dépôt :", err);
        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: err.message })
        };
    }
};
