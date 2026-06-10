const twilio = require('twilio');
const axios = require('axios');
const { canSendSMS, recordSMS } = require('./service-ratelimit');

const provider = process.env.SMS_PROVIDER || 'twilio';
let twilioClient;
if (provider === 'twilio') {
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendSMS(to, body) {
  const phone = to.startsWith('+') ? to : `+1${to.replace(/\D/g, '')}`;

  // Rate limit check — blocks loops before they cost money
  const { allowed, reason } = canSendSMS(phone);
  if (!allowed) {
    console.error(`[SMS] RATE LIMITED — blocked send to ${phone} (${reason}): "${body.substring(0, 50)}..."`);
    return { success: false, blocked: true, reason };
  }

  try {
    let result;
    if (provider === 'twilio') {
      const msg = await twilioClient.messages.create({
        body, from: process.env.TWILIO_PHONE_NUMBER, to: phone,
      });
      result = { success: true, sid: msg.sid };
      console.log(`[SMS] Twilio sent to ${phone}: SID=${msg.sid}`);
    } else if (provider === 'telnyx') {
      const resp = await axios.post('https://api.telnyx.com/v2/messages',
        { from: process.env.TELNYX_PHONE_NUMBER, to: phone, text: body },
        { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, 'Content-Type': 'application/json' } }
      );
      result = { success: true, sid: resp.data.data.id };
      console.log(`[SMS] Telnyx sent to ${phone}: ID=${resp.data.data.id}`);
    } else {
      throw new Error(`Unknown SMS_PROVIDER: ${provider}`);
    }

    // Record successful send for rate limiting
    recordSMS(phone);
    return result;

  } catch (err) {
    console.error(`[SMS] Send failed to ${phone}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendSMS };
