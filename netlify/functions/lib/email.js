const nodemailer = require('nodemailer');

async function sendMail({ to, subject, text, html }) {
  const user = process.env.EMAIL_SENDER;
  const pass = process.env.EMAIL_PASSWORD;
  
  if (!user || !pass) {
    console.warn('Email credentials not set – skipping email');
    return;
  }
  
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: user,
      pass: pass,
    },
  });
  
  try {
    const info = await transporter.sendMail({
      from: user,
      to: to,
      subject: subject,
      text: text || '',
      html: html || (text ? text.replace(/\n/g, '<br>') : ''),
    });
    console.log('✅ Email sent successfully!');
    return info;
  } catch (err) {
    console.error('❌ Email sending failed:', err.message);
    throw err;
  }
}

module.exports = { sendMail };