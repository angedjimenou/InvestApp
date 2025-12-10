// netlify/functions/withdraw_request.js

const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { FedaPay, Payout, ApiConnectionError } = require('fedapay'); 

let db; // Déclarer la référence Firestore dans le scope du module

// 🚨 INITIALISATION FIREBASE ADMIN (CORRIGÉE pour éviter l'erreur 'app/no-app' sur Netlify)
if (!admin.apps.length) {
    try {
        const decodedServiceAccount = Buffer.from(
            process.env.FIREBASE_ADMIN_CREDENTIALS,
            'base64'
        ).toString('utf8');
        const serviceAccount = JSON.parse(decodedServiceAccount);
        
        // 1. Initialiser l'application
        initializeApp({ credential: admin.credential.cert(serviceAccount) });
        
        // 2. Récupérer la référence Firestore juste après l'initialisation
        db = getFirestore();
        
    } catch (error) {
        console.error("Erreur lors de l'initialisation de Firebase Admin:", error);
    }
} else {
    // Si l'application existe déjà (réutilisation du conteneur)
    try {
        db = getFirestore();
    } catch (error) {
         console.error("Erreur lors de la récupération de getFirestore sur l'application existante:", error);
    }
}

// Configuration FedaPay
FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
FedaPay.setEnvironment('live');

exports.handler = async (event) => {
    // Vérification de l'initialisation DB
    if (!db) {
        return { statusCode: 500, body: JSON.stringify({ success: false, error: "Erreur interne: Firebase Admin non initialisé. Vérifiez les logs de démarrage." }) };
    }
    
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, error: "Méthode non autorisée." }) };
    }

    try {
        const { uid, methodId, amount } = JSON.parse(event.body);

        if (!uid || !methodId || !amount || amount < 1000) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Données de retrait invalides ou montant minimum non atteint (1000 F)." }) };
        }

        // Récupération des références
        const userRef = db.collection('users').doc(uid);
        const methodRef = db.collection('users').doc(uid).collection('payment_methods').doc(methodId);
        
        const methodSnap = await methodRef.get();
        if (!methodSnap.exists) {
            return { statusCode: 404, body: JSON.stringify({ success: false, error: "Moyen de paiement introuvable." }) };
        }
        const method = methodSnap.data();
        
        // 1. Vérification du Customer ID (Aligné sur la logique de dépôt)
        const customerId = method.customerId || null;
        if (!customerId) {
            return { 
                statusCode: 400, 
                body: JSON.stringify({ success: false, error: "Customer FedaPay manquant pour ce moyen de paiement." }) 
            };
        }

        // Calcul des frais et montant net
        const fee = Math.ceil(amount * 0.15); 
        const netAmount = amount - fee;
        if (netAmount <= 0) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Les frais excèdent le montant à retirer." }) };
        }

        // 2. SÉCURISATION DU SOLDE VIA TRANSACTION FIRESTORE
        let finalBalance = 0;
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            
            const currentBalance = userDoc.data().balance || 0;
            if (amount > currentBalance) { throw new Error("SOLDE_INSUFFISANT"); }
            
            finalBalance = currentBalance - amount;
            transaction.update(userRef, { balance: finalBalance });
        });
        
        // 3. CRÉATION DU PAYOUT (Retrait)
        const payout = await Payout.create({
            description: `Retrait - Frais ${fee} F`,
            amount: netAmount,
            currency: { iso: 'XOF' },
            callback_url: process.env.DISBURSEMENT_CALLBACK_URL,
            merchant_reference: `WDR-${uid}-${Date.now()}`,
            
            // 🚨 CORRECTION : AJOUT DE L'OBJET 'customer' avec l'ID
            customer: { id: customerId }, 
            
            // Détails du destinataire (nécessaire pour le Payout)
            receiver: {
                phone_number: {
                    number: method.phone,
                    country: method.countryIso
                },
                provider: method.operator,
            },
            
            custom_metadata: { uid, methodId }
        });

        // 4. Sauvegarde de la transaction dans Firestore
        await db.collection('transactions').doc(String(payout.id)).set({
            uid,
            type: "external",
            category: "withdrawal",
            amount: amount, 
            fee,
            netAmount, 
            currencyIso: 'XOF',
            paymentMethodId: methodId,
            operator: method.operator,
            merchantReference: payout.merchant_reference,
            transactionId: payout.id, // ID du Payout
            status: "pending", 
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                success: true, 
                transactionId: payout.id,
                amount,
                fee,
                netAmount,
                newBalance: finalBalance
            })
        };

    } catch (error) {
        console.error("Erreur retrait:", error);
        
        // Gestion de l'erreur SOLDE_INSUFFISANT
        if (error.message === "SOLDE_INSUFFISANT") {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Solde insuffisant pour ce retrait." }) };
        }
        
        // Gestion des erreurs FedaPay (ApiConnectionError)
        let errorMessage = "Erreur interne serveur.";
        if (error instanceof ApiConnectionError && error.errorMessage) {
            errorMessage = `Erreur FedaPay: ${error.errorMessage}. Veuillez réessayer.`;
        }

        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: errorMessage })
        };
    }
};
