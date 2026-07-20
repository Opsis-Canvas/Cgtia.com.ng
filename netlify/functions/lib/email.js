const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

async function sendMail({ to, subject, text, html }) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.warn('Gmail credentials not set – skipping email');
    return;
  }
  
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to,
    subject,
    text: text || '',
    html: html || text ? text.replace(/\n/g, '<br>') : '',
  });
}

module.exports = { sendMail };