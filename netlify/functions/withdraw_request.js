// netlify/functions/withdraw_request.js

const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { FedaPay, Payout } = require('fedapay'); 

// ... (Initialisation Firebase et FedaPay)
// ...

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, error: "Méthode non autorisée." }) };
    }
    
    // Assumons que le corps contient les données nécessaires
    const requestData = JSON.parse(event.body);
    const { uid, amount, phone, countryCode, operator } = requestData;
    const amountInCents = amount * 100;

    if (!uid || typeof amount !== 'number' || amount <= 0) {
        return { statusCode: 400, body: JSON.stringify({ success: false, error: "Données de requête invalides." }) };
    }

    try {
        const db = getFirestore();
        const userRef = db.collection('users').doc(uid);
        
        // ----------------------------------------------------------------------
        // NOUVELLE ÉTAPE 1 : VÉRIFICATION DU PREMIER INVESTISSEMENT
        // ----------------------------------------------------------------------
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            throw new Error("Utilisateur non trouvé.");
        }
        
        const userData = userDoc.data();
        const hasInvested = userData.firstInvestmentDone || false;
        
        if (!hasInvested) {
            // Empêcher le retrait si le premier investissement n'est pas fait
            return {
                statusCode: 403,
                body: JSON.stringify({
                    success: false,
                    error: "Retrait refusé. Vous devez effectuer votre premier investissement pour débloquer les retraits.",
                    errorCode: 'FIRST_INVESTMENT_REQUIRED'
                })
            };
        }
        
        // Vérification de la suffisance du solde AVANT l'appel FedaPay
        if (userData.balance < amount) {
            throw new Error("Fonds insuffisants pour le retrait.");
        }

        // ----------------------------------------------------------------------
        // ÉTAPE 2 : CRÉATION DU PAYOUT CHEZ FEDAPAY (Exposé à l'échec)
        // ----------------------------------------------------------------------
        const payout = await Payout.create({
            amount: amountInCents,
            currency: 'XOF', 
            description: `Retrait ${amount} F pour ${uid}`,
            recipient: {
                phone_number: `${countryCode}${phone}`, 
                operator: operator, 
            },
            callback_url: process.env.DISBURSEMENT_CALLBACK_URL, 
            custom_metadata: {
                uid: uid,
                requestDate: new Date().toISOString()
            }
        });

        // ----------------------------------------------------------------------
        // ÉTAPE 3 : TRANSACTION ATOMIQUE (Débit du Solde et Création de la Transaction)
        // ----------------------------------------------------------------------
        const payoutId = String(payout.id);
        let newBalance = userData.balance; // Initialisation avant la transaction

        await db.runTransaction(async (transaction) => {
            // Re-lecture pour obtenir l'état le plus frais dans la transaction
            const freshUserDoc = await transaction.get(userRef);
            const currentBalance = freshUserDoc.data().balance || 0;
            
            // Re-vérification finale du solde
            if (currentBalance < amount) {
                // Bien que vérifié avant, on doit s'assurer que le solde n'a pas été modifié par une autre opération
                throw new Error("Fonds insuffisants (conflit de transaction)."); 
            }

            // Débit du solde
            newBalance = currentBalance - amount;
            transaction.update(userRef, { balance: newBalance });
            
            // Création de la transaction dans Firestore
            const txRef = db.collection('transactions').doc(payoutId);
            transaction.set(txRef, {
                uid: uid,
                type: 'external', 
                category: 'withdrawal',
                amount: amount, 
                status: payout.status || 'pending', 
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                fedapayUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
                payoutId: payoutId,
                fedapayOperator: operator, 
                fedapayStatus: payout.status,
            });
        });

        // ----------------------------------------------------------------------
        // ÉTAPE 4 : RÉPONSE
        // ----------------------------------------------------------------------
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: "Retrait initié. Statut en attente de confirmation.",
                payoutId: payoutId,
                newBalance: newBalance
            })
        };

    } catch (error) {
        console.error("Erreur lors du traitement du retrait:", error);
        
        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                error: "Échec de l'initialisation du retrait.",
                details: error.message
            })
        };
    }
};
