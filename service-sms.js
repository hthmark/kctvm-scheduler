const twilio = require('twilio');
const axios = require('axios');

const provider = process.env.SMS_PROVIDER || 'twilio';
let twilioClient;
if (provider === 'twilio') {
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendSMS(to, body) {
  const phone = to.startsWith('+') ? to : `+1${to.replace(/\D/g, '')}`;
  if (provider === 'twilio') {
    const msg = await twilioClient.messages.create({
      body, from: process.env.TWILIO_PHONE_NUMBER, to: phone,
    });
    console.log(`[SMS] Twilio sent to ${phone}: SID=${msg.sid}`);
    return { success: true, sid: msg.sid };
  }
  if (provider === 'telnyx') {
    const resp = await axios.post('https://api.telnyx.com/v2/messages',
      { from: process.env.TELNYX_PHONE_NUMBER, to: phone, text: body },
      { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    return { success: true, sid: resp.data.data.id };
  }
  throw new Error(`Unknown SMS_PROVIDER: ${provider}`);
}

module.exports = { sendSMS };
