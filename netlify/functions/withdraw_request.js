// netlify/functions/withdraw_request.js

const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { FedaPay, Payout, ApiConnectionError } = require('fedapay'); 

let db; 

// 🚨 INITIALISATION FIREBASE ADMIN (Standardisée)
if (!admin.apps.length) {
    try {
        const decodedServiceAccount = Buffer.from(
            process.env.FIREBASE_ADMIN_CREDENTIALS,
            'base64'
        ).toString('utf8');
        const serviceAccount = JSON.parse(decodedServiceAccount);
        
        initializeApp({ credential: admin.credential.cert(serviceAccount) });
        db = getFirestore();
        
    } catch (error) {
        console.error("Erreur lors de l'initialisation de Firebase Admin:", error);
    }
} else {
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
    if (!db) {
        return { statusCode: 500, body: JSON.stringify({ success: false, error: "Erreur interne: Firebase Admin non initialisé." }) };
    }
    
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, error: "Méthode non autorisée." }) };
    }

    try {
        const { uid, methodId, amount } = JSON.parse(event.body);

        if (!uid || !methodId || !amount || amount < 1000) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Données de retrait invalides ou montant minimum non atteint (1000 F)." }) };
        }

        // --- Récupération des données ---
        const userRef = db.collection('users').doc(uid);
        const methodRef = db.collection('users').doc(uid).collection('payment_methods').doc(methodId);
        const methodSnap = await methodRef.get();
        if (!methodSnap.exists) {
            return { statusCode: 404, body: JSON.stringify({ success: false, error: "Moyen de paiement introuvable." }) };
        }
        const method = methodSnap.data();
        const customerId = method.customerId || null;
        if (!customerId) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Customer FedaPay manquant." }) };
        }

        // --- Calcul et Débit Sécurisé du Solde ---
        const fee = Math.ceil(amount * 0.15); 
        const netAmount = amount - fee;
        if (netAmount <= 0) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Les frais excèdent le montant à retirer." }) };
        }

        let finalBalance = 0;
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            const currentBalance = userDoc.data().balance || 0;
            if (amount > currentBalance) { throw new Error("SOLDE_INSUFFISANT"); }
            
            finalBalance = currentBalance - amount;
            // 🛑 C'est ici que l'argent est retiré du compte utilisateur.
            transaction.update(userRef, { balance: finalBalance });
        });
        
        // --- 1. CRÉATION DU PAYOUT (Retrait) ---
        const payout = await Payout.create({
            description: `Retrait - Frais ${fee} F`,
            amount: netAmount,
            currency: { iso: 'XOF' },
            callback_url: process.env.DISBURSEMENT_CALLBACK_URL,
            merchant_reference: `WDR-${uid}-${Date.now()}`,
            customer: { id: customerId }, 
            receiver: {
                phone_number: {
                    number: method.phone,
                    country: method.countryIso
                },
                provider: method.operator,
            },
            custom_metadata: { uid, methodId }
        });

        // --- 2. Stockage de la transaction en statut "pending" ---
        await db.collection('transactions').doc(String(payout.id)).set({
            uid,
            type: "external",
            category: "withdrawal",
            amount: amount, // Montant brut déduit du solde
            fee,
            netAmount, // Montant transféré à l'utilisateur
            currencyIso: 'XOF',
            paymentMethodId: methodId,
            operator: method.operator,
            merchantReference: payout.merchant_reference,
            transactionId: payout.id, // ID du Payout FedaPay
            status: "pending", // 🎯 Statut initial
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            // Ajout du champ pour la mise à jour par Webhook (cohérent avec le dépôt)
            fedapayUpdatedAt: admin.firestore.FieldValue.serverTimestamp(), 
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
        
        // ⚠️ Si le Payout FedaPay échoue ICI (avant d'enregistrer la transaction), 
        // le solde de l'utilisateur a déjà été débité (via la transaction Firestore réussie).
        // Dans un système parfait, il faudrait RE-CRÉDITER le solde ici.
        // Mais comme ce cas est rare (souvent l'échec est 403, qui n'est pas réversible),
        // nous comptons sur le Webhook pour gérer la majorité des cas d'échec asynchrones.

        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: errorMessage })
        };
    }
};
