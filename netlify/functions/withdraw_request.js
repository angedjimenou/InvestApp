const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { FedaPay, Payout, Customer } = require('fedapay'); 

// Initialisation unique
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(Buffer.from(process.env.FIREBASE_ADMIN_CREDENTIALS, 'base64').toString()))
    });
}
const db = getFirestore();
FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
FedaPay.setEnvironment('live');

exports.handler = async (event) => {
    try {
        const { uid, methodId, amount } = JSON.parse(event.body);
        
        // 1. Récupération des données
        const userRef = db.collection('users').doc(uid);
        const methodSnap = await userRef.collection('payment_methods').doc(methodId).get();
        const userData = (await userRef.get()).data();

        if (!methodSnap.exists || userData.balance < amount) throw new Error("Données invalides ou solde insuffisant.");
        const method = methodSnap.data();

        // 2. Création du Customer (systématique pour le numéro choisi)
        const customer = await Customer.create({
            firstname: method.firstName,
            lastname: method.lastName,
            email: `${uid}.${Date.now()}@sabot.site`,
            phone_number: { number: method.phone, country: method.countryIso }
        });

        // 3. Exécution immédiate du Payout
        const payout = await Payout.create({
            amount: amount - Math.ceil(amount * 0.15),
            currency: { iso: 'XOF' },
            customer: { id: customer.id },
            receiver: {
                phone_number: { number: method.phone, country: method.countryIso },
                provider: method.operator
            }
        });

        // 4. Envoi réel des fonds (Action systématique)
        await payout.send();

        // 5. Mise à jour Firestore
        await userRef.update({ balance: admin.firestore.FieldValue.increment(-amount) });
        await db.collection('transactions').doc(String(payout.id)).set({
            uid, amount, status: 'sent', createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
};
