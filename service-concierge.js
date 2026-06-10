'use strict';
/**
 * SMS Concierge Service
 * Handles inbound texts from customers not coming through the calculator
 */

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { sendSMS } = require('./service-sms');
const axios = require('axios');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const OWNER_PHONE = process.env.OWNER_PHONE || '+13862287246';
const REVIEW_URL = 'https://g.page/r/CWmvZghawMfzEBM/review';

const KNOWLEDGE_BASE = `
ABOUT KANSAS CITY TV MOUNTING (KCTVM):
- Owner: Gabe Gonzalez
- Service area: Kansas City metro and surrounding suburbs

PRICING:
- First TV under 65": $140 (installation only — does NOT include a mount)
- First TV 65" or larger: $160 (installation only — does NOT include a mount)
- Each additional TV under 65": $70
- Each additional TV 65"+: $80
- Fixed mount add-on (we pick it up): +$60
- Articulating/full motion mount add-on (we pick it up): +$120
- Brick wall: +$150 per TV
- Wire/cable concealment: +$150 per TV
- If customer already has a mount: no extra charge, we use theirs

IMPORTANT: The base price is for installation labor only. A mount is NEVER included in the base price. It is always an optional add-on.

WIRE CONCEALMENT:
- We route wires behind drywall to an existing outlet
- If no outlet on the same wall, installing one is +$150
- We do NOT hide wires in brick walls

MOUNTS:
- We use ONN universal mounts from Walmart
- We can pick up the mount for the customer
- Fixed mounts for standard placements
- Articulating mounts allow TV to swivel/tilt

SCHEDULING:
- Often same-day or next-day available
- Payment required before officially scheduling

PAYMENT:
- Stripe secure card payments
- Payment link sent via text
- Collected upfront to lock appointment

SERVICE QUALITY:
- Techs treat every install like their own home
- Photos sent upon completion
- Mount verified level and secure before leaving

COMMON QUESTIONS:
Q: Does mounting include hiding cables?
A: Wire concealment is +$150 per TV — routes wires behind drywall to an existing outlet.

Q: Can you do same day?
A: Often yes! Depends on tech availability.

Q: Do I need a mount?
A: No, we pick one up (fixed +$60, articulating +$120). Or we use yours.

Q: How long does it take?
A: About 1-1.5 hours for most jobs.

Q: What areas do you serve?
A: KC metro — Lee's Summit, Overland Park, Olathe, Independence, Liberty, Gladstone, North KC and surrounding areas.

GABE'S STYLE:
- Casual and friendly, not corporate
- Short sentences, gets to the point
- "Amazing!", "Perfect!", "Sounds good", "No worries!"
- Does NOT use excessive emojis
- Does NOT sound like a bot
`;

async function getHistory(phone) {
  try {
    const { data } = await supabase
      .from('sms_conversations')
      .select('role, content')
      .eq('phone', phone)
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: true })
      .limit(20);
    return (data || []);
  } catch (err) {
    console.error('[Concierge] getHistory error:', err.message);
    return [];
  }
}

async function addToHistory(phone, role, content) {
  try {
    await supabase.from('sms_conversations').insert({ phone: phone, role: role, content: content });
  } catch (err) {
    console.error('[Concierge] addToHistory error:', err.message);
  }
}

async function identifyCustomer(phone) {
  try {
    const normalized = phone.startsWith('+') ? phone : '+1' + phone.replace(/\D/g, '');
    const stripped = phone.replace(/\D/g, '');

    const { data: activeJobs } = await supabase
      .from('jobs')
      .select('id, customer_name, status, preferred_time, city, confirmed_tech_name, stripe_payment_link')
      .or('customer_phone.eq.' + normalized + ',customer_phone.eq.+1' + stripped)
      .not('status', 'in', '("cancelled","completed")')
      .order('created_at', { ascending: false })
      .limit(1);

    if (activeJobs && activeJobs.length > 0) {
      return { type: 'active', job: activeJobs[0] };
    }

    const { data: pastJobs } = await supabase
      .from('jobs')
      .select('id, customer_name, status, preferred_time, city, completed_at')
      .or('customer_phone.eq.' + normalized + ',customer_phone.eq.+1' + stripped)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1);

    if (pastJobs && pastJobs.length > 0) {
      return { type: 'returning', job: pastJobs[0] };
    }
  } catch (err) {
    console.error('[Concierge] identifyCustomer error:', err.message);
  }

  return { type: 'new', job: null };
}

