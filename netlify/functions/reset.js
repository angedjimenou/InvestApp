// netlify/functions/reset_all_data.js

const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

// Initialisation Firebase Admin
if (!admin.apps.length) {
    const decodedServiceAccount = Buffer.from(process.env.FIREBASE_ADMIN_CREDENTIALS, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(decodedServiceAccount);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = getFirestore();

exports.handler = async (event, context) => {
    try {
        console.log("🔄 Démarrage du reset complet...");

        // 1. VIDER collection transactions
        console.log("🗑️  Suppression de toutes les transactions...");
        const txSnap = await db.collection('transactions').get();
        const txBatch = db.batch();
        let txCount = 0;
        txSnap.docs.forEach(doc => {
            txBatch.delete(doc.ref);
            txCount++;
        });
        if (txCount > 0) await txBatch.commit();
        console.log(`✅ ${txCount} transactions supprimées`);

        // 2. VIDER collection investments
        console.log("🗑️  Suppression de tous les investissements...");
        const invSnap = await db.collection('investments').get();
        const invBatch = db.batch();
        let invCount = 0;
        invSnap.docs.forEach(doc => {
            invBatch.delete(doc.ref);
            invCount++;
        });
        if (invCount > 0) await invBatch.commit();
        console.log(`✅ ${invCount} investissements supprimés`);

        // 3. RESET tous les utilisateurs
        console.log("🔄 Réinitialisation de tous les utilisateurs...");
        const usersSnap = await db.collection('users').get();
        const userBatch = db.batch();
        let userCount = 0;

        usersSnap.docs.forEach(doc => {
            userBatch.update(doc.ref, {
                balance: 100000,
                daily: {
                    invest: 0,
                    referral: 0
                },
                totalRevenue: {
                    invest: 0,
                    referral: 0
                },
                firstInvestmentDone: false,
                lastCreditDate: null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            userCount++;
        });

        if (userCount > 0) await userBatch.commit();
        console.log(`✅ ${userCount} utilisateurs réinitialisés à 100 000 F`);

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: "Reset complet effectué",
                stats: {
                    transactionsDeleted: txCount,
                    investmentsDeleted: invCount,
                    usersReset: userCount,
                    newBalance: 100000
                }
            })
        };

    } catch (err) {
        console.error("❌ Erreur lors du reset:", err);
        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                error: err.message
            })
        };
    }
};
