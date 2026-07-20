/**
 * Called by the frontend immediately after a successful Firestore write
 * (application, licensing application, custom request, or contact
 * message), since Netlify Functions can't listen for Firestore document
 * creation the way a Firebase Cloud Function trigger can. This means
 * notification delivery depends on the frontend call succeeding too — a
 * reasonable tradeoff for a simpler architecture, but worth knowing: if
 * someone's connection drops between the Firestore write and this call,
 * the submission is still saved, it just won't trigger an email.
 */

const { sendMail } = require('./lib/email');

const SUBJECTS = {
  application: 'New Application',
  licensing: 'New Licensing Application',
  custom: 'New Partnership Request',
  contact: 'New Message'
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const staffEmail = process.env.STAFF_EMAIL;
  if (!staffEmail) {
    // Not configured yet — skip quietly rather than erroring the whole
    // submission flow over a missing notification address.
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { type, summary } = body;
  const subjectBase = SUBJECTS[type] || 'New Submission';
  const subjectName = summary && (summary.name || summary.fullName) ? ': ' + (summary.name || summary.fullName) : '';

  try {
    await sendMail({
      to: staffEmail,
      subject: subjectBase + subjectName,
      text: Object.entries(summary || {}).map(([k, v]) => `${k}: ${v}`).join('\n')
    });
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('notify-staff failed', err);
    // Don't fail the person's submission over a notification hiccup —
    // this endpoint is best-effort from the frontend's perspective.
    return { statusCode: 200, body: JSON.stringify({ success: false }) };
  }
};
