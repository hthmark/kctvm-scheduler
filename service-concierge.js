/**
 * SMS Concierge Service
 * Handles inbound texts from customers who didn't come through the calculator
 * Identifies: new customer, in-workflow customer, returning customer
 * Uses Claude to respond in Gabe's voice with KCTVM knowledge
 */

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { sendSMS } = require('./service-sms');
const axios = require('axios');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const OWNER_PHONE = process.env.OWNER_PHONE || '+13862287246';
const WEBSITE_URL = 'https://kansascitytvmounting.com';
const REVIEW_URL = 'https://g.page/r/CWmvZghawMfzEBM/review';

// ─── KCTVM KNOWLEDGE BASE ─────────────────────────────────────────────────────
// Extracted from real conversations + business knowledge
const KNOWLEDGE_BASE = `
ABOUT KANSAS CITY TV MOUNTING (KCTVM):
- Owner: Gabe Gonzalez, phone: +19137350612
- Service area: Kansas City metro area and surrounding suburbs
- We mount TVs professionally and cleanly

PRICING:
- First TV (under 65"): $140
- First TV (65" or larger): $160
- Each additional TV (under 65"): $70
- Each additional TV (65"+): $80
- Fixed mount (if needed): +$60
- Articulating/full motion mount (if needed): +$120
- Brick wall: +$150 per TV
- Wire/cable concealment (routing wires behind drywall): +$150 per TV
- We do NOT charge extra for standard drywall

WIRE CONCEALMENT:
- We route wires behind the drywall to an existing outlet lower on the wall
- If there's NO outlet on the same wall, we need to install one — that's an extra $150 per TV
- If there IS an outlet on the wall (even near the floor), standard wire concealment pricing applies
- We do NOT hide wires in brick walls

MOUNTS:
- We use ONN universal mounts from Walmart
- Fixed mounts work for most standard TV placements
- Articulating/full motion mounts allow the TV to swivel/tilt
- We can pick up the mount for the customer (included in mount pricing)
- If customer already has a mount, we'll use theirs — but we verify it's compatible

SCHEDULING:
- We can often do same-day or next-day appointments
- Payment is required before we officially schedule
- Once tech is confirmed, customer gets a confirmation text

PAYMENT:
- We use Stripe for secure card payments
- Payment is collected upfront to lock in the appointment
- We send a payment link via text

SERVICE QUALITY:
- Techs take pride in their work — treat every install like it's their own home
- We clean up after ourselves
- We verify the mount is level and secure before leaving
- We send photos upon completion

COMMON QUESTIONS FROM PAST CUSTOMERS:
Q: Does the mounting include hiding the cables?
A: Wire concealment is an add-on at $150 per TV. It routes wires behind the drywall to an existing outlet.

Q: Can you do same day?
A: Often yes! Depends on tech availability. We'll check and let you know.

Q: Do I need to provide a mount?
A: No, we can pick one up for you (fixed +$60, articulating +$120). Or if you already have one we'll use it.

Q: What type of walls do you work with?
A: Drywall is standard pricing. Brick is +$150. Tile walls we assess case by case.

Q: How long does it take?
A: About 1-1.5 hours for most jobs.

Q: What areas do you serve?
A: Kansas City metro — including Lee's Summit, Overland Park, Olathe, Independence, Liberty, Gladstone, North KC, and surrounding areas.

Q: Do you do commercial installs?
A: We primarily do residential but have done commercial — reach out to discuss.

GABE'S COMMUNICATION STYLE:
- Casual and friendly, not corporate
- Uses "Hey [name]" to open
- Short sentences, gets to the point
- Warm but professional
- Says things like "Amazing!", "Perfect!", "Sounds good", "No worries!"
- Signs off as Gabe or just naturally ends the conversation
- Does NOT use emojis excessively
- Does NOT sound like a bot or a corporate script
`;

// ─── CONVERSATION HISTORY (persisted in Supabase) ────────────────────────────
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
  await supabase.from('sms_conversations').insert({ phone, role, content });
}

