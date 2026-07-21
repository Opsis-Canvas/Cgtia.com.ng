/**
 * Paystack webhook — configure this URL in the Paystack dashboard
 * (Settings → API Keys & Webhooks):
 *
 *   https://YOUR-SITE.netlify.app/.netlify/functions/paystack-webhook
 *
 * Paystack calls this server-to-server after a successful payment.
 */

const crypto = require('crypto');
const { db } = require('./lib/firebaseAdmin');
const { provisionStudentAccount, recordInstallmentPayment } = require('./lib/provisioning');

exports.handler = async (event) => {
  console.log('🔔 Webhook received!');
  console.log('Method:', event.httpMethod);
  console.log('Headers:', JSON.stringify(event.headers, null, 2));

  if (event.httpMethod !== 'POST') {
    console.log('❌ Method not allowed');
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const signature = event.headers['x-paystack-signature'];
  const secret = process.env.PAYSTACK_SECRET_KEY;

  console.log('🔑 Signature present?', !!signature);
  console.log('🔑 Secret present?', !!secret);

  if (!signature || !secret) {
    console.error('❌ Missing signature or secret');
    return { statusCode: 401, body: 'Missing signature or secret' };
  }

  const expected = crypto.createHmac('sha512', secret).update(event.body).digest('hex');
  console.log('🔐 Signature matches?', signature === expected);

  if (signature !== expected) {
    console.error('❌ Invalid signature');
    return { statusCode: 401, body: 'Invalid signature' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
    console.log('📦 Payload parsed:', JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('❌ Invalid JSON:', err);
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  if (payload.event !== 'charge.success') {
    console.log('⏭️ Ignoring event:', payload.event);
    return { statusCode: 200, body: 'Ignored' };
  }

  const data = payload.data || {};
  console.log('💳 Payment data:', JSON.stringify(data, null, 2));

  let appRef = null;
  let appData = null;

  // 1. Card payment path — reference is the application doc id directly.
  if (data.reference) {
    console.log('🔍 Looking up by reference:', data.reference);
    const candidate = db.collection('applications').doc(data.reference);
    const snap = await candidate.get();
    if (snap.exists) {
      appRef = candidate;
      appData = snap.data();
      console.log('✅ Found application by reference');
    } else {
      console.log('❌ No application found by reference:', data.reference);
    }
  }

  // 2. Dedicated Virtual Account transfer path — match by customer_code.
  if (!appRef && data.customer && data.customer.customer_code) {
    console.log('🔍 Looking up by customer_code:', data.customer.customer_code);
    const q = await db.collection('applications')
      .where('paystackCustomerCode', '==', data.customer.customer_code)
      .limit(1)
      .get();
    if (!q.empty) {
      appRef = q.docs[0].ref;
      appData = q.docs[0].data();
      console.log('✅ Found application by customer_code');
    } else {
      console.log('❌ No application found by customer_code');
    }
  }

  // 3. Fallback: match by the receiving account number directly.
  if (!appRef && data.authorization && data.authorization.receiver_bank_account_number) {
    console.log('🔍 Looking up by account number:', data.authorization.receiver_bank_account_number);
    const q = await db.collection('applications')
      .where('virtualAccountNumber', '==', data.authorization.receiver_bank_account_number)
      .limit(1)
      .get();
    if (!q.empty) {
      appRef = q.docs[0].ref;
      appData = q.docs[0].data();
      console.log('✅ Found application by account number');
    } else {
      console.log('❌ No application found by account number');
    }
  }

  if (!appRef) {
    console.error('❌ Could not match payment to any application');
    return { statusCode: 200, body: 'No matching application — acknowledged' };
  }

  console.log('📄 Application data:', JSON.stringify(appData, null, 2));
  console.log('💰 Recording installment payment...');

  try {
    const method = data.channel === 'dedicated_nuban' ? 'transfer' : 'card';
    const { installmentsPaid, previousInstallmentsPaid } = await recordInstallmentPayment(
      appRef, appData, method, data.reference
    );
    console.log('✅ Payment recorded. installmentsPaid:', installmentsPaid);

    if (previousInstallmentsPaid === 0 && installmentsPaid >= 1) {
      console.log('📧 Provisioning student account...');
      try {
        await provisionStudentAccount(appRef.id, appData);
        console.log('✅ Student account provisioned and email sent');
      } catch (err) {
        console.error('❌ provisionStudentAccount failed:', err);
      }
    }
  } catch (err) {
    console.error('❌ recordInstallmentPayment failed:', err);
    return { statusCode: 500, body: 'Internal error' };
  }

  console.log('✅ Webhook completed successfully');
  return { statusCode: 200, body: 'OK' };
};