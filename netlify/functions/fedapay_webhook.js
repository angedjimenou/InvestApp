const admin = require('firebase-admin');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

if (!admin.apps.length) {
    const decodedServiceAccount = Buffer.from(
        process.env.FIREBASE_ADMIN_CREDENTIALS,
        'base64'
    ).toString('utf8');
    const serviceAccount = JSON.parse(decodedServiceAccount);
    initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = getFirestore();

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: "Méthode non autorisée." };
    }

    try {
        let body = {};

        try {
            body = JSON.parse(event.body);
        } catch (err) {
            console.error("Erreur parsing JSON:", err);
            return { statusCode: 400, body: "Invalid JSON" };
        }

        console.log("Webhook body:", body);

        // Event type (peut varier)
        const eventType = body.type || body.event || "unknown";

        // Récupération des données selon le format FedaPay
        const data =
            body.data?.object ||
            body.data ||
            body.transaction ||
            body.payment_request ||
            body;

        if (!data) {
            console.error("Webhook sans data.");
            return { statusCode: 400, body: "No data" };
        }

        // ID transaction
        const transactionId = data.id || data.transaction_id;

        if (!transactionId) {
            console.error("Aucun transactionId détecté");
            return { statusCode: 400, body: "Missing transactionId" };
        }

        console.log("Transaction ID:", transactionId);

        // 📌 Chercher DANS TRANSACTIONS (et pas deposits)
        const txRef = db.collection("transactions").doc(String(transactionId));
        const txSnap = await txRef.get();

        if (!txSnap.exists) {
            console.error("Transaction introuvable dans /transactions");
            return { statusCode: 404, body: "Transaction not found" };
        }

        const tx = txSnap.data();
        const newStatus = data.status || data.state;

        // 📌 Mettre à jour la transaction
        await txRef.update({
            status: newStatus,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log("Transaction mise à jour avec succès :", newStatus);

        // 📌 Mise à jour du solde si confirmé
        if (["approved", "confirmed", "completed"].includes(newStatus)) {
            const userRef = db.collection("users").doc(tx.uid);

            await db.runTransaction(async (t) => {
                const userSnap = await t.get(userRef);
                const user = userSnap.data() || {};

                const balance = user.balance || 0;
                const newBalance = balance + tx.amount;

                t.update(userRef, { balance: newBalance });

                console.log("Solde mis à jour :", newBalance);
            });
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true })
        };

    } catch (err) {
        console.error("Erreur webhook FedaPay:", err);
        return { statusCode: 500, body: "Webhook server error" };
    }
};