// ─── IDENTIFY CUSTOMER TYPE ───────────────────────────────────────────────────
async function identifyCustomer(phone) {
  const normalized = phone.startsWith('+') ? phone : `+1${phone.replace(/\D/g, '')}`;
  const normalizedStripped = phone.replace(/\D/g, '');

  // Check for active jobs
  const { data: activeJobs } = await supabase
    .from('jobs')
    .select('id, customer_name, status, preferred_time, city, confirmed_tech_name, stripe_payment_link')
    .or(`customer_phone.eq.${normalized},customer_phone.eq.+1${normalizedStripped}`)
    .not('status', 'in', '("cancelled","completed")')
    .order('created_at', { ascending: false })
    .limit(1);

  if (activeJobs && activeJobs.length > 0) {
    return { type: 'active', job: activeJobs[0] };
  }

  // Check for past completed jobs
  const { data: pastJobs } = await supabase
    .from('jobs')
    .select('id, customer_name, status, preferred_time, city, completed_at')
    .or(`customer_phone.eq.${normalized},customer_phone.eq.+1${normalizedStripped}`)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(1);

  if (pastJobs && pastJobs.length > 0) {
    return { type: 'returning', job: pastJobs[0] };
  }

  return { type: 'new', job: null };
}

// ─── BUILD SYSTEM PROMPT ─────────────────────────────────────────────────────
function buildSystemPrompt(customerType, job) {
  let contextNote = '';

  if (customerType === 'active') {
    const statusMessages = {
      new: 'Their quote was just received.',
      scheduling: 'We are checking calendar availability for their job.',
      awaiting_time_confirm: 'We texted them asking for a specific time.',
      scheduling_conflict: 'Their preferred time was unavailable, waiting for a new time.',
      tech_search: 'We are looking for an available tech.',
      awaiting_tech_reply: 'We texted a tech and are waiting for their reply.',
      awaiting_payment: `They have been sent a payment link: ${job.stripe_payment_link}. Payment must be completed to confirm the appointment.`,
      confirmed: `Their appointment is CONFIRMED. Tech: ${job.confirmed_tech_name || 'assigned'}. Time: ${job.preferred_time}. Location: ${job.city}.`,
    };
    contextNote = `
CURRENT CUSTOMER STATUS: This customer HAS AN ACTIVE JOB in the system.
Customer name: ${job.customer_name}
Current status: ${job.status}
${statusMessages[job.status] || `Status: ${job.status}`}
City: ${job.city}
Preferred time: ${job.preferred_time}

Respond as if you know their situation. Be helpful and specific to where they are in the process.
If they ask about their appointment status, tell them exactly what's happening.
If they need to pay, remind them and offer to resend the link.
`;
  } else if (customerType === 'returning') {
    contextNote = `
RETURNING CUSTOMER: This person has had a job completed with us before.
Name: ${job.customer_name}
Previous job: ${job.city}, ${job.preferred_time}

Greet them warmly as a returning customer. Reference their previous experience if relevant.
They may be booking again or have a question.
`;
  } else {
    contextNote = `
NEW CUSTOMER: This person has never contacted us before.
Greet them warmly. Find out what they need.
If they want a quote or to book, collect everything via text:
1. How many TVs?
2. What size(s)? (under 65" or 65"+)
3. Do they have a mount or need one? (fixed or articulating)
4. What type of wall? (drywall or brick)
5. Do they want wires concealed?
6. What city?
7. What time works for them?

Once you have all of that, give them the total price and confirm the booking directly.
You handle the entire booking — do NOT direct them to the website.
`;
  }

  return `You are an AI assistant for Kansas City TV Mounting (KCTVM), texting on behalf of Gabe Gonzalez.
You respond via SMS — keep messages concise and conversational. No long paragraphs. No bullet points. Sound like a real person texting, not a bot.
Never say you are an AI. If you genuinely cannot answer something or need Gabe to handle it personally, say "Let me check on that and get back to you shortly."

${contextNote}

KNOWLEDGE BASE:
${KNOWLEDGE_BASE}

IMPORTANT RULES:
- Keep responses under 300 characters when possible — this is SMS
- You handle EVERYTHING by text — pricing, booking, questions, scheduling. Never send someone to the website.
- If a customer wants to book, collect all the details yourself and confirm the job directly in this conversation.
- Never make up pricing or policies not in the knowledge base — if unsure, give your best answer based on what you know.
- Always be warm and helpful in Gabe's voice.
- ONLY say "Let me get Gabe on this for you" for serious one-off situations: complaints that need owner judgment, legal/liability questions, or something genuinely outside all your knowledge. This is the absolute last resort.
- Never mention the website unless the customer specifically asks for it.
`;
}

