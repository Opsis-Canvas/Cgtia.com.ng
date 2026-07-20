/**
 * Manual fallback for staff to confirm a payment by hand — useful if
 * Dedicated Virtual Accounts aren't enabled yet, the webhook missed
 * something, or someone paid in a way that doesn't auto-reconcile.
 * Requires a valid Firebase ID token for a user with the admin custom
 * claim, passed as `Authorization: Bearer <token>`.
 */

const { admin, db } = require('./lib/firebaseAdmin');
const { provisionStudentAccount, recordInstallmentPayment } = require('./lib/provisioning');

async function requireAdmin(event) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const idToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!idToken) throw new Error('No auth token provided');
  const decoded = await admin.auth().verifyIdToken(idToken);
  if (decoded.role !== 'admin') throw new Error('Admin role required');
  return decoded;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    await requireAdmin(event);
  } catch (err) {
    return { statusCode: 403, body: JSON.stringify({ error: err.message }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { applicationId } = body;
  if (!applicationId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'applicationId is required' }) };
  }

  try {
    const appRef = db.collection('applications').doc(applicationId);
    const appSnap = await appRef.get();
    if (!appSnap.exists) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Application not found' }) };
    }
    const appData = appSnap.data();

    const { installmentsPaid, previousInstallmentsPaid } = await recordInstallmentPayment(
      appRef, appData, 'transfer', null
    );

    if (previousInstallmentsPaid === 0 && installmentsPaid >= 1) {
      await provisionStudentAccount(applicationId, appData);
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('confirm-transfer failed', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong confirming this payment.' }) };
  }
};
