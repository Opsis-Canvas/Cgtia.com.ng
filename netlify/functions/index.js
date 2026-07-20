/**
 * CGTIA Cloud Functions
 * ---------------------
 * Implements the site's auth flow:
 *   1. A student applies for Certificate / Diploma / Higher Diploma and pays
 *      (card via Paystack, or bank transfer confirmed manually by staff).
 *   2. The moment `applications/{id}.paymentStatus` becomes "paid", this
 *      creates their Firebase Auth account, emails them a one-time login
 *      code (a real temporary password) via Gmail, and flags their account
 *      so the client forces a password change on first login.
 *   3. Licensing and Custom (individual/school/organization) applicants are
 *      handled entirely differently by design — they never reach any of
 *      this, and never get an account created for them automatically.
 */

const { onDocumentUpdated, onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

// Set these with:
//   firebase functions:secrets:set GMAIL_USER
//   firebase functions:secrets:set GMAIL_APP_PASSWORD
//   firebase functions:secrets:set PAYSTACK_SECRET_KEY
//   firebase functions:secrets:set STAFF_EMAIL
// GMAIL_APP_PASSWORD must be a Gmail *App Password* (Google Account →
// Security → 2-Step Verification → App Passwords), not the normal Gmail
// login password — Google blocks plain-password SMTP login.
// STAFF_EMAIL is where new-submission notifications get sent — can be a
// single address or a comma-separated list.
const GMAIL_USER = defineSecret('GMAIL_USER');
const GMAIL_APP_PASSWORD = defineSecret('GMAIL_APP_PASSWORD');
const PAYSTACK_SECRET_KEY = defineSecret('PAYSTACK_SECRET_KEY');
const STAFF_EMAIL = defineSecret('STAFF_EMAIL');

const PROGRAM_NAMES = {
  certificate: 'CGTIA Certificate',
  diploma: 'CGTIA Diploma',
  'higher-diploma': 'CGTIA Higher Diploma'
};

/** A 10-character mixed-case + digit code — easy to read out of an email,
 * strong enough to serve as a real temporary Firebase Auth password. */
function generateTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function getTransporter(user, pass) {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
}

async function sendLoginCodeEmail({ to, fullName, programName, tempPassword }, secrets) {
  const transporter = getTransporter(secrets.gmailUser, secrets.gmailAppPassword);
  await transporter.sendMail({
    from: `"CGTIA Admissions" <${secrets.gmailUser}>`,
    to,
    subject: 'Your CGTIA Student Portal Login Code',
    text:
`Hi ${fullName},

Your payment for ${programName} has been confirmed — welcome to CGTIA!

Here is your one-time login code for the student portal:

  Email: ${to}
  Code:  ${tempPassword}

Sign in at the student portal with this email and code. You'll be asked to
set your own password the first time you log in.

If you weren't expecting this email, please contact admissions@cgtia.org.

— CGTIA Admissions Team`,
    html: `
      <div style="font-family:sans-serif;color:#0f172a;">
        <p>Hi ${fullName},</p>
        <p>Your payment for <strong>${programName}</strong> has been confirmed &mdash; welcome to CGTIA!</p>
        <p>Here is your one-time login code for the student portal:</p>
        <table style="margin:16px 0;">
          <tr><td style="padding:4px 12px 4px 0;color:#64748b;">Email</td><td><strong>${to}</strong></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#64748b;">Code</td><td><strong style="font-size:18px;letter-spacing:1px;">${tempPassword}</strong></td></tr>
        </table>
        <p>Sign in at the student portal with this email and code. You'll be asked to set your own password the first time you log in.</p>
        <p style="color:#94a3b8;font-size:12px;">If you weren't expecting this email, please contact admissions@cgtia.org.</p>
        <p>&mdash; CGTIA Admissions Team</p>
      </div>
    `
  });
}

/**
 * Core provisioning logic, shared by every payment path. Only ever runs for
 * `applications` (Certificate / Diploma / Higher Diploma) — this function is
 * never called for licensingApplications or customRequests, by design.
 *
 * Fires the moment the FIRST payment lands, whether that's a full payment
 * or just installment 1 of 3 — the student gets their login code and
 * account access right away either way, per the site's payment plan.
 */
async function provisionStudentAccount(appId, appData, secrets) {
  if (appData.uid) return; // idempotency guard — never provision twice

  const tempPassword = generateTempPassword();

  const userRecord = await admin.auth().createUser({
    email: appData.email,
    password: tempPassword,
    displayName: appData.fullName,
    emailVerified: true
  });

  await admin.auth().setCustomUserClaims(userRecord.uid, { role: 'student' });

  await db.collection('users').doc(userRecord.uid).set({
    email: appData.email,
    fullName: appData.fullName,
    phone: appData.phone || '',
    role: 'student',
    program: appData.program,
    applicationId: appId,
    mustChangePassword: true,
    status: 'active',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await db.collection('applications').doc(appId).update({
    uid: userRecord.uid,
    status: 'enrolled',
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await sendLoginCodeEmail({
    to: appData.email,
    fullName: appData.fullName,
    programName: PROGRAM_NAMES[appData.program] || appData.program,
    tempPassword
  }, secrets);
}

/**
 * Fires whenever an application document is updated. Provisioning happens
 * the moment `installmentsPaid` goes from 0 to 1 — i.e. the very first
 * payment, whether that's the full amount (paymentPlan: "full", where
 * installmentsTotal is 1) or just the first of three installments
 * (paymentPlan: "installment", installmentsTotal is 3). Later installment
 * payments (2 and 3) just increment installmentsPaid and do NOT re-run
 * provisioning — the idempotency guard in provisionStudentAccount also
 * protects against that.
 */
exports.onApplicationPaid = onDocumentUpdated(
  { document: 'applications/{appId}', secrets: [GMAIL_USER, GMAIL_APP_PASSWORD] },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    const beforePaid = before.installmentsPaid || 0;
    const afterPaid = after.installmentsPaid || 0;

    // Only the very first payment (0 -> 1+) triggers provisioning.
    if (beforePaid > 0 || afterPaid < 1) return;

    await provisionStudentAccount(event.params.appId, after, {
      gmailUser: GMAIL_USER.value(),
      gmailAppPassword: GMAIL_APP_PASSWORD.value()
    });
  }
);

/**
 * Paystack webhook — configure this URL in the Paystack dashboard
 * (Settings → API Keys & Webhooks). Paystack calls this server-to-server
 * after a card payment; it is never called by the browser. Verifies the
 * request signature, then trusts only the transaction reference to look up
 * the matching application (never trust amount/email fields from the
 * webhook body alone).
 *
 * IMPORTANT frontend requirement: when initiating a card payment, the
 * PaystackPop.setup({ reference: ... }) call must be set to the Firestore
 * `applications` document id, so this webhook can find it directly. See
 * "Frontend integration checklist" in the blueprint — this isn't wired up
 * in the site's current JS yet.
 */
exports.paystackWebhook = onRequest(
  { secrets: [PAYSTACK_SECRET_KEY] },
  async (req, res) => {
    const signature = req.get('x-paystack-signature');
    const expected = crypto
      .createHmac('sha512', PAYSTACK_SECRET_KEY.value())
      .update(req.rawBody)
      .digest('hex');

    if (signature !== expected) {
      res.status(401).send('Invalid signature');
      return;
    }

    const event = req.body;
    if (event.event !== 'charge.success') {
      res.status(200).send('Ignored');
      return;
    }

    const reference = event.data.reference;
    const appRef = db.collection('applications').doc(reference);
    const snap = await appRef.get();

    if (!snap.exists) {
      res.status(404).send('Unknown application reference');
      return;
    }

    await recordInstallmentPayment(appRef, snap.data(), 'card', reference);
    res.status(200).send('OK');
  }
);

/**
 * Callable from the (future) admin dashboard to confirm a bank transfer
 * manually, since transfers are verified by a human against the bank
 * statement, not an API.
 */
exports.adminConfirmTransferPayment = onCall(async (request) => {
  if (request.auth?.token?.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin role required.');
  }

  const { applicationId } = request.data || {};
  if (!applicationId) {
    throw new HttpsError('invalid-argument', 'applicationId is required.');
  }

  const appRef = db.collection('applications').doc(applicationId);
  const snap = await appRef.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'No application with that id.');
  }

  await recordInstallmentPayment(appRef, snap.data(), 'transfer', null);
  return { success: true };
});

/**
 * Shared by both payment paths — increments installmentsPaid by one and
 * sets paymentStatus to "paid" once all installments are in (or
 * "partially_paid" if more remain). installmentsTotal is set by the
 * frontend when the application is first created: 1 for a full payment,
 * 3 for the installment plan.
 */
async function recordInstallmentPayment(appRef, appData, method, paystackReference) {
  const installmentsTotal = appData.installmentsTotal || 1;
  const installmentsPaid = Math.min((appData.installmentsPaid || 0) + 1, installmentsTotal);
  const paymentStatus = installmentsPaid >= installmentsTotal ? 'paid' : 'partially_paid';

  const update = {
    installmentsPaid,
    paymentStatus,
    paymentMethod: method,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (paystackReference) update.paystackReference = paystackReference;

  await appRef.update(update);
}

/**
 * Promotes an existing user to the admin (staff) role. Only a current admin
 * can call this — your very first admin has to be set directly via a
 * one-off script, since nobody has the role yet. See "Creating your first
 * admin" in the blueprint.
 */
exports.setAdminRole = onCall(async (request) => {
  if (request.auth?.token?.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin role required.');
  }

  const { uid } = request.data || {};
  if (!uid) {
    throw new HttpsError('invalid-argument', 'uid is required.');
  }

  await admin.auth().setCustomUserClaims(uid, { role: 'admin' });
  return { success: true };
});

/**
 * ---------------------------------------------------------------------
 * STAFF NOTIFICATIONS
 * ---------------------------------------------------------------------
 * Nobody currently gets pinged when a new application, licensing
 * submission, custom request, or contact message comes in — someone has
 * to remember to check the Firestore console. These four triggers fix
 * that by emailing STAFF_EMAIL the moment each type of document is
 * created. Kept deliberately simple (plain text, no queue/retry) — if
 * volume grows enough that this becomes noisy, swap it for a digest
 * (e.g. hourly summary) instead of one email per submission.
 */

async function notifyStaff(subject, lines, secrets) {
  const staffEmail = secrets.staffEmail;
  if (!staffEmail) return; // secret not configured yet — skip quietly

  const transporter = getTransporter(secrets.gmailUser, secrets.gmailAppPassword);
  await transporter.sendMail({
    from: `"CGTIA Website" <${secrets.gmailUser}>`,
    to: staffEmail,
    subject,
    text: lines.join('\n')
  });
}

exports.notifyOnNewApplication = onDocumentCreated(
  { document: 'applications/{appId}', secrets: [GMAIL_USER, GMAIL_APP_PASSWORD, STAFF_EMAIL] },
  async (event) => {
    const data = event.data.data();
    await notifyStaff(`New Application: ${data.fullName || 'Unknown'}`, [
      `Program: ${PROGRAM_NAMES[data.program] || data.program}`,
      `Name: ${data.fullName}`,
      `Email: ${data.email}`,
      `Phone: ${data.phone}`,
      `Start date: ${data.startDate || 'n/a'}`,
      '',
      `Review it in the Firebase Console → Firestore → applications/${event.params.appId}`
    ], {
      gmailUser: GMAIL_USER.value(),
      gmailAppPassword: GMAIL_APP_PASSWORD.value(),
      staffEmail: STAFF_EMAIL.value()
    });
  }
);

exports.notifyOnNewLicensingApplication = onDocumentCreated(
  { document: 'licensingApplications/{reqId}', secrets: [GMAIL_USER, GMAIL_APP_PASSWORD, STAFF_EMAIL] },
  async (event) => {
    const data = event.data.data();
    await notifyStaff(`New Licensing Application: ${data.fullName || 'Unknown'}`, [
      `Name: ${data.fullName}`,
      `Email: ${data.email}`,
      `Phone: ${data.phone}`,
      '',
      `Documents and review: Firebase Console → Firestore → licensingApplications/${event.params.reqId}`
    ], {
      gmailUser: GMAIL_USER.value(),
      gmailAppPassword: GMAIL_APP_PASSWORD.value(),
      staffEmail: STAFF_EMAIL.value()
    });
  }
);

exports.notifyOnNewCustomRequest = onDocumentCreated(
  { document: 'customRequests/{reqId}', secrets: [GMAIL_USER, GMAIL_APP_PASSWORD, STAFF_EMAIL] },
  async (event) => {
    const data = event.data.data();
    await notifyStaff(`New Partnership Request (${data.applicantType || 'unknown'}): ${data.name || 'Unknown'}`, [
      `Type: ${data.applicantType}`,
      `Name: ${data.name}`,
      `Email: ${data.email}`,
      `Phone: ${data.phone}`,
      '',
      `Full details: Firebase Console → Firestore → customRequests/${event.params.reqId}`
    ], {
      gmailUser: GMAIL_USER.value(),
      gmailAppPassword: GMAIL_APP_PASSWORD.value(),
      staffEmail: STAFF_EMAIL.value()
    });
  }
);

exports.notifyOnNewContactMessage = onDocumentCreated(
  { document: 'contactMessages/{msgId}', secrets: [GMAIL_USER, GMAIL_APP_PASSWORD, STAFF_EMAIL] },
  async (event) => {
    const data = event.data.data();
    await notifyStaff(`New Message${data.faqTopic ? ' (Re: ' + data.faqTopic + ')' : ''}`, [
      `From: ${data.name || data.contactValue || 'Unknown'}`,
      `Prefers reply via: ${data.preferredContactMethod || 'email'} (${data.contactValue || 'n/a'})`,
      '',
      data.message || '(no message text)',
      '',
      `Full record: Firebase Console → Firestore → contactMessages/${event.params.msgId}`
    ], {
      gmailUser: GMAIL_USER.value(),
      gmailAppPassword: GMAIL_APP_PASSWORD.value(),
      staffEmail: STAFF_EMAIL.value()
    });
  }
);
