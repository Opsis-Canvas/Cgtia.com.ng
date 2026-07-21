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
  
  const staffEmail = process.env.ADMIN_EMAIL;
  if (!staffEmail) {
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
    return { statusCode: 200, body: JSON.stringify({ success: false }) };
  }
};