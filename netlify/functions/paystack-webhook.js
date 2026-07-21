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
  console.log('📧 Metadata:', data.metadata ? JSON.stringify(data.metadata) : 'No metadata');
  
  let appRef = null;
  let appData = null;
  
  // ============================================================
  // 1. PRIMARY MATCH: Use metadata.applicationId (frontend sends this)
  // ============================================================
  const appIdFromMetadata = data.metadata && data.metadata.applicationId;
  if (appIdFromMetadata) {
    console.log('🔍 [PRIMARY] Looking up by metadata.applicationId:', appIdFromMetadata);
    console.log('📄 Full path: applications/' + appIdFromMetadata);
    const candidate = db.collection('applications').doc(appIdFromMetadata);
    const snap = await candidate.get();
    if (snap.exists) {
      appRef = candidate;
      appData = snap.data();
      console.log('✅ [PRIMARY] Found application by metadata.applicationId!');
      console.log('📄 Application email:', appData.email);
    } else {
      console.log('❌ [PRIMARY] NO application found with metadata.applicationId:', appIdFromMetadata);
    }
  }
  
  // ============================================================
  // 2. FALLBACK 1: Try by reference (Paystack might have preserved it)
  // ============================================================
  if (!appRef && data.reference) {
    console.log('🔍 [FALLBACK 1] Looking up by reference:', data.reference);
    console.log('📄 Full path: applications/' + data.reference);
    const candidate = db.collection('applications').doc(data.reference);
    const snap = await candidate.get();
    if (snap.exists) {
      appRef = candidate;
      appData = snap.data();
      console.log('✅ [FALLBACK 1] Found application by reference!');
    } else {
      console.log('❌ [FALLBACK 1] No application found by reference:', data.reference);
    }
  }
  
  // ============================================================
  // 3. FALLBACK 2: Try by customer_code (DVA path)
  // ============================================================
  if (!appRef && data.customer && data.customer.customer_code) {
    console.log('🔍 [FALLBACK 2] Looking up by customer_code:', data.customer.customer_code);
    const q = await db.collection('applications')
      .where('paystackCustomerCode', '==', data.customer.customer_code)
      .limit(1)
      .get();
    if (!q.empty) {
      appRef = q.docs[0].ref;
      appData = q.docs[0].data();
      console.log('✅ [FALLBACK 2] Found application by customer_code!');
    } else {
      console.log('❌ [FALLBACK 2] No application found by customer_code');
    }
  }
  
  // ============================================================
  // 4. FALLBACK 3: Try by account number
  // ============================================================
  if (!appRef && data.authorization && data.authorization.receiver_bank_account_number) {
    console.log('🔍 [FALLBACK 3] Looking up by account number:', data.authorization.receiver_bank_account_number);
    const q = await db.collection('applications')
      .where('virtualAccountNumber', '==', data.authorization.receiver_bank_account_number)
      .limit(1)
      .get();
    if (!q.empty) {
      appRef = q.docs[0].ref;
      appData = q.docs[0].data();
      console.log('✅ [FALLBACK 3] Found application by account number!');
    } else {
      console.log('❌ [FALLBACK 3] No application found by account number');
    }
  }
  
  // ============================================================
  // 5. Check if we found anything
  // ============================================================
  if (!appRef) {
    console.error('❌❌❌ COULD NOT MATCH PAYMENT TO ANY APPLICATION!');
    console.error('🔍 Metadata.applicationId searched:', data.metadata ? data.metadata.applicationId : 'None');
    console.error('🔍 Reference searched:', data.reference || 'None');
    console.error('🔍 Customer code searched:', data.customer ? data.customer.customer_code : 'None');
    console.error('🔍 Account number searched:', data.authorization ? data.authorization.receiver_bank_account_number : 'None');
    return { statusCode: 200, body: 'No matching application — acknowledged' };
  }
  
  console.log('✅ MATCH FOUND! Updating payment...');
  console.log('📄 Application ID:', appRef.id);
  console.log('📄 Application email:', appData.email);
  
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