// ─── MAIN CONCIERGE HANDLER ───────────────────────────────────────────────────
async function handleConciergeMessage(from, body) {
  console.log(`[Concierge] Handling message from ${from}: "${body}"`);

  try {
    // Identify customer type
    const { type, job } = await identifyCustomer(from);
    console.log(`[Concierge] Customer type: ${type}`);

    // Get conversation history
    const history = await getHistory(from);

    // Add incoming message to history
    await addToHistory(from, 'user', body);

    // Build messages array for Claude
    const messages = [
      ...history.slice(0, -1), // All but the last (just added) message
      { role: 'user', content: body }
    ];

    // Call Claude
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: buildSystemPrompt(type, job),
      messages,
    });

    const reply = response.content[0].text.trim();
    console.log(`[Concierge] Reply: "${reply}"`);

    // Add reply to history
    await addToHistory(from, 'assistant', reply);

    // Check if Claude flagged for manual follow-up (last resort only)
    const needsManual = reply.toLowerCase().includes("get gabe on this") ||
                        reply.toLowerCase().includes("let me get gabe");

    if (needsManual) {
      console.log(`[Concierge] Flagged for manual follow-up: ${from}`);
    }

    // Check if Claude collected all job details and is ready to create a booking
    // Claude signals this by including the special marker [CREATE_JOB] in its thinking
    // We detect when the reply confirms a job and triggers the booking flow
    await checkAndCreateJob(from, reply, body, history);

    // Schedule follow-up if customer went cold after showing interest
    await scheduleConversationFollowUp(from, body, reply);

    // Send reply to customer
    await sendSMS(from, reply);
    return reply;

  } catch (err) {
    console.error('[Concierge] Error:', err);
    // Fallback — alert owner and send generic response
    await sendSMS(OWNER_PHONE, `📱 CONCIERGE ERROR — manual reply needed\nFrom: ${from}\nMsg: "${body}"`);
    await sendSMS(from, `Hey! Thanks for reaching out to Kansas City TV Mounting. We'll get back to you shortly!`);
  }
}

// ─── FOLLOW UP FOR COLD CONCIERGE LEADS ─────────────────────────────────────
const followUpTimers = new Map();

