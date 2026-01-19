// netlify/functions/withdraw_request.js
const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { FedaPay, Payout, Customer, ApiConnectionError } = require('fedapay'); 

let db; 

if (!admin.apps.length) {
    try {
        const decodedServiceAccount = Buffer.from(process.env.FIREBASE_ADMIN_CREDENTIALS, 'base64').toString('utf8');
        const serviceAccount = JSON.parse(decodedServiceAccount);
        initializeApp({ credential: admin.credential.cert(serviceAccount) });
        db = getFirestore(); 
    } catch (error) {
        console.error("Erreur Firebase Admin:", error);
    }
} else {
    db = getFirestore();
}

FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
FedaPay.setEnvironment('live'); 

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ success: false }) };
    if (!db) return { statusCode: 500, body: JSON.stringify({ error: "DB non initialisée" }) };

    try {
        const { uid, methodId, amount } = JSON.parse(event.body);
        if (!uid || !methodId || typeof amount !== 'number' || amount < 1000) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Données invalides." }) };
        }

        const userRef = db.collection('users').doc(uid);
        const methodRef = userRef.collection('payment_methods').doc(methodId);
        const [userDoc, methodSnap] = await Promise.all([userRef.get(), methodRef.get()]);

        if (!userDoc.exists || !methodSnap.exists) throw new Error("Utilisateur ou méthode introuvable.");
        
        const userData = userDoc.data();
        const methodData = methodSnap.data();

        if (userData.balance < amount) throw new Error("Fonds insuffisants.");
        if (!userData.firstInvestmentDone) throw new Error("FIRST_INVESTMENT_REQUIRED");

        // --- 4. CRÉATION DU CUSTOMER À LA VOLÉE (POUR LE BON NUMÉRO) ---
        const customer = await Customer.create({
            firstname: methodData.firstName || "Client",
            lastname: methodData.lastName || "Sabot",
            email: `${uid}.${Date.now()}@sabotinvest.site`,
            phone_number: { number: methodData.phone, country: methodData.countryIso }
        });

        const fee = Math.ceil(amount * 0.15); 
        const netAmount = amount - fee;

        // --- 5. CRÉATION DU PAYOUT ---
        const payout = await Payout.create({
            description: `Retrait ${netAmount} F`,
            amount: netAmount, 
            currency: { iso: 'XOF' },
            callback_url: process.env.DISBURSEMENT_CALLBACK_URL,
            customer: { id: customer.id }, 
            receiver: {
                phone_number: { number: methodData.phone, country: methodData.countryIso },
                provider: methodData.operator,
            },
            custom_metadata: { uid, methodId }
        });

        // --- 6. TRANSACTION ATOMIQUE ---
        const payoutId = String(payout.id);
        await db.runTransaction(async (transaction) => {
            transaction.update(userRef, { balance: userData.balance - amount });
            transaction.set(db.collection('transactions').doc(payoutId), {
                uid, type: 'external', category: 'withdrawal', amount, fee, netAmount,
                status: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp(),
                payoutId, operator: methodData.operator
            });
        });

        return { statusCode: 200, body: JSON.stringify({ success: true, payoutId, newBalance: userData.balance - amount }) };

    } catch (error) {
        console.error("Erreur:", error.message);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: error.message }) };
    }
};
