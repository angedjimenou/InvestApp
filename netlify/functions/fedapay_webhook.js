// netlify/functions/fedapay_webhook.js
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import crypto from 'crypto';

// Initialisation Firebase (évite doublons)
try { initializeApp(); } catch(e){}

const db = getFirestore();

export async function handler(event, context) {
    if (event.httpMethod !== "POST") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405 });
    }

    const webhookSecret = process.env.FEDAPAY_WEBHOOK_SECRET;
    if (!webhookSecret) return new Response("Missing FEDAPAY_WEBHOOK_SECRET", { status: 500 });

    const signature = event.headers["x-fedapay-signature"];
    const timestamp = event.headers["x-fedapay-timestamp"];
    if (!signature || !timestamp) return new Response("Missing signature headers", { status: 400 });

    const rawBody = event.body;

    // Vérification signature
    const signedPayload = `${timestamp}.${rawBody}`;
    const expectedSignature = crypto
        .createHmac("sha256", webhookSecret)
        .update(signedPayload)
        .digest("hex");

    if (expectedSignature !== signature) {
        return new Response("Invalid signature", { status: 401 });
    }

    let data;
    try { data = JSON.parse(rawBody); } catch(err) {
        return new Response("Invalid JSON payload", { status: 400 });
    }

    const eventType = data?.event;
    const transactionData = data?.data;
    if (!eventType || !transactionData) return new Response("Invalid FedaPay event structure", { status: 400 });

    const fedapayId = transactionData.id;
    const metadata = transactionData.metadata || {};
    const uid = metadata.uid;

    if (!uid) return new Response("Missing userUid metadata", { status: 400 });

    try {
        const userRef = db.collection("users").doc(uid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) return new Response("User not found", { status: 404 });

        const userData = userSnap.data();
        const txRef = db.collection("transactions").doc(String(fedapayId));
        const now = new Date();

        let statusToSet = "pending";

        if (eventType === "transaction.approved") {
            statusToSet = "approved";
            const amount = transactionData.amount || 0;
            await userRef.update({
                balance: (userData.balance || 0) + amount,
                updatedAt: now
            });
        } else if (eventType === "transaction.declined") {
            statusToSet = "declined";
        } else if (eventType === "transaction.canceled") {
            statusToSet = "canceled";
        } else {
            // Ignorer autres événements pour l'instant
            return new Response("Event ignored", { status: 200 });
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

        return new Response(JSON.stringify({ success: true }), { status: 200 });

    } catch (e) {
        console.error("Webhook error:", e);
        return new Response(JSON.stringify({ error: "Error processing transaction", message: e.message }), { status: 500 });
    }
}