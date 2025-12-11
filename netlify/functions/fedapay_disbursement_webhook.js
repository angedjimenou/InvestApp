// netlify/functions/fedapay_disbursement_webhook.js (CORRIGÉ)

const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
// Nous revenons à la méthode du SDK FedaPay pour la vérification, plus robuste
const { FedaPay, WebhookVerificationError } = require('fedapay'); 

if (!admin.apps.length) {
    try {
        const decodedServiceAccount = Buffer.from(
            process.env.FIREBASE_ADMIN_CREDENTIALS,
            'base64'
        ).toString('utf8');
        const serviceAccount = JSON.parse(decodedServiceAccount);
        initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } catch (e) {
        console.error("Erreur d'initialisation Firebase:", e);
    }
}

const db = getFirestore();
FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
FedaPay.setEnvironment('live'); // Assumer 'live' ou ajuster si nécessaire

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, error: "Méthode non autorisée." }) };
    }
    
    // 1. VÉRIFICATION DU WEBHOOK VIA SDK FEDAPAY (RECOMMANDÉ)
    const signature = event.headers['x-fedapay-signature'] || event.headers['X-Fedapay-Signature'];
    const body = event.body;

    try {
        // Le SDK gère la vérification en utilisant la clé secrète de webhook
        FedaPay.verifyEventBody(body, signature, process.env.FEDAPAY_WEBHOOK_SECRET); 
    } catch (e) {
        if (e instanceof WebhookVerificationError) {
            console.warn("Échec de la vérification du Webhook de Retrait (Disbursement).");
            return { statusCode: 403, body: JSON.stringify({ success: false, error: "Signature invalide." }) };
        }
        console.error("Erreur de vérification du Webhook:", e);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: "Erreur interne de vérification." }) };
    }
    
    // 2. EXTRACTION DES DONNÉES ET VÉRIFICATIONS
    const payload = JSON.parse(body);
    const eventType = payload.event;
    const payoutData = payload.resource;
    
    // Utiliser l'ID de la ressource (Payout ID) pour l'ID du document Firestore
    const payoutId = String(payoutData.id); 
    const currentStatus = payoutData.status; 
    const uid = payoutData.custom_metadata?.uid; // UID est extrait du Payout Data dans les metadonnées

    if (!uid || !payoutId) {
        return { statusCode: 400, body: JSON.stringify({ success: false, error: "UID ou Payout ID manquant dans les données FedaPay." }) };
    }

    // 3. TROUVER ET METTRE À JOUR LA TRANSACTION (Lecture directe par ID)
    // Nous utilisons la collection centralisée 'transactions' et l'ID Payout comme ID de document
    const txRef = db.collection('transactions').doc(payoutId);
    const txSnap = await txRef.get();

    if (!txSnap.exists) {
        // La transaction n'a pas été enregistrée. C'est le cas critique mentionné précédemment.
        // Si le solde a été débité, l'utilisateur devra contacter le support.
        console.warn(`Payout ${payoutId} reçu, mais la transaction n'existe pas dans Firestore.`);
        return { statusCode: 404, body: JSON.stringify({ success: false, error: "Transaction non trouvée dans Firestore." }) };
    }
    
    const txData = txSnap.data();
    const isFailed = (currentStatus === 'declined' || currentStatus === 'canceled' || eventType === 'payout.failed');
    
    // 4. LOGIQUE CRITIQUE DE REMBOURSEMENT EN CAS D'ÉCHEC
    if (isFailed) {
        const amountToRefund = txData.amount; // Montant brut débité à la requête
        
        // Vérifier si le remboursement a déjà été effectué (via le statut ou un champ 'isRefunded')
        if (txData.status !== 'failed' && txData.status !== 'canceled' && txData.isRefunded !== true) {
            
            try {
                const userRef = db.collection('users').doc(uid);
                await db.runTransaction(async (transaction) => {
                    const userDoc = await transaction.get(userRef);
                    const currentBalance = userDoc.data().balance || 0;
                    
                    const newBalance = currentBalance + amountToRefund;
                    
                    transaction.update(userRef, { 
                        balance: newBalance,
                    });
                    
                    transaction.update(txRef, {
                        status: currentStatus,
                        fedapayUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        isRefunded: true, 
                        details: `Retrait échoué: ${amountToRefund} F remboursés.`
                    });
                });
                
                console.log(`Remboursement réussi : ${amountToRefund} F re-crédités à ${uid} pour échec Payout ${payoutId}`);
                
            } catch (e) {
                console.error(`Erreur de Transaction (Remboursement) pour Payout ${payoutId}:`, e);
                return { statusCode: 500, body: JSON.stringify({ success: false, error: "Erreur lors du remboursement du solde." }) };
            }
        }
    } 
    
    // 5. MISE À JOUR DU STATUT (Réussi ou tout autre état)
    // Mettre à jour la transaction si elle n'a pas été traitée comme un remboursement dans le bloc précédent
    // et si le statut n'est pas déjà finalisé.
    if (txData.status !== currentStatus && txData.isRefunded !== true) {
        try {
            await txRef.update({
                status: currentStatus,
                fedapayUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
                details: currentStatus === 'approved' ? "Retrait réussi." : `Statut mis à jour: ${currentStatus}`
            });
            console.log(`Payout ${payoutId}: statut mis à jour à ${currentStatus}`);
        } catch (e) {
             console.error(`Erreur de mise à jour du statut pour Payout ${payoutId}:`, e);
             return { statusCode: 500, body: JSON.stringify({ success: false, error: "Erreur de mise à jour du statut." }) };
        }
    }


    return { statusCode: 200, body: JSON.stringify({ success: true, message: `Payout ${payoutId} traité.` }) };

};
