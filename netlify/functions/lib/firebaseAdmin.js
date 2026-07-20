const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_B64 ?
    JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString()) :
    undefined;
  
  admin.initializeApp({
    credential: serviceAccount ?
      admin.credential.cert(serviceAccount) :
      admin.credential.applicationDefault(),
  });
}

const db = admin.firestore();

module.exports = { admin, db };