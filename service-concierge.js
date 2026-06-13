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
  '- When quoting with a mount, always ask "unless you have your own mount?" at the end — never assume they need one.\n' +
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
    context = 'New customer. On the VERY FIRST message, introduce yourself as Gabe from Kansas City TV Mounting, thank them for reaching out, always ask for their name like this: "Do you mind if I grab your name?" — never "What\'s your name?" or "May I ask your name?", and answer their question — all in the same message. Then ask about the wall type but phrase it in a friendly way that helps them understand — say something like "Do you know what type of wall you\'re mounting to? Is it a normal wall like drywall or is it brick?" — never just say "what type of wall?" cold. If they respond without giving their name, keep gently asking each time until you get it — vary the phrasing so it doesn\'t sound robotic. Once you have their name use it naturally throughout. If they want to book, collect: number of TVs, size, mount type, wall type, wire concealment, city, preferred time.';
  }
  return 'You are texting for Kansas City TV Mounting (KCTVM) on behalf of Gabe. Keep replies short — this is SMS. Sound like a real person, not a bot. Never say you are AI.\n\n' +
    context + '\n\n' +
    KNOWLEDGE_BASE + '\n\n' +
    'SCHEDULING — READ THIS CAREFULLY:\n' +
    '"Soonest", "earliest", "today", "asap", "as soon as possible" ALL mean: check the calendar and find the next available slot at least 4 hours from right now. You already have this time in nextSlot. PROPOSE IT IN YOUR RESPONSE. Do not ask when they want to come. Do not say you will check. You have already checked. Just say the time.\n' +
    'NEVER suggest or propose a time unless the customer has told you a specific time or said "soonest/earliest/asap/today". If they have not mentioned a time yet, just ask: "What day and time works best for you?"\n' +
    'CRITICAL TIME RESPONSE RULES:\n' +
    '1. If the customer requested a SPECIFIC time and that time IS available: immediately say "We sure do! I\'ll put you down for [time] in [city] but let me confirm with my techs just to be 100% sure — once that\'s done I\'ll reach back out with a payment link and you\'ll be all set!" — do NOT ask if it works, do NOT say "I see we have an opening", just confirm it.\n' +
    '2. If you are proposing the EARLIEST available time they did not request: say "I see we have an opening at [time] — does that work for you?"\n' +
    '3. Never mix these two cases up.\n' +
    'When customer confirms a time, say: "Amazing! I\'ll put you down for [time] in [city] but let me confirm with my techs just to be 100% sure — once that\'s done I\'ll reach back out with a payment link and you\'ll be all set!" Then stop.\n' +
    'Only submit the job AFTER the customer says yes to a specific time you proposed.\n' +
    (nextSlot ? '- The next available time slot is ' + nextSlot.label + '. You MUST say this time in your reply RIGHT NOW.\n' : '- No calendar slot available yet — ask what time of day works best.\n') +
    '- NEVER assume or mention a city the customer has not told you. Ask for it first.\n' +
    '- A time followed by a question mark (e.g. "7pm?") means they are asking if 7pm works — treat it the same as "7pm".\n\n' +
    'CONVERSATION RULES:\n' +
    '- Do NOT mention Stripe, payment links, or locking in until AFTER the job is confirmed and the customer has agreed. Never bring it up during the booking conversation.\n' +
    '- Do NOT info dump. Answer only what the customer asked. One or two questions max per message.\n' +
    '- Never mention Walmart, Home Depot, or any store name to customers. Ever.\n' +
    'Only say "Let me get Gabe on this" for genuine legal/liability issues — absolute last resort.\n' +
    'CRITICAL: Your response is sent DIRECTLY as an SMS text message to a real customer. Do NOT include ANY of the following: asterisks, bullet points, brackets, internal notes, job summaries, or descriptions of what you are doing. No **bold**, no - lists, no [brackets], no *asterisks*. Just plain conversational text like a real person would text. Violating this rule will embarrass the business.\n' +
    'When you have a nextSlot time, say it directly in your message. Do not say "I will check and get back to you" — you already have the time, just say it.\n';
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

async function findNextAvailableTime(requestedTime) {
  const { isTimeAvailable, attemptDateParse } = require('./service-calendar');

  // If customer requested a specific time, check that first
  if (requestedTime) {
    const parsed = attemptDateParse(requestedTime);
    if (parsed && parsed > new Date()) {
      console.log('[Concierge] Requested time: "' + requestedTime + '" parsed to: ' + (parsed ? parsed.toISOString() : 'null'));
      const available = await isTimeAvailable(parsed).catch(() => false);
      if (available) {
        const timeStr = parsed.toLocaleString('en-US', {
          timeZone: 'America/Chicago',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          weekday: 'short',
          month: 'numeric',
          day: 'numeric'
        });
        return { time: parsed, label: timeStr };
      }
    }
  }

  // Otherwise find next available slot 4+ hours from now
  const now = new Date();
  let candidate = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const minutes = candidate.getMinutes();
  if (minutes < 30) {
    candidate.setMinutes(30, 0, 0);
  } else {
    candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
  }

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
    // Check if customer mentioned a specific time
    var specificTimeMatch = body.match(/\d{1,2}(:\d{2})?\s*(am|pm)|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i);
    var requestedTime = specificTimeMatch ? body : null;
    if ((wantsEarliestTime || requestedTime) && hasCity && history.length >= 2) {
      nextSlot = await findNextAvailableTime(requestedTime);
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
    var confirmedWords = ["that'll work", "that works", "yes", "perfect", "sounds good", "great", "yep", "sure", "ok", "okay", "works for me", "let's do it", "do it"];
    var customerConfirmed = confirmedWords.some(function(w) { return msgLower.includes(w); });
    var hasConfirmedTime = customerConfirmed || updatedHistory.some(function(m) {
      return m.role === 'user' && m.content.match(/\d{1,2}(:\d{2})?\s*(am|pm)|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i);
    });
    var jobCreated = hasConfirmedTime ? await checkAndCreateJob(from, updatedHistory) : false;
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
      // Never submit a job with a vague time
      var vagueTerms = ['soonest', 'earliest', 'asap', 'as soon as', 'today', 'requesting'];
      if (data.preferred_time && vagueTerms.some(function(t) { return data.preferred_time.toLowerCase().includes(t); })) {
        console.log('[Concierge] Blocked job submission — time not confirmed yet: ' + data.preferred_time);
        return false;
      }
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
