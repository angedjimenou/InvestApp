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
    // Nous lisons l'UID, le montant et l'opérateur du corps de la requête.
    const { uid, amount, operator } = requestData; 
    const amountInCents = amount * 100;

    if (!uid || typeof amount !== 'number' || amount <= 0 || !operator) {
        return { statusCode: 400, body: JSON.stringify({ success: false, error: "Données de requête (uid, montant, opérateur) manquantes ou invalides." }) };
    }

    try {
        const userRef = db.collection('users').doc(uid);
        
        // ----------------------------------------------------------------------
        // 3. VÉRIFICATION DU PREMIER INVESTISSEMENT, SOLDE, ET RÉCUPÉRATION TÉLÉPHONE
        // ----------------------------------------------------------------------
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            throw new Error("Utilisateur non trouvé.");
        }
        
        const userData = userDoc.data();
        const hasInvested = userData.firstInvestmentDone || false;
        const userPhone = userData.phone;       // LECTURE DU TÉLÉPHONE DE FIRESTORE
        const userCountryCode = userData.countryCode; // LECTURE DU CODE PAYS DE FIRESTORE
        
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

        // Vérification 3 : Numéro de téléphone complet
        if (!userPhone || !userCountryCode) {
             return {
                statusCode: 400,
                body: JSON.stringify({
                    success: false,
                    error: "Les informations de contact (téléphone/pays) sont manquantes dans votre profil.",
                })
            };
        }

        // ----------------------------------------------------------------------
        // 4. CRÉATION DU PAYOUT CHEZ FEDAPAY (Séquence Sécurisée Étape 1)
        // ----------------------------------------------------------------------
        const payout = await Payout.create({
            amount: amountInCents,
            currency: 'XOF', 
            description: `Retrait ${amount} F pour ${uid}`,
            recipient: {
                // CORRECTION : Utilisation des données LUES DE FIRESTORE
                phone_number: `${userCountryCode}${userPhone}`, 
                operator: operator, 
            },
            callback_url: process.env.DISBURSEMENT_CALLBACK_URL, 
            custom_metadata: {
                uid: uid,
                requestDate: new Date().toISOString()
            }
        });

        // ----------------------------------------------------------------------
        // 5. TRANSACTION ATOMIQUE (Séquence Sécurisée Étape 2 : Débit et Enregistrement)
        // ----------------------------------------------------------------------
        const payoutId = String(payout.id);
        let finalNewBalance = userData.balance; 

        await db.runTransaction(async (transaction) => {
            const freshUserDoc = await transaction.get(userRef);
            const currentBalance = freshUserDoc.data().balance || 0;
            
            // Re-vérification finale du solde pour l'atomicité
            if (currentBalance < amount) {
                throw new Error("Fonds insuffisants (conflit de transaction)."); 
            }

            // Débit du solde
            finalNewBalance = currentBalance - amount;
            transaction.update(userRef, { balance: finalNewBalance });
            
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
                newBalance: finalNewBalance
            })
        };

    } catch (error) {
        console.error("Erreur lors du traitement du retrait:", error);
        
        // Gérer les erreurs de connexion API FedaPay (Code 500)
        const httpStatus = error.httpStatus || 500;
        const errorMessage = error.message || "Erreur interne serveur.";

        return {
            statusCode: httpStatus,
            body: JSON.stringify({
                success: false,
                error: "Échec de l'initialisation du retrait.",
                details: errorMessage
            })
        };
    }
};
