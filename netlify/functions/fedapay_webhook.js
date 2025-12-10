// netlify/functions/fedapay_webhook.js
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import crypto from 'crypto';

// Initialisation Firebase (évite doublons)
try { initializeApp(); } catch(e){}

const db = getFirestore();

export default async function handler(event) {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    const webhookSecret = process.env.FEDAPAY_WEBHOOK_SECRET;
    if (!webhookSecret) return { statusCode: 500, body: "Missing FEDAPAY_WEBHOOK_SECRET" };

    const signature = event.headers["x-fedapay-signature"];
    const timestamp = event.headers["x-fedapay-timestamp"];
    if (!signature || !timestamp) return { statusCode: 400, body: "Missing signature headers" };

    const rawBody = event.body;

    // Vérification signature
    const signedPayload = `${timestamp}.${rawBody}`;
    const expectedSignature = crypto
        .createHmac("sha256", webhookSecret)
        .update(signedPayload)
        .digest("hex");

    if (expectedSignature !== signature) {
        return { statusCode: 401, body: "Invalid signature" };
    }

    let data;
    try { data = JSON.parse(rawBody); } catch(err) {
        return { statusCode: 400, body: "Invalid JSON payload" };
    }

    const eventType = data?.event;
    const transactionData = data?.data;
    if (!eventType || !transactionData) return { statusCode: 400, body: "Invalid FedaPay event structure" };

    const fedapayId = transactionData.id;
    const metadata = transactionData.metadata || {};
    const uid = metadata.uid;

    if (!uid) return { statusCode: 400, body: "Missing userUid metadata" };

    try {
        const userRef = db.collection("users").doc(uid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) return { statusCode: 404, body: "User not found" };

        const userData = userSnap.data();
        const txRef = db.collection("transactions").doc(String(fedapayId));
        const now = new Date();

        let statusToSet = "pending"; // par défaut

        if (eventType === "transaction.approved") {
            statusToSet = "approved";
            const amount = transactionData.amount || 0;
            await userRef.update({
                balance: (userData.balance || 0) + amount,
                updatedAt: now
            });
        } else if (eventType === "transaction.declined" || eventType === "transaction.canceled") {
            statusToSet = eventType === "transaction.declined" ? "declined" : "canceled";
        } else {
            // Ignore autres événements pour l'instant
            return { statusCode: 200, body: "Event ignored" };
        }

        // Mise à jour ou création de la transaction
        await txRef.set({
            uid,
            type: "external",
            category: "deposit",
            amount: transactionData.amount || 0,
            currencyIso: transactionData.currency?.iso || "XOF",
            paymentMethodId: metadata.paymentMethodId || null,
            operator: metadata.operator || null,
            merchantReference: transactionData.merchant_reference || null,
            transactionId: fedapayId,
            status: statusToSet,
            updatedAt: now,
            metadata: {
                ...metadata,
                originalData: transactionData
            }
        }, { merge: true });

        return { statusCode: 200, body: "Transaction processed" };

    } catch (e) {
        console.error("Webhook error:", e);
        return { statusCode: 500, body: "Error processing transaction: " + e.message };
    }
}