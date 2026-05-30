// Schedule: 15 13 * * *
// ════════════════════════════════════════════════════════════════════════════
// NETLIFY SCHEDULED FUNCTION — Créditation quotidienne automatique
// ════════════════════════════════════════════════════════════════════════════
// 
// Cette fonction s'exécute AUTOMATIQUEMENT selon le schedule défini ci-dessus.
// 
// SCHEDULE ACTUEL : "20 6 * * *" = 06h20 UTC chaque jour = 07h20 GMT+1 (Bénin)
// 
// FORMAT CRON : "minute heure * * *"
// Exemples :
//   "0 0 * * *"   = 00h00 UTC (minuit)
//   "0 8 * * *"   = 08h00 UTC
//   "20 6 * * *"  = 06h20 UTC ← ACTUEL (07h20 Bénin)
//   "35 7 * * *"  = 07h35 UTC (08h35 Bénin)
// 
// POUR CHANGER L'HEURE DE CRÉDITATION :
// - Modifie la valeur dans le commentaire "// Schedule: X Y * * *" en haut
// - Netlify redéployera automatiquement
// - Pas besoin de toucher au code de la fonction elle-même
//
// ════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');

// ─────────────────────────────────────────────────────────────────────────────
// Initialisation Firebase Admin
// ─────────────────────────────────────────────────────────────────────────────
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

const getDb = () => admin.firestore();

// ─────────────────────────────────────────────────────────────────────────────
// Utilitaires
// ─────────────────────────────────────────────────────────────────────────────
function getTodayString() {
    // Retourne la date d'aujourd'hui en UTC (YYYY-MM-DD)
    // Utilisé pour l'idempotence : vérifier si la créditation a déjà eu lieu
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatFr(number) {
    return `F ${Math.round(number).toLocaleString('fr-FR')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fonction Principale
// ─────────────────────────────────────────────────────────────────────────────
exports.handler = async (event, context) => {
    console.log("🚀 Démarrage de creditDaily...");

    // Initialisation
    if (!initializeAdmin()) {
        console.error("❌ Erreur : Firebase Admin SDK non initialisé");
        return { statusCode: 500, body: JSON.stringify({ error: "Erreur serveur" }) };
    }

    const db = getDb();
    const today = getTodayString();
    const now = admin.firestore.FieldValue.serverTimestamp();

    try {
        // ─────────────────────────────────────────────────────────────────────
        // ÉTAPE 1 : Récupérer tous les utilisateurs
        // ─────────────────────────────────────────────────────────────────────
        console.log("📋 Récupération des utilisateurs...");
        const usersSnap = await db.collection('users').get();
        console.log(`✅ Trouvé ${usersSnap.size} utilisateurs.`);

        let usersProcessed = 0;
        let usersSkipped = 0;
        let totalCredit = 0;

        // ─────────────────────────────────────────────────────────────────────
        // ÉTAPE 2 : Traiter chaque utilisateur
        // ─────────────────────────────────────────────────────────────────────
        for (const userDoc of usersSnap.docs) {
            const userData = userDoc.data();
            const uid = userDoc.id;

            // ═════════════════════════════════════════════════════════════════
            // FIX IDEMPOTENCE : Vérifier si déjà crédité aujourd'hui
            // ═════════════════════════════════════════════════════════════════
            const lastCreditDate = userData.lastCreditDate;
            if (lastCreditDate === today) {
                console.log(`⏭️  [${uid}] Déjà crédité aujourd'hui. Ignoré.`);
                usersSkipped++;
                continue;
            }

            const investDaily = userData.daily?.invest || 0;
            const referralDaily = userData.daily?.referral || 0;
            const userTotalCredit = investDaily + referralDaily;

            // Skip si aucun revenu
            if (userTotalCredit <= 0) {
                console.log(`⏭️  [${uid}] Revenu quotidien nul. Ignoré.`);
                usersSkipped++;
                continue;
            }

            // ═════════════════════════════════════════════════════════════════
            // Traitement : Batch update (atomicité)
            // ═════════════════════════════════════════════════════════════════
            const batch = db.batch();
            const userRef = db.collection('users').doc(uid);

            // 1. Créditer la balance et mettre à jour les totaux
            batch.update(userRef, {
                balance: admin.firestore.FieldValue.increment(userTotalCredit),
                "totalRevenue.invest": admin.firestore.FieldValue.increment(investDaily),
                "totalRevenue.referral": admin.firestore.FieldValue.increment(referralDaily),
                lastCreditDate: today, // FIX IDEMPOTENCE
                updatedAt: now,
            });

            // 2. Créer une transaction pour investDaily (si > 0)
            if (investDaily > 0) {
                batch.set(db.collection('transactions').doc(), {
                    uid: uid,
                    type: "internal",
                    category: "investment",
                    amount: investDaily,
                    direction: "credit",
                    source: "DailyInvest",
                    target: "Balance",
                    details: "Revenu journalier investissement",
                    createdAt: now,
                });
            }

            // 3. Créer une transaction pour referralDaily (si > 0)
            if (referralDaily > 0) {
                batch.set(db.collection('transactions').doc(), {
                    uid: uid,
                    type: "internal",
                    category: "referral",
                    amount: referralDaily,
                    direction: "credit",
                    source: "DailyReferral",
                    target: "Balance",
                    details: "Revenu journalier parrainage (cascade)",
                    createdAt: now,
                });
            }

            // 4. Incrémenter totalEarned du parrain dans filleuls
            if (userData.referrerUid) {
                const onePercent = Math.round(investDaily * 0.01) + referralDaily;
                if (onePercent > 0) {
                    const filleulMapRef = db.collection("filleuls").doc(userData.referrerUid);
                    // FIX : utiliser set() avec merge: true au lieu de update()
                    // Cela crée le doc s'il n'existe pas, au lieu d'échouer
                    batch.set(filleulMapRef, {
                        [`${uid}.totalEarned`]: admin.firestore.FieldValue.increment(onePercent),
                    }, { merge: true });
                    console.log(`💰 [${uid}] Parrain ${userData.referrerUid} gagne ${formatFr(onePercent)} (tracking).`);
                }
            }

            // ═════════════════════════════════════════════════════════════════
            // Validation & Commit
            // ═════════════════════════════════════════════════════════════════
            await batch.commit();
            console.log(`✅ [${uid}] Crédité de ${formatFr(userTotalCredit)}.`);
            usersProcessed++;
            totalCredit += userTotalCredit;
        }

        // ─────────────────────────────────────────────────────────────────────
        // Résumé
        // ─────────────────────────────────────────────────────────────────────
        const message = `✅ SUCCÈS : ${usersProcessed} utilisateurs crédités (${usersSkipped} skippés). Total distribué : ${formatFr(totalCredit)}.`;
        console.log(message);

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: message,
                usersProcessed: usersProcessed,
                usersSkipped: usersSkipped,
                totalCreditDistributed: totalCredit,
                timestamp: new Date().toISOString(),
            }),
        };

    } catch (error) {
        console.error("❌ ERREUR CRITIQUE :", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Erreur lors de la créditation quotidienne.",
                details: error.message,
                timestamp: new Date().toISOString(),
            }),
        };
    }
};
