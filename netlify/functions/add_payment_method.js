// netlify/functions/add_payment_method.js

const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Initialisation de Firebase Admin SDK (CORRECTION Base64)
if (!admin.apps.length) {
    // 1. Décodage de la chaîne Base64
    const decodedServiceAccount = Buffer.from(
        process.env.FIREBASE_ADMIN_CREDENTIALS,
        'base64'
    ).toString('utf8');

    // 2. Parsage du JSON décodé
    const serviceAccount = JSON.parse(decodedServiceAccount);
    
    initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = getFirestore();

const MAX_METHODS = 3;

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, error: "Méthode non autorisée." }) };
    }

    try {
        const { uid, nickname, operator, fullPhoneNumber, fullName } = JSON.parse(event.body);

        if (!uid || !nickname || !operator || !fullPhoneNumber || !fullName) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Données manquantes." }) };
        }

        const methodsRef = db.collection("users").doc(uid).collection("payment_methods");
        
        // Vérification sécurisée de la limite
        const snapshot = await methodsRef.get();
        if (snapshot.size >= MAX_METHODS) {
            return { statusCode: 403, body: JSON.stringify({ success: false, error: `Limite de moyens de paiement atteinte (${MAX_METHODS}).` }) };
        }

        // Écriture sécurisée des données
        await methodsRef.add({
            nickname: nickname,
            operator: operator,
            fullPhoneNumber: fullPhoneNumber,
            fullName: fullName,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, message: "Moyen de paiement enregistré." })
        };

    } catch (error) {
        console.error("Erreur serveur Netlify:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: "Erreur interne du serveur." })
        };
    }
};
