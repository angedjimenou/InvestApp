// netlify/functions/add_payment_method.js
const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { FedaPay, Customer } = require('fedapay');

// Initialisation Firebase Admin
if (!admin.apps.length) {
    const decodedServiceAccount = Buffer.from(process.env.FIREBASE_ADMIN_CREDENTIALS, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(decodedServiceAccount);
    initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = getFirestore();

// Configuration FedaPay live
FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
FedaPay.setEnvironment('live'); // live uniquement

const MAX_METHODS = 3;

// Correspondance opérateurs FedaPay
const operatorMap = {
    "MTN Bénin": "mtn_open",
    "Moov Bénin": "moov",
    "Celtiis": "sbin",
    "Moov Togo": "moov_tg",
    "Mixx By Yas": "togocel",
    "MTN Côte d'Ivoire": "mtn_ci",
    "Airtel Niger": "airtel_ne",
    "Free Senegal": "free_sn"
};

// Fonction pour créer ou récupérer le Customer FedaPay
async function getOrCreateCustomer(user) {
    const customerRef = db.collection('users').doc(user.uid).collection('customer_fedapay').doc('customer');
    const customerSnap = await customerRef.get();
    if (customerSnap.exists) return customerSnap.data();

    // Création d'email fictif unique
    const emailFictif = `${user.firstName}.${user.lastName}@investapp.local`.toLowerCase();

    // Création du customer chez FedaPay
    const newCustomer = await Customer.create({
        firstname: user.firstName,
        lastname: user.lastName,
        email: emailFictif,
        phone_number: {
            number: user.phone,
            country: user.countryIso
        }
    });

    await customerRef.set({ id: newCustomer.id });
    return { id: newCustomer.id };
}

// Handler principal
exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, error: "Méthode non autorisée." }) };
    }

    try {
        const { uid, nickname, operator, firstName, lastName, phone } = JSON.parse(event.body);

        if (!uid || !nickname || !operator || !firstName || !lastName || !phone) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Données manquantes." }) };
        }

        const methodsRef = db.collection("users").doc(uid).collection("payment_methods");
        const snapshot = await methodsRef.get();
        if (snapshot.size >= MAX_METHODS) {
            return { statusCode: 403, body: JSON.stringify({ success: false, error: `Limite de moyens de paiement atteinte (${MAX_METHODS}).` }) };
        }

        // Déduction automatique du code ISO
        const countryIso = user.countryIso; // à calculer ou passer dans body

        // Création ou récupération du customer FedaPay
        const customer = await getOrCreateCustomer({ uid, firstName, lastName, phone, countryIso });

        // Ajout du moyen de paiement
        const newMethod = {
            nickname,
            operator: operatorMap[operator] || operator,
            firstName,
            lastName,
            phone,
            countryIso,
            customerId: customer.id,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await methodsRef.add(newMethod);

        return { statusCode: 200, body: JSON.stringify({ success: true, message: "Moyen de paiement enregistré.", method: newMethod }) };

    } catch (error) {
        console.error("Erreur serveur Netlify:", error);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: "Erreur interne du serveur." }) };
    }
};