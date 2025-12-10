// netlify/functions/fedapay_webhook.js

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import crypto from 'crypto';

// Initialisation Firebase (évite doublons)
try { initializeApp(); } catch (e) {}

const db = getFirestore();

export default async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const webhookSecret = process.env.FEDAPAY_WEBHOOK_SECRET;
    if (!webhookSecret) return new Response("Missing FEDAPAY_WEBHOOK_SECRET", { status: 500 });

    const signature = event.headers["x-fedapay-signature"];
    const timestamp = event.headers["x-fedapay-timestamp"];
    if (!signature || !timestamp) return new Response("Missing signature headers", { status: 400 });

    const rawBody = event.body;
    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");

    if (expectedSignature !== signature) return new Response("Invalid signature", { status: 401 });

    let data;
    try { data = JSON.parse(rawBody); } catch { return new Response("Invalid JSON payload", { status: 400 }); }

    const eventType = data?.event;
    const transaction = data?.data;
    if (!eventType || !transaction) return new Response("Invalid FedaPay event structure", { status: 400 });

    // Seules les transactions
    if (!eventType.startsWith("transaction.")) return new Response("Event ignored", { status: 200 });

    const fedapayId = transaction.id;
    const amount = transaction.amount || 0;
    const customerId = transaction.customer?.id || null;
    const metadata = transaction.metadata || {};
    const userUid = metadata.userUid;
    if (!userUid) return new Response("Missing userUid metadata", { status: 400 });

    const userRef = db.collection("users").doc(userUid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return new Response("User not found", { status: 404 });

    const userData = userSnap.data();
    let newBalance = userData.balance || 0;
    const now = new Date();

    // Déterminer le statut
    let status = "pending";
    switch (eventType) {
      case "transaction.created": status = "pending"; break;
      case "transaction.approved": status = "approved"; break;
      case "transaction.declined": status = "declined"; break;
      case "transaction.canceled": status = "canceled"; break;
      case "transaction.refunded": status = "refunded"; break;
    }

    // Mettre à jour le solde uniquement si approved
    if (status === "approved") {
      newBalance += amount;
      await userRef.update({ balance: newBalance, updatedAt: now });
    }

    // Créer la transaction dans la collection globale
    await db.collection("transactions").doc(String(fedapayId)).set({
      uid: userUid,
      type: "external",
      category: "deposit",
      amount,
      direction: status === "approved" ? "credit" : "none",
      source: "FedaPay",
      target: "Balance",
      status,
      metadata: { customerId, originalData: transaction },
      timestamp: now,
    });

    return new Response(`Transaction ${status} processed`, { status: 200 });

  } catch (e) {
    return new Response("Internal Server Error: " + e.message, { status: 500 });
  }
}