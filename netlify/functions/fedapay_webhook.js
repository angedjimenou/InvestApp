const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// --- 1. INITIALISATION FIREBASE ---
if (!admin.apps.length) {
    // Note: Déjà géré dans votre code, on conserve
    const decodedServiceAccount = Buffer.from(
        process.env.FIREBASE_ADMIN_CREDENTIALS,
        'base64'
    ).toString('utf8');
    const serviceAccount = JSON.parse(decodedServiceAccount);
    initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = getFirestore();

// Définition des statuts terminaux (réussite)
const SUCCESS_STATUSES = ["approved", "confirmed", "completed"];

// --- 2. HANDLER PRINCIPAL ---
exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: "Méthode non autorisée." };
    }

    let body = {};

    try {
        // Parsing du corps de la requête
        body = JSON.parse(event.body);
    } catch (err) {
        console.error("Erreur parsing JSON:", err);
        return { statusCode: 400, body: "Invalid JSON" };
    }

    console.log("Webhook name:", body.name); // 'transaction.canceled' ou 'transaction.created'

    try {
        // ✅ CORRECTION 1: Extraction de l'objet Fedapay à partir de 'entity'
        const entity = body.entity; 

        if (!entity || !entity.id || !entity.status || !entity.updated_at) {
            console.error("Données d'entité critiques manquantes dans le webhook Fedapay.");
            // On répond 200 pour ne pas saturer Fedapay de tentatives de renvoi inutiles.
            return { statusCode: 200, body: "Missing critical entity data" };
        }

        const transactionId = String(entity.id); // ID de Fedapay (numérique)
        const newStatus = entity.status; // Statut Fedapay ('pending', 'approved', 'canceled', etc.)
        const fedapayUpdatedAt = new Date(entity.updated_at).getTime(); // Horodatage de l'événement Fedapay

        console.log(`Transaction ID Fedapay: ${transactionId} - Nouveau Statut: ${newStatus} - Updated At: ${entity.updated_at}`);

        // --- 3. RÉCUPÉRATION DE LA TRANSACTION FIRESTORE ---
        const txRef = db.collection("transactions").doc(transactionId);
        const txSnap = await txRef.get();

        if (!txSnap.exists) {
            console.error("Transaction introuvable dans /transactions pour l'ID:", transactionId);
            return { statusCode: 404, body: "Transaction not found" };
        }

        const tx = txSnap.data();
        
        // --- 4. CORRECTION 2: VÉRIFICATION CHRONOLOGIQUE ---
        // Si l'horodatage Fedapay est antérieur ou égal au dernier horodatage de l'événement traité, ignorer l'événement.
        // On suppose que 'tx.fedapayUpdatedAt' stocke le dernier horodatage traité (ajouter ce champ lors de la création initiale).
        if (tx.fedapayUpdatedAt && fedapayUpdatedAt <= tx.fedapayUpdatedAt.toMillis()) {
            console.log(`Événement ignoré (Plus ancien ou égal) : ${entity.updated_at}`);
            return { statusCode: 200, body: "Event ignored (older timestamp)" };
        }
        
        // On suppose que vous ne créditez le solde qu'une seule fois
        const hasBeenCredited = tx.credited || false;

        // --- 5. MISE À JOUR DE LA TRANSACTION (et du solde si réussite) ---
        
        const updateData = {
            status: newStatus,
            fedapayUpdatedAt: FieldValue.serverTimestamp(), // Met à jour l'horodatage Firestore
            // Stockez l'horodatage Fedapay pour la vérification chronologique future
            fedapayUpdatedAt: admin.firestore.Timestamp.fromMillis(fedapayUpdatedAt), 
        };
        
        // 📌 Mise à jour du solde si confirmé ET si le solde n'a JAMAIS été crédité
        if (SUCCESS_STATUSES.includes(newStatus) && !hasBeenCredited) {
            const userRef = db.collection("users").doc(tx.uid);
            
            await db.runTransaction(async (t) => {
                const userSnap = await t.get(userRef);
                const user = userSnap.data() || {};
                
                const balance = user.balance || 0;
                const newBalance = balance + tx.amount; // tx.amount est le montant payé
                
                t.update(userRef, { balance: newBalance });
                t.update(txRef, { 
                    ...updateData,
                    credited: true, // Marque comme crédité
                });
                
                console.log("Solde utilisateur mis à jour avec succès :", newBalance);
            });
            
        } else {
            // Mise à jour simple du statut (pour pending, canceled, declined)
            await txRef.update(updateData);
            console.log("Statut de la transaction mis à jour avec succès :", newStatus);
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, status: newStatus })
        };

    } catch (err) {
        console.error("Erreur critique dans le webhook FedaPay:", err);
        return { statusCode: 500, body: "Webhook server error" };
    }
};