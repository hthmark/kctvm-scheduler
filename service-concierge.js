'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { sendSMS } = require('./service-sms');
const { shouldAlertOwner } = require('./service-ratelimit');
const axios = require('axios');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const OWNER_PHONE = process.env.OWNER_PHONE || '+13862287246';

const KNOWLEDGE_BASE = 'KANSAS CITY TV MOUNTING PRICING:\n' +
  '- First TV under 65": $140 (labor only, NO mount included)\n' +
  '- First TV 65" or larger: $160 (labor only, NO mount included)\n' +
  '- Each additional TV under 65": $70\n' +
  '- Each additional TV 65"+: $80\n' +
  '- Fixed mount add-on (we source the mount): +$60\n' +
  '- Articulating/full motion mount add-on (we source the mount): +$120\n' +
  '- Brick wall: +$150 per TV\n' +
  '- Wire/cable concealment: +$150 per TV\n' +
  '- IMPORTANT: Base price is labor only. Mounts are NEVER included. Always an add-on.\n\n' +
  'WIRE CONCEALMENT:\n' +
  '- Routes wires behind drywall to an existing outlet lower on the wall\n' +
  '- If no outlet on the same wall, installing one costs +$150\n' +
  '- We do NOT hide wires in brick walls\n\n' +
  'SCHEDULING:\n' +
  '- Often same-day or next-day available\n' +
  '- Payment required to lock in appointment\n' +
  '- Payment via Stripe link sent by text\n\n' +
  'SERVICE AREA:\n' +
  '- Kansas City metro: Lee\'s Summit, Overland Park, Olathe, Independence, Liberty, Gladstone, North KC and surrounding areas\n\n' +
  'HOW LONG: About 1-1.5 hours per job\n\n' +
  'GABE\'S STYLE: Casual, friendly, short sentences. "Amazing!", "Perfect!", "No worries!" Not corporate. Not a bot.';

async function getHistory(phone) {
  try {
    var result = await supabase
      .from('sms_conversations')
      .select('role, content')
      .eq('phone', phone)
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: true })
      .limit(20);
    return result.data || [];
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
    var normalized = phone.startsWith('+') ? phone : '+1' + phone.replace(/\D/g, '');
    var result = await supabase
      .from('jobs')
      .select('id, customer_name, status, preferred_time, city, confirmed_tech_name, stripe_payment_link')
      .or('customer_phone.eq.' + normalized)
      .not('status', 'in', '("cancelled","completed")')
      .order('created_at', { ascending: false })
      .limit(1);
    if (result.data && result.data.length > 0) {
      return { type: 'active', job: result.data[0] };
    }
    var past = await supabase
      .from('jobs')
      .select('id, customer_name, status, preferred_time, city')
      .or('customer_phone.eq.' + normalized)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1);
    if (past.data && past.data.length > 0) {
      return { type: 'returning', job: past.data[0] };
    }
  } catch (err) {
    console.error('[Concierge] identifyCustomer error:', err.message);
  }
  return { type: 'new', job: null };
}

function buildSystemPrompt(customerType, job) {
  var context = '';
  if (customerType === 'active' && job) {
    context = 'This customer has an active job. Name: ' + job.customer_name + '. Status: ' + job.status + '. Time: ' + job.preferred_time + '. City: ' + job.city + '. If awaiting_payment, remind them their payment link was already sent.';
  } else if (customerType === 'returning' && job) {
    context = 'Returning customer. Name: ' + job.customer_name + '. Had a job in ' + job.city + ' on ' + job.preferred_time + '. Greet them warmly.';
  } else {
    context = 'New customer. Greet warmly. If they want to book, collect: number of TVs, size, mount type, wall type, wire concealment, city, preferred time. Give them the price. Once they agree on a time, acknowledge it naturally like "Got it, 3pm today noted!" but NEVER say the time "works" or that you can confirm it — you cannot check the calendar. End with something like "We\'ll check availability and get you confirmed shortly!" STOP THERE. Do NOT mention Stripe, payment links, or next steps — the booking system handles all of that automatically.';
  }
  return 'You are texting for Kansas City TV Mounting (KCTVM) on behalf of Gabe. Keep replies short — this is SMS. Sound like a real person, not a bot. Never say you are AI.\n\n' +
    context + '\n\n' +
    KNOWLEDGE_BASE + '\n\n' +
    'Only say "Let me get Gabe on this" for genuine legal/liability issues — absolute last resort.\n' +
    'NEVER mention Walmart, Home Depot, or any store name to customers. Ever.';
}

var followUpTimers = new Map();

