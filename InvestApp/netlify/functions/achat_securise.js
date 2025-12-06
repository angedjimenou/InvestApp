// netlify/functions/achat_securise.js

const admin = require('firebase-admin');

// --------------------------------------------------------
// --- Initialisation Firebase Admin (Sécurisée) ---
// --------------------------------------------------------
const initializeAdmin = () => {
    try {
        if (!admin.apps.length) {
            const creds = process.env.FIREBASE_ADMIN_CREDENTIALS;
            if (!creds) throw new Error("Variable FIREBASE_ADMIN_CREDENTIALS non définie.");
            
            const decodedCreds = Buffer.from(creds, 'base64').toString();
            const serviceAccount = JSON.parse(decodedCreds);

            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
    } catch (error) {
        console.error("Erreur d'initialisation Admin SDK:", error);
        return false;
    }
    return true;
};

const db = () => admin.firestore();

// --------------------------------------------------------
// --- Paramètres Parrainage ---
// --------------------------------------------------------
const REFERRAL_DAILY_RATE = 0.01; 
const MAX_LEVELS = 5;

async function getReferrers(db, userId) {
    const referrers = [];
    
    const userSnap = await db().collection('users').doc(userId).get();
    if (!userSnap.exists) return referrers;
    
    let currentReferrerId = userSnap.data().referrerUid || null;

    for (let level = 0; level < MAX_LEVELS && currentReferrerId; level++) {
        const referrerSnap = await db().collection('users').doc(currentReferrerId).get();
        if (referrerSnap.exists) {
            referrers.push({
                uid: currentReferrerId,
                level: level + 1
            });
            currentReferrerId = referrerSnap.data().referrerUid || null; 
        } else {
            currentReferrerId = null;
        }
    }
    return referrers;
}

// --------------------------------------------------------
// --- Fonction Principale ---
// --------------------------------------------------------
exports.handler = async (event, context) => {
    // 1. Initialisation & Vérification HTTP
    if (!initializeAdmin()) {
        return { statusCode: 500, body: JSON.stringify({ error: "Configuration serveur invalide." }) };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: "Méthode non autorisée." }) };
    }

    // 2. Récupération du POST
    let data;
    try {
        data = JSON.parse(event.body);
    } catch (error) {
        return { statusCode: 400, body: JSON.stringify({ error: "Format de requête invalide." }) };
    }
    
    const { idToken, productId, productPrice, dailyRevenue, durationDays } = data; 

    if (!idToken || !productId || !productPrice || !dailyRevenue || !durationDays) {
        return { statusCode: 400, body: JSON.stringify({ error: "Données requises manquantes." }) };
    }
    
    // 3. Vérification de l'utilisateur
    let user;
    try {
        user = await admin.auth().verifyIdToken(idToken);
    } catch (error) {
        return { statusCode: 401, body: JSON.stringify({ error: "Token d'authentification invalide." }) };
    }
    const userId = user.uid;

    // 4. Transaction Achat & Parrainage
    try {
        const referrers = await getReferrers(db, userId); 
        
        const result = await db().runTransaction(async (t) => {
            const userRef = db().collection('users').doc(userId);
            const userDoc = await t.get(userRef);
            
            if (!userDoc.exists) throw new Error("ERR_USER_NOT_FOUND");

            const userData = userDoc.data();
            const currentBalance = userData.balance || 0;
            const newBalance = currentBalance - productPrice;
            const now = admin.firestore.FieldValue.serverTimestamp();

            if (newBalance < 0) throw new Error("ERR_INSUFFICIENT_FUNDS");
            
            const endDate = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
            
            t.update(userRef, {
                balance: newBalance,
                "daily.invest": admin.firestore.FieldValue.increment(dailyRevenue),
                updatedAt: now,
            });

            t.set(db().collection('investments').doc(), {
                userId,
                productId,
                price: productPrice,
                dailyRevenue,
                durationDays,
                startDate: now,
                endDate,
                status: 'active',
                createdAt: now,
            });

            t.set(db().collection("transactions").doc(), {
                uid: userId,
                type: "internal",
                category: "investment",
                amount: productPrice,
                direction: "debit",
                source: "Balance",
                target: "Investment",
                details: `Achat ${productId}`,
                timestamp: now,
            });
            
            // --- Bonus Parrainage ---
            const isFirstInvestment = !userData.firstInvestmentDone;
            const referrerUidLevel1 = userData.referrerUid;

            if (referrerUidLevel1 && isFirstInvestment) {
                const bonus = Math.round(productPrice * 0.15);
                const refRef = db().collection("users").doc(referrerUidLevel1);
                
                t.update(refRef, {
                    balance: admin.firestore.FieldValue.increment(bonus),
                    "totalRevenue.referral": admin.firestore.FieldValue.increment(bonus)
                });

                t.update(db().collection("filleuls").doc(referrerUidLevel1), {
                    [`${userId}.totalEarned`]: admin.firestore.FieldValue.increment(bonus)
                });

                t.set(db().collection("transactions").doc(), {
                    uid: referrerUidLevel1,
                    type: "internal",
                    category: "referral",
                    amount: bonus,
                    direction: "credit",
                    source: "ReferralFirstInvest",
                    target: "Balance",
                    details: `Bonus 15% premier invest de ${userData.phone || 'filleul'}`,
                    timestamp: now,
                });
                
                t.update(userRef, { firstInvestmentDone: true });
            }

            // --- Cascade 1% quotidien (5 niveaux) ---
            const increaseAmount = Math.round(dailyRevenue * REFERRAL_DAILY_RATE);
            if (increaseAmount > 0) {
                for(const referrer of referrers) {
                    const referrerRef = db().collection('users').doc(referrer.uid);
                    t.update(referrerRef, {
                        'daily.referral': admin.firestore.FieldValue.increment(increaseAmount), 
                        updatedAt: now,
                    });
                }
            }
            
            return { newBalance, newDailyRevenue: userData.daily?.invest + dailyRevenue };
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                success: true, 
                message: "Achat sécurisé et parrainage traités.",
                newBalance: result.newBalance,
                newDailyRevenue: result.newDailyRevenue
            })
        };

    } catch (e) {
        let errorCode = 500;
        let errorMessage = "Échec de la transaction.";

        if (e.message === "ERR_INSUFFICIENT_FUNDS") {
            errorCode = 403; 
            errorMessage = "Solde insuffisant pour cet achat.";
        } else if (e.message === "ERR_USER_NOT_FOUND") {
            errorCode = 404;
            errorMessage = "Utilisateur non trouvé.";
        } else {
            console.error("Erreur serveur lors de la transaction:", e);
        }

        return { statusCode: errorCode, body: JSON.stringify({ error: errorMessage }) };
    }
};