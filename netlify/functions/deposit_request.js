// netlify/functions/deposit_request.js
const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { FedaPay, Transaction, Customer } = require('fedapay');

if (!admin.apps.length) {
    const decodedServiceAccount = Buffer.from(process.env.FIREBASE_ADMIN_CREDENTIALS, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(decodedServiceAccount);
    initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = getFirestore();

FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
FedaPay.setEnvironment('live');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ success: false }) };

    try {
        const { uid, paymentMethodId, amount, currencyIso } = JSON.parse(event.body);

        const methodSnap = await db.collection('users').doc(uid).collection('payment_methods').doc(paymentMethodId).get();
        if (!methodSnap.exists) return { statusCode: 404, body: "Méthode introuvable" };
        const method = methodSnap.data();

        // 1. CRÉATION DU CLIENT À LA VOLÉE AVEC LE NUMÉRO SPÉCIFIQUE
        const customer = await Customer.create({
            firstname: method.firstName,
            lastname: method.lastName,
            email: `${uid}.${Date.now()}@invest.bj`,
            phone_number: { number: method.phone, country: method.countryIso }
        });

        // 2. CRÉATION DE LA TRANSACTION
        const transaction = await Transaction.create({
            description: "Dépôt mobile money",
            amount,
            currency: { iso: currencyIso },
            callback_url: process.env.DEPOSIT_CALLBACK_URL,
            customer_id: customer.id,
            merchant_reference: `DEP-${uid}-${Date.now()}`,
            custom_metadata: { uid, paymentMethodId }
        });

        const token = (await transaction.generateToken()).token;

        await transaction.sendNowWithToken(method.operator, token, {
            number: method.phone,
            country: method.countryIso
        });

        await db.collection('transactions').doc(String(transaction.id)).set({
            uid,
            type: "external",
            category: "deposit",
            amount,
            currencyIso,
            paymentMethodId,
            operator: method.operator,
            status: "pending",
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return { statusCode: 200, body: JSON.stringify({ success: true, transactionId: transaction.id }) };
    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ success: false, error: err.message }) };
    }
};
