// netlify/functions/fedapay_webhook.js

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import crypto from 'crypto';

// Empêche Firebase d'être initialisé plusieurs fois
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

// Vérification signature — sécurité FedaPay
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

// Le JSON est vérifié, on peut traiter
let data;
try {
data = JSON.parse(rawBody);
} catch (err) {
return {
statusCode: 400,
body: "Invalid JSON payload",
};
}

const eventType = data?.event;
const transaction = data?.data;

if (!eventType || !transaction) {
return {
statusCode: 400,
body: "Invalid FedaPay event structure",
};
}

// On ne traite QUE les dépôts ici
if (eventType !== "transaction.approved") {
return {
statusCode: 200,
body: "Event ignored",
};
}

const fedapayId = transaction.id;
const amount = transaction.amount;
const customerId = transaction.customer?.id;

const metadata = transaction.metadata || {};
const userUid = metadata.userUid;

if (!userUid) {
return {
statusCode: 400,
body: "Missing userUid metadata",
};
}

try {
const userRef = db.collection("users").doc(userUid);

// On ajoute la transaction au sous-doc "deposits"
await userRef
.collection("deposits")
.doc(String(fedapayId))
.set({
id: fedapayId,
amount: amount,
customerId: customerId || null,
status: "approved",
createdAt: new Date(),
});

// On augmente le solde utilisateur
await userRef.update({
balance: (await userRef.get()).data().balance + amount,
});

return {
statusCode: 200,
body: "Deposit processed",
};
} catch (e) {
return {
statusCode: 500,
body: "Error processing deposit: " + e.message,
};
}
}