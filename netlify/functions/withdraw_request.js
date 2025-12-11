// netlify/functions/withdraw_request.js

const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { FedaPay, Payout } = require('fedapay'); 

let db; 

// ----------------------------------------------------------------------
// 1. INITIALISATION DE FIREBASE ADMIN SDK (CORRECTION DE L'ERREUR 'app/no-app')
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
        // On ne retourne pas d'erreur ici, mais on log l'échec.
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

    const requestData = JSON.parse(event.body);
    const { uid, amount, phone, countryCode, operator } = requestData;
    const amountInCents = amount * 100;

    if (!uid || typeof amount !== 'number' || amount <= 0) {
        return { statusCode: 400, body: JSON.stringify({ success: false, error: "Données de requête invalides." }) };
    }

    try {
        const userRef = db.collection('users').doc(uid);
        
        // ----------------------------------------------------------------------
        // 3. VÉRIFICATION DU PREMIER INVESTISSEMENT ET DU SOLDE
        // ----------------------------------------------------------------------
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            throw new Error("Utilisateur non trouvé.");
        }
        
        const userData = userDoc.data();
        const hasInvested = userData.firstInvestmentDone || false;
        
        // Vérification 1 : Le retrait exige un premier investissement
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
        
        // Vérification 2 : Solde suffisant
        if (userData.balance < amount) {
            throw new Error("Fonds insuffisants pour le retrait.");
        }

        // ----------------------------------------------------------------------
        // 4. CRÉATION DU PAYOUT CHEZ FEDAPAY (Étape 1 de la Séquence Sécurisée)
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
        // 5. TRANSACTION ATOMIQUE (Étape 2 de la Séquence Sécurisée : Débit et Enregistrement)
        // ----------------------------------------------------------------------
        const payoutId = String(payout.id);
        let newBalance = userData.balance; 

        await db.runTransaction(async (transaction) => {
            const freshUserDoc = await transaction.get(userRef);
            const currentBalance = freshUserDoc.data().balance || 0;
            
            // Re-vérification finale du solde pour l'atomicité
            if (currentBalance < amount) {
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
        // 6. RÉPONSE
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
