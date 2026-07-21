const { sendMail } = require('./lib/email');

exports.handler = async (event) => {
  const to = process.env.ADMIN_EMAIL;

  try {
    await sendMail({
      to: to,
      subject: 'Test Email from CGTIA',
      text: 'This is a test email to check if Gmail is configured correctly.',
    });
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Email sent!' }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};