function buildSystemPrompt(customerType, job) {
  var contextNote = '';

  if (customerType === 'active' && job) {
    var statusMessages = {
      awaiting_time_confirm: 'We texted them asking for a specific time.',
      scheduling_conflict: 'Their preferred time was unavailable, waiting for a new time.',
      awaiting_tech_reply: 'We texted a tech and are waiting for their reply.',
      awaiting_payment: 'They have been sent a payment link. Payment must be completed to confirm.',
      confirmed: 'Their appointment is CONFIRMED. Tech: ' + (job.confirmed_tech_name || 'assigned') + '. Time: ' + job.preferred_time + '.',
    };
    contextNote = 'CURRENT CUSTOMER STATUS: This customer HAS AN ACTIVE JOB.\n' +
      'Customer name: ' + job.customer_name + '\n' +
      'Status: ' + (statusMessages[job.status] || job.status) + '\n' +
      'City: ' + job.city + '\n' +
      'Preferred time: ' + job.preferred_time + '\n' +
      'If they need to pay, remind them and mention the payment link was already sent.\n';
  } else if (customerType === 'returning' && job) {
    contextNote = 'RETURNING CUSTOMER: Been with us before.\n' +
      'Name: ' + job.customer_name + '\n' +
      'Previous job: ' + job.city + ', ' + job.preferred_time + '\n' +
      'Greet them warmly as a returning customer.\n';
  } else {
    contextNote = 'NEW CUSTOMER: Never contacted us before.\n' +
      'Greet them warmly. Find out what they need.\n' +
      'If they want to book, collect via text: number of TVs, size(s), mount type, wall type, wire concealment, city, preferred time.\n' +
      'Give them a price and confirm the booking directly by text. Do NOT send them to the website.\n';
  }

  return 'You are an AI assistant for Kansas City TV Mounting (KCTVM), texting on behalf of Gabe.\n' +
    'You respond via SMS — keep messages short and conversational. No long paragraphs.\n' +
    'Sound like a real person texting, not a bot. Never say you are an AI.\n\n' +
    contextNote + '\n' +
    'KNOWLEDGE BASE:\n' + KNOWLEDGE_BASE + '\n\n' +
    'RULES:\n' +
    '- Keep responses under 300 characters when possible\n' +
    '- Handle EVERYTHING by text. Never send to the website.\n' +
    '- Only say "Let me get Gabe on this for you" for genuine liability/legal issues — this is the last resort\n' +
    '- Never make up pricing not in the knowledge base\n' +
    '- Be warm and helpful in Gabe\'s voice\n';
}

var followUpTimers = new Map();

async function scheduleConversationFollowUp(phone, customerMsg) {
  var interestKeywords = ['how much', 'price', 'cost', 'charge', 'available', 'schedule', 'book', 'mount', 'install', 'tv', 'interested', 'when', 'how long'];
  var msgLower = customerMsg.toLowerCase();
  var looksInterested = interestKeywords.some(function(k) { return msgLower.includes(k); });
  if (!looksInterested) return;

  try {
    var already = await supabase.from('follow_up_sent').select('phone').eq('phone', phone).single();
    if (already.data) return;
  } catch (e) {
    // not found — continue
  }

  if (followUpTimers.has(phone)) {
    clearTimeout(followUpTimers.get(phone));
  }

  var timer = setTimeout(async function() {
    followUpTimers.delete(phone);
    try {
      var check = await supabase.from('follow_up_sent').select('phone').eq('phone', phone).single();
      if (check.data) return;

      var normalized = phone.startsWith('+') ? phone : '+1' + phone.replace(/\D/g, '');
      var activeCheck = await supabase.from('jobs').select('id')
        .or('customer_phone.eq.' + normalized + ',customer_phone.eq.' + phone)
        .not('status', 'in', '("cancelled","completed")')
        .limit(1);
      if (activeCheck.data && activeCheck.data.length > 0) return;

      var recentCheck = await supabase.from('sms_conversations')
        .select('created_at').eq('phone', phone).eq('role', 'user')
        .order('created_at', { ascending: false }).limit(1);
      if (recentCheck.data && recentCheck.data.length > 0) {
        var timeSince = Date.now() - new Date(recentCheck.data[0].created_at).getTime();
        if (timeSince < 2.5 * 60 * 60 * 1000) return;
      }

      await sendSMS(phone, 'Hey, just following up to see if you were still interested in getting your TV mounted? No worries if not!');
      await supabase.from('follow_up_sent').insert({ phone: phone });
      console.log('[Concierge] Follow-up sent to ' + phone);
    } catch (err) {
      console.error('[Concierge] Follow-up error:', err.message);
    }
  }, 3 * 60 * 60 * 1000);

  followUpTimers.set(phone, timer);
}

