/**
 * Run this ONCE, locally, to create your very first admin account.
 * After that, use the `setAdminRole` Cloud Function (called by an existing
 * admin) to promote anyone else — you should not need to run this script
 * again.
 *
 * Setup:
 *   1. In the Firebase Console → Project Settings → Service Accounts,
 *      generate a new private key and save it as serviceAccountKey.json
 *      in this same `scripts/` folder. Do NOT commit this file — add it to
 *      .gitignore.
 *   2. npm install firebase-admin (in this scripts/ folder, or reuse
 *      functions/node_modules if running from there).
 *   3. Edit the EMAIL, PASSWORD, and NAME constants below.
 *   4. node scripts/createFirstAdmin.js
 */

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const EMAIL = 'you@cgtia.org';
const PASSWORD = 'ChangeThisTemporaryPassword123!';
const NAME = 'CGTIA Admin';

async function run() {
  const user = await admin.auth().createUser({
    email: EMAIL,
    password: PASSWORD,
    displayName: NAME,
    emailVerified: true
  });

  await admin.auth().setCustomUserClaims(user.uid, { role: 'admin' });

  await admin.firestore().collection('users').doc(user.uid).set({
    email: EMAIL,
    fullName: NAME,
    role: 'admin',
    mustChangePassword: true,
    status: 'active',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  console.log('First admin created:', user.uid);
  console.log('Sign in with the email/password above, then change the password immediately.');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
