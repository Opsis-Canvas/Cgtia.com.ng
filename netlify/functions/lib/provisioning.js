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
  
  console.log('📧 [provisionStudentAccount] Starting for:', email);
  
  // Check if user already exists
  try {
    await admin.auth().getUserByEmail(email);
    console.log('👤 User already exists – updating...');
    await admin.auth().updateUser(uid, {
      email,
      displayName: appData.fullName || '',
    });
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      console.log('👤 User not found – creating new user...');
      await admin.auth().createUser({
        uid,
        email,
        displayName: appData.fullName || '',
        emailVerified: true,
        password: Math.random().toString(36).slice(-12),
      });
      console.log('✅ User created with UID:', uid);
    } else {
      console.error('❌ Error checking user:', err);
      throw err;
    }
  }
  
  // Set custom claims for student role
  await admin.auth().setCustomUserClaims(uid, { role: 'student' });
  console.log('✅ Custom claims set for student role');
  
  // Create user profile in Firestore
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
  console.log('✅ Firestore user profile created/updated');
  
  // Send login credentials email
  console.log('📧 Attempting to send welcome email to:', email);
  const { sendMail } = require('./email');
  
  // Determine the correct login URL – use Netlify domain since that's what's live
  const loginUrl = 'https://cgtiacademy.netlify.app/';
  
  try {
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
    console.log('✅ Welcome email sent successfully!');
  } catch (err) {
    console.error('❌ Failed to send welcome email:', err.message);
    console.error('📧 Full error:', err);
    // Don't throw – the account is already created, email can be resent later
  }
  
  return { uid };
}

module.exports = { recordInstallmentPayment, provisionStudentAccount };