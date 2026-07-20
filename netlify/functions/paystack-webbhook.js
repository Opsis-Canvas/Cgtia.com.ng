/**
 * Paystack webhook — configure this URL in the Paystack dashboard
 * (Settings → API Keys & Webhooks):
 *
 *   https://YOUR-SITE.netlify.app/.netlify/functions/paystack-webhook
 *
 * Paystack calls this server-to-server after a successful payment; it is
 * never called by the browser. Handles BOTH payment paths the site
 * supports:
 *   - Card payments: the `reference` Paystack sends back IS the Firestore
 *     `applications` document id (the frontend sets this explicitly when
 *     it opens the Paystack popup).
 *   - Dedicated Virtual Account transfers: there's no meaningful
 *     `reference` to match on, so this instead matches by the Paystack
 *     customer_code that was stored on the application doc when its
 *     virtual account was created.
 */

const crypto = require('crypto');
const { db } = require('./lib/firebaseAdmin');
const { provisionStudentAccount, recordInstallmentPayment } = require('./lib/provisioning');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const signature = event.headers['x-paystack-signature'];
  const secret = process.env.PAYSTACK_SECRET_KEY;

  if (!signature || !secret) {
    return { statusCode: 401, body: 'Missing signature or secret' };
  }

  const expected = crypto.createHmac('sha512', secret).update(event.body).digest('hex');
  if (signature !== expected) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (err) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  if (payload.event !== 'charge.success') {
    // Other events (e.g. dedicatedaccount.assign.success just confirms an
    // account was created, not that money moved) are safe to ignore.
    return { statusCode: 200, body: 'Ignored' };
  }

  const data = payload.data || {};
  let appRef = null;
  let appData = null;

  // 1. Card payment path — reference is the application doc id directly.
  if (data.reference) {
    const candidate = db.collection('applications').doc(data.reference);
    const snap = await candidate.get();
    if (snap.exists) {
      appRef = candidate;
      appData = snap.data();
    }
  }

  // 2. Dedicated Virtual Account transfer path — match by customer_code.
  if (!appRef && data.customer && data.customer.customer_code) {
    const q = await db.collection('applications')
      .where('paystackCustomerCode', '==', data.customer.customer_code)
      .limit(1)
      .get();
    if (!q.empty) {
      appRef = q.docs[0].ref;
      appData = q.docs[0].data();
    }
  }

  // 3. Fallback: match by the receiving account number directly, in case
  //    the customer_code path doesn't line up for some reason.
  if (!appRef && data.authorization && data.authorization.receiver_bank_account_number) {
    const q = await db.collection('applications')
      .where('virtualAccountNumber', '==', data.authorization.receiver_bank_account_number)
      .limit(1)
      .get();
    if (!q.empty) {
      appRef = q.docs[0].ref;
      appData = q.docs[0].data();
    }
  }

  if (!appRef) {
    console.error('paystack-webhook: could not match payment to any application', {
      reference: data.reference,
      customerCode: data.customer && data.customer.customer_code
    });
    // Still return 200 — Paystack will retry on non-2xx, and retrying won't
    // help if we genuinely can't find a match.
    return { statusCode: 200, body: 'No matching application — acknowledged' };
  }

  const method = data.channel === 'dedicated_nuban' ? 'transfer' : 'card';
  const { installmentsPaid, previousInstallmentsPaid } = await recordInstallmentPayment(
    appRef, appData, method, data.reference
  );

  if (previousInstallmentsPaid === 0 && installmentsPaid >= 1) {
    try {
      await provisionStudentAccount(appRef.id, appData);
    } catch (err) {
      // Payment is already recorded at this point — don't let a
      // provisioning hiccup make Paystack think the webhook failed and
      // retry (which could double-charge logic elsewhere). Log loudly so
      // staff can provision manually if needed.
      console.error('provisionStudentAccount failed after successful payment', appRef.id, err);
    }
  }

  return { statusCode: 200, body: 'OK' };
};
