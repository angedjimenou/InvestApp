// netlify/functions/fedapay_webhook.js

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import crypto from 'crypto';

// Initialisation Firebase (évite les doublons)
try {
  initializeApp();
} catch (e) {}

const db = getFirestore();

export default async function handler(event, context) {
  // Autoriser uniquement POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: "Method Not Allowed",
    };
  }

  const webhookSecret = process.env.FEDAPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return {
      statusCode: 500,
      body: "Missing FEDAPAY_WEBHOOK_SECRET",
    };
  }

  const signature = event.headers["x-fedapay-signature"];
  const timestamp = event.headers["x-fedapay-timestamp"];
  if (!signature || !timestamp) {
    return {
      statusCode: 400,
      body: "Missing signature headers",
    };
  }

  const rawBody = event.body;

  // Vérification de la signature
  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSignature = crypto
    .createHmac("sha256", webhookSecret)
    .update(signedPayload)
    .digest("hex");

  if (expectedSignature !== signature) {
    return {
      statusCode: 401,
      body: "Invalid signature",
    };
  }

  // Parse JSON
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (err) {
    return { statusCode: 400, body: "Invalid JSON payload" };
  }

  const eventType = data?.event;
  const transaction = data?.data;

  if (!eventType || !transaction) {
    return { statusCode: 400, body: "Invalid FedaPay event structure" };
  }

  // Ne traite que les événements transactionnels
  if (!eventType.startsWith("transaction.")) {
    return { statusCode: 200, body: "Event ignored" };
  }

  const fedapayId = transaction.id;
  const amount = transaction.amount || 0;
  const customerId = transaction.customer?.id || null;
  const metadata = transaction.metadata || {};
  const userUid = metadata.userUid;

  if (!userUid) {
    return { statusCode: 400, body: "Missing userUid metadata" };
  }

  const now = new Date();

  // Détermine le statut à enregistrer dans transactions
  let status = "pending";
  switch (eventType) {
    case "transaction.created":
      status = "pending";
      break;
    case "transaction.approved":
      status = "approved";
      break;
    case "transaction.declined":
      status = "declined";
      break;
    case "transaction.canceled":
      status = "canceled";
      break;
    case "transaction.refunded":
      status = "refunded";
      break;
  }

  try {
    const userRef = db.collection("users").doc(userUid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return { statusCode: 404, body: "User not found" };
    }

    const userData = userSnap.data();
    let newBalance = userData.balance || 0;

    // Seule une transaction approuvée crédite le solde
    if (status === "approved") {
      newBalance += amount;
      await userRef.update({
        balance: newBalance,
        updatedAt: now,
      });
    }

    // Enregistre la transaction dans la collection globale
    await db.collection("transactions").doc(String(fedapayId)).set({
      uid: userUid,
      type: "external",       // paiement externe
      category: "deposit",    // dépôt
      amount,
      direction: status === "approved" ? "credit" : "none",
      source: "FedaPay",
      target: "Balance",
      status,
      metadata: {
        customerId,
        originalData: transaction,
      },
      timestamp: now,
    });

    return {
      statusCode: 200,
      body: `Transaction ${status} processed`,
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: "Error processing transaction: " + e.message,
    };
  }
}