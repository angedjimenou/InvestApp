// netlify/functions/withdraw_request.js

const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
// 🚨 CHANGEMENT : Remplacement de 'Transaction' par 'Payout'
const { FedaPay, Payout, ApiConnectionError } = require('fedapay'); 

// ... (Initialisation Firebase Admin SDK et FedaPay inchangées) ...

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

        // Récupération des références et de la méthode de paiement (inchangé)
        const userRef = db.collection('users').doc(uid);
        const methodRef = db.collection('users').doc(uid).collection('payment_methods').doc(methodId);
        
        const methodSnap = await methodRef.get();
        if (!methodSnap.exists) {
            return { statusCode: 404, body: JSON.stringify({ success: false, error: "Moyen de paiement introuvable." }) };
        }
        const method = methodSnap.data();
        
        // 1. Vérification du Customer ID (Logique alignée sur votre dépôt)
        const customerId = method.customerId || null;
        if (!customerId) {
            return { 
                statusCode: 400, 
                body: JSON.stringify({ success: false, error: "Customer FedaPay manquant pour ce moyen de paiement." }) 
            };
        }

        // Calcul des frais et montant net (inchangé)
        const fee = Math.ceil(amount * 0.15); 
        const netAmount = amount - fee;
        if (netAmount <= 0) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Les frais excèdent le montant à retirer." }) };
        }

        // 2. SÉCURISATION DU SOLDE VIA TRANSACTION FIRESTORE (inchangé)
        let finalBalance = 0;
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            // ... (Logique de vérification et de débit du solde) ...
            const currentBalance = userDoc.data().balance || 0;
            if (amount > currentBalance) { throw new Error("SOLDE_INSUFFISANT"); }
            finalBalance = currentBalance - amount;
            transaction.update(userRef, { balance: finalBalance });
        });
        
        // 3. CRÉATION DU PAYOUT (Retrait)
        // 🚨 CHANGEMENT MAJEUR : Utilisation de Payout.create
        const payout = await Payout.create({
            description: `Retrait - Frais ${fee} F`,
            amount: netAmount,
            currency: { iso: 'XOF' },
            callback_url: process.env.DISBURSEMENT_CALLBACK_URL,
            merchant_reference: `WDR-${uid}-${Date.now()}`,
            
            // 📌 Utilisation du 'receiver' (destinataire) pour les Payouts
            receiver: {
                // FedaPay peut utiliser le Customer ID pour remplir les champs, mais il est plus sûr de passer le numéro
                phone_number: {
                    number: method.phone,
                    country: method.countryIso
                },
                provider: method.operator, // L'opérateur (mtn_open, moov, etc.)
                // On peut ajouter le nom si disponible : name: `${method.firstName} ${method.lastName}`
            },
            
            // On peut toujours passer le customerId dans custom_metadata pour le traçage
            custom_metadata: { uid, customerId: customerId, methodId }
        });

        // 4. Sauvegarde de la transaction dans Firestore (avec les IDs de Payout)
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
            // 🚨 CHANGEMENT : Utilisation de payout.id
            transactionId: payout.id, 
            status: "pending", 
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                success: true, 
                transactionId: payout.id, // ID du Payout
                amount,
                fee,
                netAmount,
                newBalance: finalBalance
            })
        };

    } catch (error) {
        // ... (Gestion des erreurs inchangée) ...
    }
};
