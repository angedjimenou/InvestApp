// netlify/functions/withdraw_request.js

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

// Configuration FedaPay
FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
FedaPay.setEnvironment('live');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, error: "Méthode non autorisée." }) };
    }

    try {
        const { uid, methodId, amount } = JSON.parse(event.body);

        if (!uid || !methodId || !amount) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Données manquantes." }) };
        }

        // Minimum de retrait
        if (amount < 1000) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Le montant minimum de retrait est de 1000 F." }) };
        }

        // Récupérer le solde de l'utilisateur
        const userRef = db.collection('users').doc(uid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) {
            return { statusCode: 404, body: JSON.stringify({ success: false, error: "Utilisateur introuvable." }) };
        }
        const userData = userSnap.data();
        const userBalance = userData.balance || 0;

        if (amount > userBalance) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Solde insuffisant pour ce retrait." }) };
        }

        // Récupération du moyen de paiement
        const methodRef = db.collection('users').doc(uid).collection('payment_methods').doc(methodId);
        const methodSnap = await methodRef.get();
        if (!methodSnap.exists) {
            return { statusCode: 404, body: JSON.stringify({ success: false, error: "Moyen de paiement introuvable." }) };
        }
        const method = methodSnap.data();

        // Calcul des frais
        const fee = Math.floor(amount * 0.15); // 15%
        const netAmount = amount - fee;

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
                    number: method.phone,
                    country: method.countryIso
                }
            });
            customerId = customer.id;
            await methodRef.update({ fedapayCustomerId: customerId });
        }

        // Créer la transaction FedaPay sur le montant net
        const transaction = await Transaction.create({
            description: `Retrait - Frais ${fee} F`,
            amount: netAmount,
            currency: { iso: 'XOF' },
            callback_url: process.env.DISBURSEMENT_CALLBACK_URL,
            mode: method.operator,
            customer: { id: customerId },
            merchant_reference: `WDR-${uid}-${Date.now()}`,
            custom_metadata: { uid }
        });

        // Mettre à jour le solde utilisateur
        await userRef.update({ balance: userBalance - amount });

        // Sauvegarde de la transaction dans Firestore
        await db.collection('users').doc(uid).collection('withdrawals').add({
            transactionId: transaction.id,
            status: 'pending',
            amount,
            fee,
            netAmount,
            paymentMethodId: methodId,
            merchantReference: transaction.merchant_reference,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                success: true, 
                transactionId: transaction.id,
                amount,
                fee,
                netAmount
            })
        };

    } catch (error) {
        console.error("Erreur retrait:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: "Erreur interne serveur." })
        };
    }
};
