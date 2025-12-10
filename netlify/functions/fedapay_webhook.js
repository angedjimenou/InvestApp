// netlify/functions/fedapay_webhook.js

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import crypto from 'crypto';

// Initialisation Firebase (évite les doublons)
try {
  initializeApp();
} catch (e) {}

const db = getFirestore();

export default async function handler(event, context) {
  if (event.httpMethod !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const webhookSecret = process.env.FEDAPAY_WEBHOOK_SECRET;
  if (!webhookSecret) return new Response("Missing FEDAPAY_WEBHOOK_SECRET", { status: 500 });

  const signature = event.headers.get("x-fedapay-signature");
  const timestamp = event.headers.get("x-fedapay-timestamp");

  if (!signature || !timestamp) return new Response("Missing signature headers", { status: 400 });

  const rawBody = event.body;

  // Vérification de la signature FedaPay
  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSignature = crypto
    .createHmac("sha256", webhookSecret)
    .update(signedPayload)
    .digest("hex");

  if (expectedSignature !== signature) {
    return new Response("Invalid signature", { status: 401 });
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (err) {
    return new Response("Invalid JSON payload", { status: 400 });
  }

  const eventType = data?.event;
  const transaction = data?.data;

  if (!eventType || !transaction) {
    return new Response("Invalid FedaPay event structure", { status: 400 });
  }

  // On ne traite QUE les transactions de paiement
  if (!eventType.startsWith("transaction.")) {
    return new Response("Event ignored", { status: 200 });
  }

  const fedapayId = transaction.id;
  const amount = transaction.amount;
  const customerId = transaction.customer?.id || null;
  const metadata = transaction.metadata || {};
  const userUid = metadata.userUid;

  if (!userUid) return new Response("Missing userUid metadata", { status: 400 });

  try {
    const userRef = db.collection("users").doc(userUid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return new Response("User not found", { status: 404 });

    const now = new Date();
    let status = "pending";

    // Déterminer le statut selon l'événement FedaPay
    switch (eventType) {
      case "transaction.approved":
        status = "approved";
        break;
      case "transaction.declined":
      case "transaction.canceled":
        status = "declined";
        break;
      default:
        status = "pending";
    }

    // Créer la transaction dans la collection globale
    await db.collection("transactions").doc(String(fedapayId)).set({
      uid: userUid,
      type: "external",          // paiement externe
      category: "deposit",
      amount: amount,
      direction: "credit",
      source: "FedaPay",
      target: "Balance",
      status: status,
      metadata: {
        customerId,
        originalData: transaction,
      },
      timestamp: now,
    });

    // Si la transaction est approuvée, mettre à jour le solde
    if (status === "approved") {
      await userRef.update({
        balance: FieldValue.increment(amount),
        updatedAt: now,
      });
    }

    return new Response("Transaction processed", { status: 200 });
  } catch (e) {
    console.error("Error processing transaction:", e);
    return new Response("Error processing transaction: " + e.message, { status: 500 });
  }
}