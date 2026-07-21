const nodemailer = require('nodemailer');

async function sendMail({ to, subject, text, html }) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  
  console.log('📧 [sendMail] called with:');
  console.log('   To:', to);
  console.log('   Subject:', subject);
  console.log('   GMAIL_USER configured?', !!user);
  console.log('   GMAIL_APP_PASSWORD configured?', !!pass);
  
  if (!user || !pass) {
    console.error('❌ [sendMail] Gmail credentials missing!');
    throw new Error('Gmail credentials not configured');
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
    console.log('✅ [sendMail] Email sent successfully!');
    console.log('📧 Message ID:', info.messageId);
    console.log('📧 Response:', info.response);
    return info;
  } catch (err) {
    console.error('❌ [sendMail] Email sending failed:', err.message);
    console.error('📧 Full error:', err);
    throw err;
  }
}

module.exports = { sendMail };