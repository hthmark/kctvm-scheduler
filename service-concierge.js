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
  '- Wire/cable concealment: +$150 per TV (requires existing outlet on same wall)\n' +
  '- IMPORTANT: Base price is labor only. Mounts are NEVER included. Always an add-on.\n' +
  '- TVs 65" or larger: You MUST confirm someone will help with the lift before proposing a time or submitting the job. If they say no one can help, say "Let me get Gabe on this for you" — do not proceed.\n' +
  '- TVs 65" or larger: Ask about the lift like this: "Just a heads up - since it\'s 65"+, we might need a hand lifting it onto the mount. Will someone be able to help us with that? If not, we\'d have to send out two techs which would generally double the price of the installation and I\'d hate to do that to you."\n\n' +
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

function buildSystemPrompt(customerType, job, nextSlot) {
  var context = '';
  if (customerType === 'active' && job) {
    context = 'This customer has an active job. Name: ' + job.customer_name + '. Status: ' + job.status + '. Time: ' + job.preferred_time + '. City: ' + job.city + '. If awaiting_payment, remind them their payment link was already sent.';
  } else if (customerType === 'returning' && job) {
    context = 'Returning customer. Name: ' + job.customer_name + '. Had a job in ' + job.city + ' on ' + job.preferred_time + '. Greet them warmly.';
  } else {
    context = 'New customer. On the VERY FIRST message, introduce yourself as Gabe from Kansas City TV Mounting, thank them for reaching out, ask for their name, and answer their question — all in the same message. Then ask about the wall type but phrase it in a friendly way that helps them understand — say something like "Do you know what type of wall you\'re mounting to? Is it a normal wall like drywall or is it brick?" — never just say "what type of wall?" cold. If they respond without giving their name, keep gently asking each time until you get it — vary the phrasing so it doesn\'t sound robotic. Once you have their name use it naturally throughout. If they want to book, collect: number of TVs, size, mount type, wall type, wire concealment, city, preferred time.';
  }
  return 'You are texting for Kansas City TV Mounting (KCTVM) on behalf of Gabe. Keep replies short — this is SMS. Sound like a real person, not a bot. Never say you are AI.\n\n' +
    context + '\n\n' +
    KNOWLEDGE_BASE + '\n\n' +
    'SCHEDULING RULES:\n' +
    '- "Soonest you can be here" or "today" always means check the calendar and find the earliest slot at least 4 hours from now. Never suggest a time less than 4 hours out — techs need travel and prep time. Do NOT tell the customer this reason.\n' +
    '- If the customer asks for a specific time, check if it is at least 4 hours away. If not, offer the next available slot after that.\n' +
    (nextSlot ? '- Calendar has been checked. Next available slot is: ' + nextSlot.label + '. Propose it naturally like Gabe would — example: "Blue Springs works great! I see an opening at ' + nextSlot.label + ' — does that work for you? Also just want to make sure, will someone be around to help with the lift on that 65\\"+ TV?". Always ask about the lift helper in the same message if you have not confirmed it yet. If they say no one can help, say "Let me get Gabe on this for you" and route to manual.\n' : '- If customer asks for soonest time but you do not have calendar info yet, just ask what time of day works best.\n') +
    '- NEVER assume or mention a city that the customer has not told you in THIS conversation. If you do not have the city yet, ask for it BEFORE checking availability or proposing a time.\n' +
    '- NEVER say "let me check availability" and then wait. When you say you will check availability, DO NOT wait for the customer to respond. Immediately submit the job using the details already collected and let the system handle it. Never say "give me a few minutes" and then do nothing.\n' +
    '- A time followed by a question mark (e.g. "7pm?") means they are asking if 7pm works — treat it exactly the same as "7pm".\n\n' +
    'CONVERSATION RULES:\n' +
    '- Do NOT mention Stripe, payment links, or locking in until AFTER the job is confirmed and the customer has agreed. Never bring it up during the booking conversation.\n' +
    '- Do NOT info dump. Answer only what the customer asked. One or two questions max per message.\n' +
    '- Never mention Walmart, Home Depot, or any store name to customers. Ever.\n' +
    'Only say "Let me get Gabe on this" for genuine legal/liability issues — absolute last resort.\n';
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

async function findNextAvailableTime() {
  const { isTimeAvailable } = require('./service-calendar');
  const now = new Date();

  // Start at least 4 hours from now, rounded to next half hour
  let candidate = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  candidate.setMinutes(candidate.getMinutes() < 30 ? 30 : 0);
  if (candidate.getMinutes() === 0) candidate.setHours(candidate.getHours() + 1);

  // Try up to 20 slots in 30-minute increments
  for (let i = 0; i < 20; i++) {
    try {
      const available = await isTimeAvailable(candidate);
      if (available) {
        const timeStr = candidate.toLocaleString('en-US', {
          timeZone: 'America/Chicago',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          weekday: 'short',
          month: 'numeric',
          day: 'numeric'
        });
        return { time: candidate, label: timeStr };
      }
    } catch (err) {
      console.error('[Concierge] Calendar check error:', err.message);
      break;
    }
    candidate = new Date(candidate.getTime() + 30 * 60 * 1000);
  }
  return null;
}

async function handleConciergeMessage(from, body) {
  console.log('[Concierge] Message from ' + from + ': "' + body + '"');
  try {
    var info = await identifyCustomer(from);
    console.log('[Concierge] Customer type: ' + info.type);

    // If conversation has all details and customer asked for soonest time, check calendar
    var history = await getHistory(from);
    var msgLower = body.toLowerCase();
    var wantsEarliestTime = msgLower.includes('soonest') || msgLower.includes('earliest') || msgLower.includes('asap') || msgLower.includes('today') || msgLower.includes('as soon as') ||
      history.some(function(m) { return m.role === 'user' && (m.content.toLowerCase().includes('soonest') || m.content.toLowerCase().includes('earliest') || m.content.toLowerCase().includes('asap')); });
    var nextSlot = null;
    var hasCity = history.some(function(m) { return m.role === 'user' && (m.content.toLowerCase().includes('springs') || m.content.toLowerCase().includes('city') || m.content.toLowerCase().includes('kansas') || m.content.toLowerCase().includes('overland') || m.content.toLowerCase().includes('summit') || m.content.toLowerCase().includes('olathe') || m.content.toLowerCase().includes('independence') || m.content.toLowerCase().includes('liberty') || m.content.toLowerCase().includes('gladstone') || m.content.toLowerCase().includes('independence')); });
    if (wantsEarliestTime && hasCity && history.length >= 2) {
      nextSlot = await findNextAvailableTime();
    }

    var messages = history.slice(-10).concat([{ role: 'user', content: body }]);
    var systemPrompt = buildSystemPrompt(info.type, info.job, nextSlot);
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
  if (history.length < 2) return;
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
