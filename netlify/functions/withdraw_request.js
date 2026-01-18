// netlify/functions/withdraw_request.js
const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { FedaPay, Payout, Customer, ApiConnectionError } = require('fedapay'); 

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
        const { uid, methodId, amount } = JSON.parse(event.body);
        if (!uid || !methodId || amount < 1000) throw new Error("Données invalides.");

        const userRef = db.collection('users').doc(uid);
        const methodSnap = await userRef.collection('payment_methods').doc(methodId).get();
        const userData = (await userRef.get()).data();

        if (!methodSnap.exists) return { statusCode: 404, body: JSON.stringify({ error: "Méthode introuvable" }) };
        const methodData = methodSnap.data();

        if (userData.balance < amount) throw new Error("Fonds insuffisants.");
        if (!userData.firstInvestmentDone) return { statusCode: 403, body: JSON.stringify({ error: "Premier investissement requis." }) };

        // 1. CRÉATION DU CUSTOMER À LA VOLÉE
        const customer = await Customer.create({
            firstname: methodData.firstName,
            lastname: methodData.lastName,
            email: `${uid}.${Date.now()}@invest.bj`,
            phone_number: { number: methodData.phone, country: methodData.countryIso }
        });

        const fee = Math.ceil(amount * 0.15); 
        const netAmount = amount - fee;

        // 2. CRÉATION DU PAYOUT AVEC LE NOUVEAU CUSTOMER
        const payout = await Payout.create({
            description: `Retrait ${netAmount} F`,
            amount: netAmount, 
            currency: { iso: 'XOF' },
            customer: { id: customer.id }, 
            receiver: {
                phone_number: { number: methodData.phone, country: methodData.countryIso },
                provider: methodData.operator,
            },
            custom_metadata: { uid, methodId }
        });

        // 3. TRANSACTION FIRESTORE
        const payoutId = String(payout.id);
        await db.runTransaction(async (t) => {
            t.update(userRef, { balance: userData.balance - amount });
            t.set(db.collection('transactions').doc(payoutId), {
                uid, type: 'external', category: 'withdrawal', amount, fee, netAmount,
                status: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        return { statusCode: 200, body: JSON.stringify({ success: true, payoutId, newBalance: userData.balance - amount }) };

    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ success: false, error: error.message }) };
    }
};
        };
    }
};
