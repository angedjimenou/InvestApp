// netlify/functions/deposit_request.js

const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { FedaPay, Customer, Transaction } = require('fedapay');

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
FedaPay.setEnvironment('live'); // Production uniquement

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, error: "Méthode non autorisée." }) };
    }

    try {
        const { uid, paymentMethodId, amount, currencyIso, description, merchantReference, customMetadata } = JSON.parse(event.body);

        if (!uid || !paymentMethodId || !amount || !currencyIso) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Données manquantes." }) };
        }

        // Récupérer le moyen de paiement
        const methodRef = db.collection('users').doc(uid).collection('payment_methods').doc(paymentMethodId);
        const methodSnap = await methodRef.get();
        if (!methodSnap.exists) {
            return { statusCode: 404, body: JSON.stringify({ success: false, error: "Moyen de paiement introuvable." }) };
        }
        const method = methodSnap.data();

        // Générer email fictif pour FedaPay
        const userEmail = `${uid}@investapp.local`;

        // Créer ou récupérer le Customer FedaPay
        let customerId = method.fedapayCustomerId || null;
        if (!customerId) {
            const customer = await Customer.create({
                firstname: method.firstName,
                lastname: method.lastName,
                email: userEmail,
                phone_number: {
                    number: method.phone, // Numéro tel complet, 0 inclus
                    country: method.countryIso
                }
            });
            customerId = customer.id;

            // Sauvegarder l'ID FedaPay pour réutilisation
            await methodRef.update({ fedapayCustomerId: customerId });
        }

        // Créer la transaction
        const transaction = await Transaction.create({
            description: description || 'Dépôt',
            amount: amount,
            currency: { iso: currencyIso },
            callback_url: process.env.DEPOSIT_CALLBACK_URL,
            mode: method.operator, // Opérateur conforme FedaPay
            customer: { id: customerId },
            merchant_reference: merchantReference || `DEP-${uid}-${Date.now()}`,
            custom_metadata: customMetadata || { uid }
        });

        // Générer le token de paiement
        const token = await transaction.generateToken();

        // Sauvegarder la transaction localement
        await db.collection('users').doc(uid).collection('deposits').add({
            transactionId: transaction.id,
            status: 'pending',
            amount,
            currencyIso,
            paymentMethodId,
            merchantReference: transaction.merchant_reference,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, tokenUrl: token.url })
        };

    } catch (error) {
        console.error("Erreur dépôt:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: "Erreur interne serveur." })
        };
    }
};