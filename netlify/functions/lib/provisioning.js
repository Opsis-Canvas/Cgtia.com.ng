const { admin, db } = require('./firebaseAdmin');

async function recordInstallmentPayment(appRef, appData, method, reference) {
  const previousPaid = appData.installmentsPaid || 0;
  const total = appData.installmentsTotal || 1;
  const newPaid = previousPaid + 1;
  const paidInFull = newPaid >= total;
  
  await appRef.update({
    installmentsPaid: newPaid,
    paymentStatus: paidInFull ? 'paid' : 'partial',
    updatedAt: new Date(),
    ...(reference ? { lastTransactionRef: reference } : {}),
  });
  
  await db.collection('payments').add({
    applicationId: appRef.id,
    method,
    reference: reference || null,
    amount: appData.installmentsTotal === 1 ?
      appData.programAmount || 0 :
      Math.round((appData.programAmount || 0) / 3),
    installmentNumber: newPaid,
    status: 'completed',
    createdAt: new Date(),
  });
  
  return { installmentsPaid: newPaid, previousInstallmentsPaid: previousPaid };
}

async function provisionStudentAccount(applicationId, appData) {
  const uid = applicationId;
  const email = appData.email;
  
  try {
    await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(uid, {
      email,
      displayName: appData.fullName || '',
    });
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      await admin.auth().createUser({
        uid,
        email,
        displayName: appData.fullName || '',
        emailVerified: true,
        password: Math.random().toString(36).slice(-12),
      });
    } else {
      throw err;
    }
  }
  
  await admin.auth().setCustomUserClaims(uid, { role: 'student' });
  
  await db.collection('users').doc(uid).set({
    email,
    fullName: appData.fullName || '',
    phone: appData.phone || '',
    role: 'student',
    active: true,
    applicationId,
    program: appData.program,
    mustChangePassword: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }, { merge: true });
  
  const { sendMail } = require('./email');
  const loginUrl = 'https://cgtiacademy.netlify.app/';
  
  await sendMail({
    to: email,
    subject: 'Your CGTIA Student Account',
    text: `Hello ${appData.fullName || 'Student'},

Your CGTIA student account has been created.

Login at: ${loginUrl}
Email: ${email}

You will need to set a new password on your first login.

Regards,
CGTIA Admissions Team`,
  });
  
  return { uid };
}

module.exports = { recordInstallmentPayment, provisionStudentAccount };