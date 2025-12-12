// netlify/functions/withdraw_request.js

const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { FedaPay, Payout, ApiConnectionError } = require('fedapay'); 

let db; 

// ----------------------------------------------------------------------
// 1. INITIALISATION DE FIREBASE ADMIN SDK (Standard pour Netlify/Lambda)
// ----------------------------------------------------------------------
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
        console.error("Erreur critique lors de l'initialisation de Firebase Admin:", error);
    }
} else {
    try {
        db = getFirestore();
    } catch (e) {
        console.error("Erreur lors de la récupération de getFirestore sur l'application existante:", e);
    }
}

// ----------------------------------------------------------------------
// 2. CONFIGURATION FEDAPAY
// ----------------------------------------------------------------------
FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
FedaPay.setEnvironment('live'); 

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, error: "Méthode non autorisée." }) };
    }
    
    if (!db) {
         return { statusCode: 500, body: JSON.stringify({ success: false, error: "Configuration Firebase Admin échouée." }) };
    }

    try {
        // Le front-end envoie : uid, methodId, amount
        const { uid, methodId, amount } = JSON.parse(event.body);

        // Correction de l'erreur "Données de requête manquantes"
        if (!uid || !methodId || typeof amount !== 'number' || amount < 1000) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Données de requête (UID, Méthode, Montant minimum 1000 F) manquantes ou invalides." }) };
        }
        
        const amountInCents = amount * 100;

        // Références Firestore
        const userRef = db.collection('users').doc(uid);
        const methodRef = userRef.collection('payment_methods').doc(methodId);
        
        // ----------------------------------------------------------------------
        // 3. VÉRIFICATIONS : Solde, Méthode, et Premier Investissement
        // ----------------------------------------------------------------------
        const userDoc = await userRef.get();
        const methodSnap = await methodRef.get();

        if (!userDoc.exists) { throw new Error("Utilisateur non trouvé."); }
        if (!methodSnap.exists) { 
            return { statusCode: 404, body: JSON.stringify({ success: false, error: "Moyen de paiement introuvable." }) };
        }
        
        const userData = userDoc.data();
        const methodData = methodSnap.data();

        const hasInvested = userData.firstInvestmentDone || false;
        
        // 3a. Vérification : Le retrait exige un premier investissement
        if (!hasInvested) {
            return {
                statusCode: 403,
                body: JSON.stringify({
                    success: false,
                    error: "Retrait refusé. Vous devez effectuer votre premier investissement pour débloquer les retraits.",
                    errorCode: 'FIRST_INVESTMENT_REQUIRED'
                })
            };
        }
        
        // 3b. Vérification du solde (préliminaire)
        if (userData.balance < amount) {
            throw new Error("Fonds insuffisants pour le retrait.");
        }

        // Calcul des frais (réutiliser la logique front-end pour cohérence, mais ici c'est le montant transféré)
        const fee = Math.ceil(amount * 0.15); 
        const netAmount = amount - fee;
        
        if (netAmount <= 0) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Les frais excèdent le montant à retirer." }) };
        }


        // ----------------------------------------------------------------------
        // 4. CRÉATION DU PAYOUT CHEZ FEDAPAY (Séquence Sécurisée Étape 1)
        // ----------------------------------------------------------------------
        const payout = await Payout.create({
            description: `Retrait ${netAmount} F (Frais: ${fee} F)`,
            amount: netAmount, // C'est le montant NET qui doit être envoyé
            currency: { iso: 'XOF' },
            callback_url: process.env.DISBURSEMENT_CALLBACK_URL,
            merchant_reference: `WDR-${uid}-${Date.now()}`,
            
            // Détails du destinataire (lu de la méthode de paiement)
            receiver: {
                phone_number: {
                    number: methodData.phone,
                    country: methodData.countryIso
                },
                provider: methodData.operator,
            },
            
            custom_metadata: { uid, methodId }
        });

        // ----------------------------------------------------------------------
        // 5. TRANSACTION ATOMIQUE (Séquence Sécurisée Étape 2 : Débit et Enregistrement)
        // ----------------------------------------------------------------------
        const payoutId = String(payout.id);
        let finalNewBalance = userData.balance; 

        await db.runTransaction(async (transaction) => {
            const freshUserDoc = await transaction.get(userRef);
            const currentBalance = freshUserDoc.data().balance || 0;
            
            // Re-vérification finale du solde (atomique)
            if (currentBalance < amount) {
                throw new Error("Fonds insuffisants (conflit de transaction)."); 
            }

            // Débit du solde (débit du montant BRUT demandé par l'utilisateur)
            finalNewBalance = currentBalance - amount; 
            transaction.update(userRef, { balance: finalNewBalance });
            
            // Création de la transaction dans Firestore
            const txRef = db.collection('transactions').doc(payoutId);
            transaction.set(txRef, {
                uid: uid,
                type: 'external', 
                category: 'withdrawal',
                amount: amount, // Montant brut débité
                fee: fee,
                netAmount: netAmount, // Montant net envoyé à FedaPay
                status: payout.status || 'pending', 
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                fedapayUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
                payoutId: payoutId,
                operator: methodData.operator,
                fedapayStatus: payout.status,
            });
        });

        // ----------------------------------------------------------------------
        // 6. RÉPONSE
        // ----------------------------------------------------------------------
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: "Retrait initié. Statut en attente de confirmation.",
                payoutId: payoutId,
                amount: amount,
                fee: fee,
                netAmount: netAmount,
                newBalance: finalNewBalance
            })
        };

    } catch (error) {
        console.error("Erreur lors du traitement du retrait:", error);
        
        let errorMessage = error.message;
        let httpStatus = 500;
        
        if (error.message === "Fonds insuffisants pour le retrait.") {
            httpStatus = 400;
        } else if (error.message === 'FIRST_INVESTMENT_REQUIRED') {
            httpStatus = 403;
        } else if (error instanceof ApiConnectionError) {
            httpStatus = error.httpStatus || 500;
            // Utilisez le message d'erreur de FedaPay si disponible
            errorMessage = error.message; 
        }

        return {
            statusCode: httpStatus,
            body: JSON.stringify({
                success: false,
                error: errorMessage,
                details: error.message
            })
        };
    }
};
