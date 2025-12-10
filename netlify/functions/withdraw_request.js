// netlify/functions/withdraw_request.js
const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { FedaPay, Transaction, ApiConnectionError } = require('fedapay'); 

// Initialisation Firebase Admin SDK
if (!admin.apps.length) {
    const decodedServiceAccount = Buffer.from(
        process.env.FIREBASE_ADMIN_CREDENTIALS,
        'base64'
    ).toString('utf8');
    const serviceAccount = JSON.parse(decodedServiceAccount);
    initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = getFirestore();

// Configuration FedaPay
FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
FedaPay.setEnvironment('live');

exports.handler = async (event) => {
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
        
        // Récupération de la méthode de paiement
        const methodSnap = await methodRef.get();
        if (!methodSnap.exists) {
            return { statusCode: 404, body: JSON.stringify({ success: false, error: "Moyen de paiement introuvable." }) };
        }
        const method = methodSnap.data();
        
        // 1. Vérification du Customer ID (comme dans deposit_request.js)
        const customerId = method.customerId || null;
        
        if (!customerId) {
            // 📌 Échec si l'ID client FedaPay est manquant (comme le dépôt)
            return { 
                statusCode: 400, // Statut 400 pour "mauvaise requête/données manquantes"
                body: JSON.stringify({ 
                    success: false, 
                    error: "Customer FedaPay manquant pour ce moyen de paiement. Veuillez reconfigurer (Code W1)." 
                }) 
            };
        }

        // Calcul des frais (maintenu à 15% pour l'exemple)
        const fee = Math.ceil(amount * 0.15); 
        const netAmount = amount - fee;

        if (netAmount <= 0) {
             return { statusCode: 400, body: JSON.stringify({ success: false, error: "Les frais excèdent le montant à retirer." }) };
        }

        // 2. SÉCURISATION DU SOLDE VIA TRANSACTION FIRESTORE
        // Nécessaire pour éviter les doubles retraits
        let finalBalance = 0;
        
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throw new Error("Utilisateur introuvable pour la transaction.");
            }
            const currentBalance = userDoc.data().balance || 0;

            if (amount > currentBalance) {
                throw new Error("SOLDE_INSUFFISANT"); 
            }

            finalBalance = currentBalance - amount;
            transaction.update(userRef, { balance: finalBalance });
        });
        
        // 3. CRÉATION DE LA TRANSACTION FEDAPAY (Retrait/Disbursement)
        const fedapayTransaction = await Transaction.create({
            description: `Retrait - Frais ${fee} F`,
            amount: netAmount,
            currency: { iso: 'XOF' },
            callback_url: process.env.DISBURSEMENT_CALLBACK_URL,
            mode: method.operator, 
            customer: { id: customerId }, // Utilisation de l'ID Customer FedaPay trouvé
            merchant_reference: `WDR-${uid}-${Date.now()}`,
            custom_metadata: { uid }
        });

        // 4. Sauvegarde de la transaction dans Firestore 
        await db.collection('transactions').doc(String(fedapayTransaction.id)).set({
            uid,
            type: "external",
            category: "withdrawal",
            amount: amount, 
            fee,
            netAmount, 
            currencyIso: 'XOF',
            paymentMethodId: methodId,
            operator: method.operator,
            merchantReference: fedapayTransaction.merchant_reference,
            transactionId: fedapayTransaction.id,
            status: "pending", 
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                success: true, 
                transactionId: fedapayTransaction.id,
                amount,
                fee,
                netAmount,
                newBalance: finalBalance
            })
        };

    } catch (error) {
        // ... (Gestion des erreurs finale) ...
        console.error("Erreur retrait:", error);
        
        if (error.message === "SOLDE_INSUFFISANT") {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Solde insuffisant pour ce retrait." }) };
        }

        let errorMessage = "Erreur interne serveur.";
        if (error instanceof ApiConnectionError && error.errorMessage) {
            errorMessage = `Erreur FedaPay: ${error.errorMessage}.`;
        }

        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: errorMessage })
        };
    }
};
