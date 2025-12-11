// netlify/functions/withdraw_request.js

const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { FedaPay, Payout } = require('fedapay'); 

// ... (Initialisation Firebase et FedaPay, comme dans les autres fonctions)
// ...

exports.handler = async (event) => {
    // ... (Vérifications préliminaires : POST, Authentification, Données)
    // ...
    
    // Si la vérification est OK, extraire les données
    // const { uid, amount, phone, countryCode, currency, operator, reference } = JSON.parse(event.body);
    // Supposons que ces variables sont correctement définies ici.
    const requestData = JSON.parse(event.body);
    const { uid, amount, phone, countryCode, operator } = requestData;
    const amountInCents = amount * 100; // FedaPay utilise les centimes

    try {
        // ----------------------------------------------------------------------
        // NOUVELLE ÉTAPE 1 : CRÉER LE PAYOUT CHEZ FEDAPAY (Hors transaction Firestore)
        // ----------------------------------------------------------------------
        const payout = await Payout.create({
            amount: amountInCents,
            currency: 'XOF', // Assumons le XOF pour FedaPay
            description: `Retrait ${amount} F pour ${uid}`,
            recipient: {
                // Le numéro de téléphone au format E.164 est préférable
                phone_number: `${countryCode}${phone}`, 
                operator: operator, 
            },
            // Le Webhook URL est nécessaire ici pour que FedaPay sache où envoyer l'état final
            callback_url: process.env.DISBURSEMENT_CALLBACK_URL, 
            custom_metadata: {
                uid: uid,
                requestDate: new Date().toISOString()
            }
        });

        // ----------------------------------------------------------------------
        // ÉTAPE 2 : TRANSACTION ATOMIQUE (Si et seulement si le Payout a été créé)
        // ----------------------------------------------------------------------
        const payoutId = String(payout.id); // L'ID Payout sera notre ID de transaction Firestore

        await db.runTransaction(async (transaction) => {
            const userRef = db.collection('users').doc(uid);
            const txRef = db.collection('transactions').doc(payoutId);

            // 2a. Lecture de l'utilisateur
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) throw new Error("Utilisateur non trouvé.");

            const currentBalance = userDoc.data().balance || 0;
            
            // Vérification de la suffisance du solde (re-vérification au cas où)
            if (currentBalance < amount) {
                throw new Error("Fonds insuffisants pour le retrait.");
            }

            // 2b. Débit du solde
            const newBalance = currentBalance - amount;
            transaction.update(userRef, { balance: newBalance });
            
            // 2c. Création de la transaction dans Firestore
            transaction.set(txRef, {
                uid: uid,
                type: 'external', // Retrait est une transaction externe
                category: 'withdrawal',
                amount: amount, 
                // Le statut initial est 'pending' car FedaPay est asynchrone
                status: payout.status || 'pending', 
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                fedapayUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
                payoutId: payoutId,
                // Autres détails pour le support/debug
                fedapayOperator: operator, 
                fedapayStatus: payout.status,
            });
        });

        // ----------------------------------------------------------------------
        // ÉTAPE 3 : RÉPONSE (Si la transaction atomique est réussie)
        // ----------------------------------------------------------------------
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: "Retrait initié. Statut en attente de confirmation.",
                payoutId: payoutId,
                newBalance: newBalance // Si nécessaire pour l'UI
            })
        };

    } catch (error) {
        console.error("Erreur lors du traitement du retrait:", error);
        
        // Si l'erreur est survenue à l'étape 1 (Appel FedaPay), le solde n'a pas été débité.
        // Si l'erreur est survenue à l'étape 2 (Transaction Firestore), le solde n'a pas été débité.
        // DANS TOUS LES CAS, le système est sécurisé.

        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                error: "Échec de l'initialisation du retrait. Aucun montant n'a été débité.",
                details: error.message
            })
        };
    }
};
