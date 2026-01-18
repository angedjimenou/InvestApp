// netlify/functions/add_payment_method.js
const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

if (!admin.apps.length) {
    const decodedServiceAccount = Buffer.from(process.env.FIREBASE_ADMIN_CREDENTIALS, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(decodedServiceAccount);
    initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = getFirestore();

const MAX_METHODS = 3;

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

        const methodsRef = db.collection("users").doc(uid).collection("payment_methods");
        const existing = await methodsRef.get();
        if (existing.size >= MAX_METHODS) {
            return { statusCode: 403, body: JSON.stringify({ success: false, error: "Limite atteinte." }) };
        }

        const countryIso = countryIsoMap[operator] || "bj";

        const newMethod = {
            nickname,
            operator: operatorMap[operator] || operator,
            firstName,
            lastName,
            phone,
            countryIso,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await methodsRef.add(newMethod);

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, message: "Moyen de paiement enregistré.", method: newMethod })
        };

    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ success: false, error: "Erreur serveur." }) };
    }
};