async function scheduleConversationFollowUp(phone, customerMsg, aiReply) {
  // Only schedule if the conversation looks like genuine interest
  const interestKeywords = ['how much', 'price', 'cost', 'charge', 'available', 'schedule', 'book', 'mount', 'install', 'tv', 'interested', 'when', 'how long'];
  const msgLower = customerMsg.toLowerCase();
  const looksInterested = interestKeywords.some(k => msgLower.includes(k));
  if (!looksInterested) return;

  // Check if we already sent a follow-up to this number ever — one and done
  const { data: alreadySent } = await supabase
    .from('follow_up_sent')
    .select('phone')
    .eq('phone', phone)
    .single();
  if (alreadySent) {
    console.log(`[Concierge] Follow-up already sent to ${phone} before — skipping`);
    return;
  }

  // Cancel any existing timer and reset clock on each new message
  if (followUpTimers.has(phone)) {
    clearTimeout(followUpTimers.get(phone));
  }

  const timer = setTimeout(async () => {
    followUpTimers.delete(phone);

    // Check again — already sent? skip
    const { data: alreadySentCheck } = await supabase
      .from('follow_up_sent').select('phone').eq('phone', phone).single();
    if (alreadySentCheck) return;

    // Check if they have an active job now — already converted, skip
    const normalized = phone.startsWith('+') ? phone : '+1' + phone.replace(/\D/g, '');
    const { data: activeJobs } = await supabase
      .from('jobs').select('id')
      .or(`customer_phone.eq.${normalized},customer_phone.eq.${phone}`)
      .not('status', 'in', '("cancelled","completed")')
      .limit(1);
    if (activeJobs && activeJobs.length > 0) {
      console.log(`[Concierge] Follow-up skipped for ${phone} — already has active job`);
      return;
    }

    // Check if they messaged recently — if so skip
    const { data: recentMsg } = await supabase
      .from('sms_conversations').select('created_at')
      .eq('phone', phone).eq('role', 'user')
      .order('created_at', { ascending: false }).limit(1);
    if (recentMsg && recentMsg.length > 0) {
      const timeSince = Date.now() - new Date(recentMsg[0].created_at).getTime();
      if (timeSince < 2.5 * 60 * 60 * 1000) {
        console.log(`[Concierge] Follow-up skipped for ${phone} — messaged recently`);
        return;
      }
    }

    // Get first name from conversation if we have it
    const history = await getHistory(phone);
    const nameMsg = history.find(m => m.role === 'user')?.content || '';
    const nameMatch = nameMsg.match(/(?:i'm|my name is|this is)\s+([a-z]+)/i);
    const greeting = nameMatch ? `Hey ${nameMatch[1]}` : 'Hey';

    // Send the one and only follow-up
    await sendSMS(phone, `${greeting}, just following up to see if you were still interested in getting your TV mounted? No worries if not!`);

    // Record that we sent it — never send again
    await supabase.from('follow_up_sent').insert({ phone });
    console.log(`[Concierge] Follow-up sent to ${phone} — marked as sent permanently`);

  }, 3 * 60 * 60 * 1000);

  followUpTimers.set(phone, timer);
  console.log(`[Concierge] Follow-up scheduled for ${phone} in 3 hours`);
}

// ─── JOB CREATION FROM CONCIERGE CONVERSATION ───────────────────────────────
async function checkAndCreateJob(phone, reply, latestMsg, history) {
  // Ask Claude to extract job details if the conversation has enough info
  // Only run this check if conversation is long enough (at least 8 messages)
  if (history.length < 6) return;

  const conversationText = history.map(m => `${m.role === 'user' ? 'Customer' : 'KCTVM'}: ${m.content}`).join('\n');

  const extractPrompt = `Given this SMS conversation, determine if we have COMPLETE job details to create a booking.
Required: customer name, phone, city, preferred time, number of TVs, TV sizes, mount type for each TV, wall type, wire concealment preference.

Conversation:
${conversationText}
Latest customer message: ${latestMsg}

If ALL details are present and the customer has agreed to the price, respond with JSON:
{
  "ready": true,
  "name": "customer name",
  "city": "city",
  "preferred_time": "time they want",
  "num_tvs": 1,
  "total_price": 140,
  "tv_1_size": "small or large",
  "tv_1_mount": "yes/fixed/articulating",
  "tv_1_wall": "drywall/brick",
  "tv_1_wire": "no/cable"
}

If not all details are present yet, respond with: {"ready": false}
Respond with JSON only.`;

  try {
    const extractResponse = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: extractPrompt }],
    });

    const text = extractResponse.content[0].text.trim().replace(/```json|```/g, '');
    const data = JSON.parse(text);

    if (data.ready) {
      console.log(`[Concierge] Job details complete — creating job for ${phone}`);
      // Submit to our own webhook to create the job in the system
      const payload = { ...data, phone };
      delete payload.ready;

      await axios.post(`${process.env.BASE_URL}/webhook/quote`, payload, {
        headers: { 'Content-Type': 'application/json' }
      });

      console.log(`[Concierge] Job created via text booking for ${phone}`);
    }
  } catch (err) {
    console.error('[Concierge] Job extraction error:', err.message);
  }
}

module.exports = { handleConciergeMessage };