async function scheduleFollowUp(phone, msg) {
  var keywords = ['how much', 'price', 'cost', 'charge', 'mount', 'tv', 'install', 'available', 'book', 'schedule'];
  if (!keywords.some(function(k) { return msg.toLowerCase().includes(k); })) return;
  try {
    var check = await supabase.from('follow_up_sent').select('phone').eq('phone', phone).single();
    if (check.data) return;
  } catch (e) { /* not found, continue */ }
  if (followUpTimers.has(phone)) clearTimeout(followUpTimers.get(phone));
  var timer = setTimeout(async function() {
    followUpTimers.delete(phone);
    try {
      var sent = await supabase.from('follow_up_sent').select('phone').eq('phone', phone).single();
      if (sent.data) return;
      var normalized = phone.startsWith('+') ? phone : '+1' + phone.replace(/\D/g, '');
      var active = await supabase.from('jobs').select('id').or('customer_phone.eq.' + normalized).not('status', 'in', '("cancelled","completed")').limit(1);
      if (active.data && active.data.length > 0) return;
      await sendSMS(phone, 'Hey, just following up to see if you were still interested in getting your TV mounted? No worries if not!');
      await supabase.from('follow_up_sent').insert({ phone: phone });
    } catch (err) {
      console.error('[Concierge] Follow-up error:', err.message);
    }
  }, 3 * 60 * 60 * 1000);
  followUpTimers.set(phone, timer);
}

async function handleConciergeMessage(from, body) {
  console.log('[Concierge] Message from ' + from + ': "' + body + '"');
  try {
    var info = await identifyCustomer(from);
    console.log('[Concierge] Customer type: ' + info.type);
    var history = await getHistory(from);
    var messages = history.slice(-10).concat([{ role: 'user', content: body }]);
    var systemPrompt = buildSystemPrompt(info.type, info.job);
    var response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: systemPrompt,
      messages: messages
    });
    var reply = response.content[0].text.trim();
    console.log('[Concierge] Reply: "' + reply + '"');
    await addToHistory(from, 'user', body);
    await addToHistory(from, 'assistant', reply);
    if (reply.toLowerCase().indexOf('let me get gabe') !== -1) {
      if (shouldAlertOwner('manual:' + from)) {
        await sendSMS(OWNER_PHONE, 'MANUAL NEEDED\nFrom: ' + from + '\nMsg: ' + body);
      }
    }
    var updatedHistory = await getHistory(from);
    var jobCreated = await checkAndCreateJob(from, updatedHistory);
    if (!jobCreated) {
      await sendSMS(from, reply);
    }
    await scheduleFollowUp(from, body);
  } catch (err) {
    console.error('[Concierge] Error:', err.message);
    if (shouldAlertOwner('error:' + from)) {
      await sendSMS(OWNER_PHONE, 'CONCIERGE ERROR\nFrom: ' + from + '\n' + err.message);
    }
    try {
      await sendSMS(from, 'Hey! Thanks for reaching out to Kansas City TV Mounting. We\'ll get back to you shortly!');
    } catch (e) { /* ignore */ }
  }
}

async function checkAndCreateJob(phone, history) {
  if (history.length < 4) return;
  var conversationText = history.map(function(m) {
    return (m.role === 'user' ? 'Customer' : 'KCTVM') + ': ' + m.content;
  }).join('\n');
  var prompt = 'Given this SMS conversation, determine if we have COMPLETE booking details.\n' +
    'Required: customer name or just use "Customer", city, preferred time, number of TVs, TV size (small=under65 or large=65plus), mount type (yes/fixed/articulating), wall type (drywall/brick), wire concealment (no/cable), total price.\n\n' +
    'Conversation:\n' + conversationText + '\n\n' +
    'If ALL details are present and customer confirmed the price, respond with JSON only:\n' +
    '{"ready":true,"name":"Customer","city":"city","preferred_time":"time","num_tvs":1,"total_price":200,"tv_1_size":"small","tv_1_mount":"fixed","tv_1_wall":"drywall","tv_1_wire":"no"}\n' +
    'If not complete yet: {"ready":false}\n' +
    'JSON only, no other text.';
  try {
    var r = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
    });
    var text = r.content[0].text.trim().replace(/```json|```/g, '');
    var data = JSON.parse(text);
    if (data.ready) {
      data.phone = phone;
      delete data.ready;
      await axios.post(process.env.BASE_URL + '/webhook/quote', data, {
        headers: { 'Content-Type': 'application/json' }
      });
      console.log('[Concierge] Job created for ' + phone);
      return true;
    }
  } catch (err) {
    console.error('[Concierge] checkAndCreateJob error:', err.message);
  }
  return false;
}

module.exports = { handleConciergeMessage };
