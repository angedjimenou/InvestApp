// netlify/functions/deposit_request.js

const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const FedaPay = require('fedapay').default || require('fedapay'); 

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

// Initialisation de FedaPay
FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY); 
FedaPay.setEnvironment('live'); // Remplacez par 'sandbox' si vous êtes en phase de test

// URL du webhook qui sera appelé par FedaPay pour confirmer le paiement
// UTILISEZ UNE VARIABLE D'ENVIRONNEMENT NETLIFY POUR CELA
const WEBHOOK_URL = process.env.DEPOSIT_CALLBACK_URL; 
const DESCRIPTION = "Dépôt sur Sabot Invest";


exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, error: "Méthode non autorisée." }) };
    }

    try {
        const { uid, amount, operator, senderPhone } = JSON.parse(event.body);

        if (!uid || !amount || amount < 500 || !operator || !senderPhone) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Données de transaction invalides." }) };
        }

        if (!WEBHOOK_URL) {
             console.error("Variable DEPOSIT_CALLBACK_URL manquante.");
             return { statusCode: 500, body: JSON.stringify({ success: false, error: "Erreur serveur: URL de rappel de dépôt non configurée." }) };
        }
        
        // 1. Appel de l'API FedaPay pour créer la transaction
        const transaction = await FedaPay.Transaction.create({
            description: DESCRIPTION,
            amount: amount,
            currency: { code: 'XOF' },
            callback_url: WEBHOOK_URL, // Utilisation de la variable d'environnement
            customer: {
                phone: senderPhone 
            }
        });

        // 2. Enregistrement de la transaction en statut 'pending' dans Firestore
        await db.collection("transactions").add({
            uid: uid,
            type: 'deposit',
            amount: amount,
            status: 'pending',
            operator: operator,
            senderPhone: senderPhone,
            fedapay_id: transaction.id, 
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // 3. Réponse au client
        // NOTE: FedaPay initie le paiement sur le téléphone associé au senderPhone
        return {
            statusCode: 200,
            body: JSON.stringify({ 
                success: true, 
                message: "Transaction initiée",
                // Si FedaPay vous renvoie une URL pour une étape supplémentaire, utilisez-la ici:
                // payment_url: transaction.url 
            })
        };

    } catch (error) {
        console.error("Erreur FedaPay ou Firestore:", error);
        let errorMessage = "Erreur interne lors du traitement du dépôt.";
        
        if (error.message) {
            errorMessage = error.message; 
        }

        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: errorMessage })
        };
    }
};