async function checkAndCreateJob(phone, body, history) {
  if (history.length < 6) return;

  var conversationText = history.map(function(m) {
    return (m.role === 'user' ? 'Customer' : 'KCTVM') + ': ' + m.content;
  }).join('\n');

  var extractPrompt = 'Given this SMS conversation, determine if we have COMPLETE job details to create a booking.\n' +
    'Required: customer name, phone, city, preferred time, number of TVs, TV sizes, mount type, wall type, wire concealment.\n\n' +
    'Conversation:\n' + conversationText + '\n\n' +
    'If ALL details present and customer agreed to price, respond with JSON only:\n' +
    '{"ready":true,"name":"name","city":"city","preferred_time":"time","num_tvs":1,"total_price":140,"tv_1_size":"small","tv_1_mount":"yes","tv_1_wall":"drywall","tv_1_wire":"no"}\n' +
    'If not complete: {"ready":false}\n' +
    'JSON only, no other text.';

  try {
    var extractResponse = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: extractPrompt }],
    });
    var text = extractResponse.content[0].text.trim().replace(/```json|```/g, '');
    var data = JSON.parse(text);
    if (data.ready) {
      var payload = Object.assign({}, data, { phone: phone });
      delete payload.ready;
      await axios.post(process.env.BASE_URL + '/webhook/quote', payload, {
        headers: { 'Content-Type': 'application/json' }
      });
      console.log('[Concierge] Job created via text booking for ' + phone);
    }
  } catch (err) {
    console.error('[Concierge] Job extraction error:', err.message);
  }
}

async function handleConciergeMessage(from, body) {
  console.log('[Concierge] Handling message from ' + from + ': "' + body + '"');

  try {
    var customerInfo = await identifyCustomer(from);
    console.log('[Concierge] Customer type: ' + customerInfo.type);

    var history = await getHistory(from);
    await addToHistory(from, 'user', body);

    var messages = history.slice(-10).concat([{ role: 'user', content: body }]);

    var response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: buildSystemPrompt(customerInfo.type, customerInfo.job),
      messages: messages,
    });

    var reply = response.content[0].text.trim();
    console.log('[Concierge] Reply: "' + reply + '"');

    await addToHistory(from, 'assistant', reply);

    // Alert owner for genuine escalation — one alert per customer number, ever
    var needsManual = reply.toLowerCase().includes('let me get gabe on this for you');
    if (needsManual) {
      var { shouldAlertOwner } = require('./service-ratelimit');
      var alertKey = 'manual_needed:' + from;
      if (shouldAlertOwner(alertKey)) {
        await sendSMS(OWNER_PHONE, '📱 MANUAL REPLY NEEDED\nFrom: ' + from + '\nMsg: "' + body + '"\nAI: "' + reply + '"');
        console.log('[Concierge] Owner alerted for ' + from);
      } else {
        console.log('[Concierge] Owner alert suppressed for ' + from + ' — already sent');
      }
    }

    await sendSMS(from, reply);

    await scheduleConversationFollowUp(from, body);
    await checkAndCreateJob(from, body, history);

    return reply;

  } catch (err) {
    console.error('[Concierge] Error:', err.message, err.stack);
    try {
      // Alert owner once per customer number for errors
      var { shouldAlertOwner } = require('./service-ratelimit');
      var errKey = 'concierge_error:' + from;
      if (shouldAlertOwner(errKey)) {
        await sendSMS(OWNER_PHONE, '📱 CONCIERGE ERROR — check logs\nFrom: ' + from + '\nMsg: "' + body + '"');
      }
      await sendSMS(from, 'Hey! Thanks for reaching out to Kansas City TV Mounting. We\'ll get back to you shortly!');
    } catch (smsErr) {
      console.error('[Concierge] Could not send fallback SMS:', smsErr.message);
    }
  }
}

module.exports = { handleConciergeMessage };
