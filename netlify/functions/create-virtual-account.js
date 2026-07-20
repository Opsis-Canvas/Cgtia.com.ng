/**
 * Called by the frontend when someone opens the Bank Transfer tab on the
 * payment screen. Creates a Paystack customer + Dedicated Virtual Account
 * (DVA) unique to this application, so incoming transfers can be matched
 * and confirmed automatically via the webhook — no more manual "I've made
 * this transfer, please check" review needed for the common case.
 *
 * IMPORTANT: Dedicated Virtual Accounts require your Paystack business to
 * be verified and specifically enabled for this feature — it is NOT
 * available on every account by default. If it fails here (e.g. because
 * that hasn't been activated yet, or you're in test mode where DVA support
 * varies), the frontend falls back to displaying your static shared bank
 * account instead, exactly like before this feature existed.
 */

const { db } = require('./lib/firebaseAdmin');
const { createCustomer, createDedicatedAccount } = require('./lib/paystack');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { applicationId, email, fullName, phone } = body;
  if (!applicationId || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'applicationId and email are required' }) };
  }

  try {
    const appRef = db.collection('applications').doc(applicationId);
    const appSnap = await appRef.get();
    if (!appSnap.exists) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Application not found' }) };
    }
    const appData = appSnap.data();

    // Reuse an existing virtual account if one was already created for
    // this application (e.g. they closed and reopened the payment screen).
    if (appData.virtualAccountNumber) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          accountNumber: appData.virtualAccountNumber,
          bankName: appData.virtualAccountBank,
          accountName: appData.virtualAccountName
        })
      };
    }

    const nameParts = (fullName || '').trim().split(/\s+/).filter(Boolean);
    const firstName = nameParts[0] || 'Applicant';
    const lastName = nameParts.slice(1).join(' ') || 'CGTIA';

    const customer = await createCustomer({ email, firstName, lastName, phone });
    const dva = await createDedicatedAccount({ customerCode: customer.customer_code });

    await appRef.update({
      paystackCustomerCode: customer.customer_code,
      virtualAccountNumber: dva.account_number,
      virtualAccountBank: dva.bank ? dva.bank.name : '',
      virtualAccountName: dva.account_name,
      updatedAt: new Date()
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        accountNumber: dva.account_number,
        bankName: dva.bank ? dva.bank.name : '',
        accountName: dva.account_name
      })
    };
  } catch (err) {
    console.error('create-virtual-account failed', err);
    // Signal the frontend to fall back to the static shared account rather
    // than showing the person a dead end.
    return {
      statusCode: 200,
      body: JSON.stringify({ fallback: true, reason: err.message || 'Virtual accounts are not available right now.' })
    };
  }
};
