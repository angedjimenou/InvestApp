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

// FedaPay Live
FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
FedaPay.setEnvironment('live');

const MAX_METHODS = 3;

// Map opérateurs → FedaPay operator
const operatorMap = {
    "mtn_open": "mtn_open",
    "moov": "moov",
    "sbin": "sbin",
    "moov_tg": "moov_tg",
    "togocel": "togocel",
    "mtn_ci": "mtn_ci",
    "airtel_ne": "airtel_ne",
    "free_sn": "free_sn"
};

// Map opérateurs → ISO
const countryIsoMap = {
    "mtn_open": "bj",
    "moov": "bj",
    "sbin": "bj",
    "moov_tg": "tg",
    "togocel": "tg",
    "mtn_ci": "ci",
    "airtel_ne": "ne",
    "free_sn": "sn"
};

// Nettoyage nom/prénom → email propre
function cleanString(str) {
    return str
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // accents
        .replace(/[^a-zA-Z0-9]/g, "")    // caractères interdits
        .toLowerCase();
}

// Création / récupération customer FedaPay
async function getOrCreateCustomer(user, countryIso) {
    const ref = db.collection("users").doc(user.uid).collection("customer_fedapay").doc("customer");
    const snap = await ref.get();
    if (snap.exists) return snap.data();

    const firstnameClean = cleanString(user.firstName);
    const lastnameClean = cleanString(user.lastName);
    const email = `${firstnameClean}.${lastnameClean}@sabotinvest.site`;

    // Création Customer FedaPay
    const newCustomer = await Customer.create({
        firstname: user.firstName,
        lastname: user.lastName,
        email,
        phone_number: {
            number: user.phone,
            country: countryIso
        }
    });

    await ref.set({ id: newCustomer.id });

    return { id: newCustomer.id };
}

// Handler principal
exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, error: "Méthode non autorisée." }) };
    }

    try {
        const data = JSON.parse(event.body);
        const { uid, nickname, operator, firstName, lastName, phone } = data;

        if (!uid || !nickname || !operator || !firstName || !lastName || !phone) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Données manquantes." }) };
        }

        // Vérification limite
        const methodsRef = db.collection("users").doc(uid).collection("payment_methods");
        const existing = await methodsRef.get();
        if (existing.size >= MAX_METHODS) {
            return { statusCode: 403, body: JSON.stringify({ success: false, error: "Limite de 3 moyens de paiement." }) };
        }

        // Déduction ISO depuis opérateur
        const countryIso = countryIsoMap[operator] || "bj";

        // Customer FedaPay
        const customer = await getOrCreateCustomer({ uid, firstName, lastName, phone }, countryIso);

        // Méthode de paiement Firestore
        const newMethod = {
            nickname,
            operator: operatorMap[operator] || operator,
            firstName,
            lastName,
            phone,           // 🚩 Important : numéro local seul
            countryIso,      // 🚩 Déduit automatiquement
            customerId: customer.id,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await methodsRef.add(newMethod);

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: "Moyen de paiement enregistré.",
                method: newMethod
            })
        };

    } catch (err) {
        console.error("Erreur add_payment_method:", err);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: "Erreur interne du serveur." }) };
    }
};