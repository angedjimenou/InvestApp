// netlify/functions/withdraw_request.js
const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
// Import de Customer, Transaction
const { FedaPay, Customer, Transaction } = require('fedapay'); 
// Import du code d'erreur FedaPay pour la gestion précise
const { ApiConnectionError } = require('fedapay/lib/Errors'); 

// ... (Initialisation Firebase Admin SDK inchangée) ...

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
        
        const methodSnap = await methodRef.get();
        if (!methodSnap.exists) {
            return { statusCode: 404, body: JSON.stringify({ success: false, error: "Moyen de paiement introuvable." }) };
        }
        const method = methodSnap.data();
        
        // Calcul des frais (maintenu à 15% pour l'exemple)
        const fee = Math.ceil(amount * 0.15); 
        const netAmount = amount - fee;

        if (netAmount <= 0) {
             return { statusCode: 400, body: JSON.stringify({ success: false, error: "Les frais excèdent le montant à retirer." }) };
        }

        // --- GESTION DU CUSTOMER FEDAPAY CORRIGÉE ---
        let customerId = method.fedapayCustomerId || null;
        
        if (!customerId) {
            // Utiliser un identifiant plus unique ou un réel e-mail si disponible
            // Ici, nous utilisons l'UID + un suffixe unique par sécurité
            const uniqueEmail = `${uid}-${methodId}@investapp.local`; 

            // Remplacer l'approche Customer.create directe par une vérification (ou une logique plus robuste)
            // Cependant, le log d'erreur indique que la création de Customer est le point de rupture.
            // La solution est de s'assurer que si un Customer est créé, son ID est enregistré, et l'e-mail est unique.

            try {
                // Tentative de création du Customer FedaPay
                const customer = await Customer.create({
                    firstname: method.nickname || "Utilisateur", // Utiliser un nom disponible
                    lastname: method.lastName || "SabotInvest",
                    email: uniqueEmail, // Utiliser un email plus unique
                    phone_number: {
                        number: method.phone,
                        country: method.countryIso
                    }
                });
                customerId = customer.id;
                // Mettre à jour la référence du client FedaPay dans le moyen de paiement
                await methodRef.update({ fedapayCustomerId: customerId });

            } catch (err) {
                // Gérer spécifiquement l'erreur "email non disponible" si elle persiste
                if (err instanceof ApiConnectionError && err.errors && err.errors.email && err.errors.email.includes("n'est pas disponible")) {
                     console.warn(`Customer FedaPay déjà existant pour UID ${uid}, mais ID non enregistré. Tentative de recherche ou d'utiliser l'e-mail réel.`);
                     // Ici, vous pourriez implémenter une recherche par e-mail ou ignorer si vous êtes sûr que la création a échoué car il existe déjà.
                     return { statusCode: 500, body: JSON.stringify({ success: false, error: "Le client FedaPay existe déjà. Veuillez contacter le support pour lier l'ID." }) };
                }
                throw err; // Relancer les autres erreurs
            }
        }
        // --- FIN GESTION CUSTOMER ---

        // 2. SÉCURISATION DU SOLDE VIA TRANSACTION FIRESTORE
        let finalBalance = 0;
        
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throw new Error("Utilisateur introuvable pour la transaction.");
            }
            const currentBalance = userDoc.data().balance || 0;

            if (amount > currentBalance) {
                // Lancer une erreur qui annule la transaction
                throw new Error("SOLDE_INSUFFISANT"); 
            }

            finalBalance = currentBalance - amount;
            // Débiter le solde de l'utilisateur
            transaction.update(userRef, { balance: finalBalance });
        });
        
        // Si la transaction Firestore réussit, on crée la transaction FedaPay
        
        // Créer la transaction FedaPay sur le montant net
        const fedapayTransaction = await Transaction.create({
            description: `Retrait - Frais ${fee} F`,
            amount: netAmount,
            currency: { iso: 'XOF' },
            callback_url: process.env.DISBURSEMENT_CALLBACK_URL,
            // Pour le retrait, FedaPay attend le mode (Mobile Money) sur la transaction
            mode: method.operator, 
            customer: { id: customerId },
            merchant_reference: `WDR-${uid}-${Date.now()}`,
            custom_metadata: { uid }
        });

        // Pas de sendNowWithToken pour un retrait (disbursement)
        // La transaction est créée et le webhook se chargera du reste

        // Sauvegarde de la transaction dans Firestore (utilisation de la collection 'transactions' pour la cohérence)
        await db.collection('transactions').doc(String(fedapayTransaction.id)).set({
            uid,
            type: "external",
            category: "withdrawal",
            amount: amount, // Le montant total demandé par l'utilisateur
            fee,
            netAmount, // Montant transféré par FedaPay
            currencyIso: 'XOF',
            paymentMethodId: methodId,
            operator: method.operator,
            merchantReference: fedapayTransaction.merchant_reference,
            transactionId: fedapayTransaction.id,
            status: "pending", // statut initial
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
        console.error("Erreur retrait:", error);

        // Gérer le cas de solde insuffisant
        if (error.message === "SOLDE_INSUFFISANT") {
            return {
                statusCode: 400,
                body: JSON.stringify({ success: false, error: "Solde insuffisant pour ce retrait." })
            };
        }

        // Gérer les erreurs de connexion API et fournir des détails au développeur
        let errorMessage = "Erreur interne serveur.";
        if (error instanceof ApiConnectionError && error.errorMessage) {
            errorMessage = `Erreur FedaPay: ${error.errorMessage}`;
            // Si l'erreur FedaPay est un doublon, donner une meilleure indication au frontend
            if (error.errors && error.errors.email && error.errors.email.includes("n'est pas disponible")) {
                errorMessage = "Erreur de configuration client. Veuillez contacter le support (code 400).";
            }
        }

        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: errorMessage })
        };
    }
};