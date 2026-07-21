/**
 * Paystack webhook — configure this URL in the Paystack dashboard
 */

const crypto = require('crypto');
const { db } = require('./lib/firebaseAdmin');
const { provisionStudentAccount, recordInstallmentPayment } = require('./lib/provisioning');

exports.handler = async (event) => {
  console.log('🔔 ===== PAYSTACK WEBHOOK RECEIVED =====');
  
  if (event.httpMethod !== 'POST') {
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
    console.log('📦 Event type:', payload.event);
  } catch (err) {
    console.error('❌ Invalid JSON:', err);
    return { statusCode: 400, body: 'Invalid JSON' };
  }
  
  if (payload.event !== 'charge.success') {
    console.log('⏭️ Ignoring event:', payload.event);
    return { statusCode: 200, body: 'Ignored' };
  }
  
  const data = payload.data || {};
  
  // ===== CRITICAL LOGGING: See what Paystack sent =====
  console.log('💳 Payment data received:', JSON.stringify(data, null, 2));
  console.log('📧 Reference from Paystack:', data.reference);
  console.log('📧 Customer email:', data.customer ? data.customer.email : 'No customer');
  console.log('📧 Customer code:', data.customer ? data.customer.customer_code : 'No customer');
  console.log('📧 Channel:', data.channel || 'Unknown');
  
  let appRef = null;
  let appData = null;
  
  // 1. Card payment path — reference is the application doc id directly.
  if (data.reference) {
    console.log('🔍 Looking up application by reference:', data.reference);
    console.log('📄 Full path: applications/' + data.reference);
    const candidate = db.collection('applications').doc(data.reference);
    const snap = await candidate.get();
    if (snap.exists) {
      appRef = candidate;
      appData = snap.data();
      console.log('✅ Found application by reference!');
      console.log('📄 Application data:', JSON.stringify(appData, null, 2));
    } else {
      console.log('❌ NO application found with reference:', data.reference);
      console.log('❌ This is why payment status is not updating!');
    }
  }
  
  // 2. Try matching by customer_code (DVA path)
  if (!appRef && data.customer && data.customer.customer_code) {
    console.log('🔍 Looking up by customer_code:', data.customer.customer_code);
    const q = await db.collection('applications')
      .where('paystackCustomerCode', '==', data.customer.customer_code)
      .limit(1)
      .get();
    if (!q.empty) {
      appRef = q.docs[0].ref;
      appData = q.docs[0].data();
      console.log('✅ Found application by customer_code!');
    } else {
      console.log('❌ No application found by customer_code');
    }
  }
  
  // 3. Try matching by account number
  if (!appRef && data.authorization && data.authorization.receiver_bank_account_number) {
    console.log('🔍 Looking up by account number:', data.authorization.receiver_bank_account_number);
    const q = await db.collection('applications')
      .where('virtualAccountNumber', '==', data.authorization.receiver_bank_account_number)
      .limit(1)
      .get();
    if (!q.empty) {
      appRef = q.docs[0].ref;
      appData = q.docs[0].data();
      console.log('✅ Found application by account number!');
    } else {
      console.log('❌ No application found by account number');
    }
  }
  
  if (!appRef) {
    console.error('❌❌❌ COULD NOT MATCH PAYMENT TO ANY APPLICATION!');
    console.error('🔍 Reference searched:', data.reference);
    console.error('🔍 Customer code searched:', data.customer ? data.customer.customer_code : 'None');
    console.error('🔍 Account number searched:', data.authorization ? data.authorization.receiver_bank_account_number : 'None');
    return { statusCode: 200, body: 'No matching application — acknowledged' };
  }
  
  console.log('✅ MATCH FOUND! Updating payment...');
  console.log('📄 Application ID:', appRef.id);
  
  try {
    const method = data.channel === 'dedicated_nuban' ? 'transfer' : 'card';
    console.log('💰 Recording installment payment with method:', method);
    const { installmentsPaid, previousInstallmentsPaid } = await recordInstallmentPayment(
      appRef, appData, method, data.reference
    );
    console.log('✅ Payment recorded. installmentsPaid:', installmentsPaid);
    console.log('✅ previousInstallmentsPaid:', previousInstallmentsPaid);
    
    if (previousInstallmentsPaid === 0 && installmentsPaid >= 1) {
      console.log('📧 FIRST PAYMENT! Provisioning student account...');
      try {
        await provisionStudentAccount(appRef.id, appData);
        console.log('✅ Student account provisioned and email sent!');
      } catch (err) {
        console.error('❌ provisionStudentAccount failed:', err.message);
        console.error('❌ Full error:', err);
        // Don't fail the webhook – payment is already recorded
      }
    } else {
      console.log('ℹ️ Not first payment or already provisioned');
    }
  } catch (err) {
    console.error('❌ recordInstallmentPayment failed:', err.message);
    console.error('❌ Full error:', err);
    return { statusCode: 500, body: 'Internal error' };
  }
  
  console.log('✅ WEBHOOK COMPLETED SUCCESSFULLY');
  return { statusCode: 200, body: 'OK' };
};