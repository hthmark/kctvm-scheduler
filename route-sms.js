const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { handleTechReply, handleCustomerTimeReply, handleJobCompletion, handleTechPhotos } = require('./service-orchestrator');
let handleConciergeMessage;
try {
  handleConciergeMessage = require('./service-concierge').handleConciergeMessage;
  console.log('[SMS] Concierge loaded OK');
} catch (err) {
  console.error('[SMS] Concierge load FAILED:', err.message);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function parseInbound(req) {
  const provider = process.env.SMS_PROVIDER;
  if (provider === 'twilio') {
    const mediaUrls = [];
    const numMedia = parseInt(req.body.NumMedia || '0');
    for (let i = 0; i < numMedia; i++) {
      if (req.body[`MediaUrl${i}`]) mediaUrls.push(req.body[`MediaUrl${i}`]);
    }
    return { from: req.body.From, body: (req.body.Body || '').trim(), mediaUrls };
  }
  if (provider === 'telnyx') {
    const data = req.body?.data?.payload;
    const mediaUrls = [];
    if (data?.media && Array.isArray(data.media)) {
      data.media.forEach(m => { if (m.url) mediaUrls.push(m.url); });
    }
    return {
      from: data?.from?.phone_number,
      body: (data?.text || '').trim(),
      mediaUrls,
      messageId: req.body?.data?.id || null
    };
  }
  return { from: null, body: null, mediaUrls: [] };
}

router.post('/inbound', async (req, res) => {
  res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  try {
    const { from, body, mediaUrls, messageId } = parseInbound(req);
    if (!from) return;
    if (from === process.env.TELNYX_PHONE_NUMBER || from === '+18162032001') return;

    // Deduplicate — Telnyx sometimes delivers the same webhook twice
    if (messageId) {
      const { data: existing } = await supabase
        .from('sms_conversations')
        .select('id')
        .eq('phone', from)
        .eq('content', 'MSGID:' + messageId)
        .limit(1);
      if (existing && existing.length > 0) {
        console.log('[SMS Inbound] Duplicate webhook ignored:', messageId);
        return;
      }
      await supabase.from('sms_conversations')
        .insert({ phone: from, role: 'dedup', content: 'MSGID:' + messageId });
    }

    const normalizedFrom = from.replace(/\D/g, '');
    const bodyLower = (body || '').toLowerCase().trim();
    console.log(`[SMS Inbound] From: ${from} | Body: "${body}" | Media: ${mediaUrls.length} files`);

    // ── CHECK IF SENDER IS A TECH ────────────────────────────────────────────
    const { data: tech } = await supabase
      .from('technicians').select('id, name')
      .or(`phone.eq.${from},phone.eq.+1${normalizedFrom}`).single();

    if (tech) {
      console.log(`[SMS Inbound] Tech found: ${tech.name}, body: "${bodyLower}", media: ${mediaUrls.length}`);

      // Tech sent photos — process them
      if (mediaUrls.length > 0) {
        const { data: confirmedJobs } = await supabase
          .from('jobs').select('id, num_tvs')
          .eq('confirmed_tech_id', tech.id)
          .eq('status', 'confirmed')
          .order('paid_at', { ascending: false })
          .limit(1);
        const job = confirmedJobs?.[0];
        if (job) {
          console.log(`[SMS Inbound] Processing ${mediaUrls.length} photos for job ${job.id}`);
          handleTechPhotos(job.id, tech.id, mediaUrls).catch(err =>
            console.error('[SMS Inbound] Photo processing error:', err)
          );
        }
        return;
      }

      // Tech has a job awaiting reply
      const { data: pendingJob } = await supabase
        .from('jobs').select('id, status, current_tech_id')
        .eq('current_tech_id', tech.id)
        .eq('status', 'awaiting_tech_reply')
        .single();

      if (pendingJob) {
        if (bodyLower === 'yes' || bodyLower === 'y') {
          await handleTechReply(pendingJob.id, tech.id, 'yes');
        } else if (bodyLower === 'no' || bodyLower === 'n') {
          await handleTechReply(pendingJob.id, tech.id, 'no');
        } else {
          const { sendSMS } = require('./service-sms');
          await sendSMS(from, `Please reply "Yes" if available or "No" if not. Thanks!`);
        }
        return;
      }

      // Tech replied Done
      if (bodyLower === 'done' || bodyLower === 'complete' || bodyLower === 'finished') {
        console.log(`[SMS Inbound] Tech ${tech.name} replied Done — looking for confirmed job`);
        const { data: confirmedJobs } = await supabase
          .from('jobs').select('id')
          .eq('confirmed_tech_id', tech.id)
          .eq('status', 'confirmed')
          .order('paid_at', { ascending: false })
          .limit(1);
        const confirmedJob = confirmedJobs?.[0] || null;
        if (confirmedJob) {
          console.log(`[SMS Inbound] Found confirmed job ${confirmedJob.id} — marking complete`);
          await handleJobCompletion(confirmedJob.id);
          const { sendSMS } = require('./service-sms');
          await sendSMS(from, `Great work! Job marked complete and review request sent to the customer. 🎉`);
          return;
        }
      }

      // Tech sent something else — ignore silently (they may be chatting)
      return;
    }

    // ── NOT A TECH — CHECK CUSTOMER WORKFLOW STATE ───────────────────────────

    // Check if customer is in active workflow waiting for time confirmation
    if (body) {
      const { data: workflowJobs } = await supabase
        .from('jobs').select('*')
        .or(`customer_phone.eq.${from},customer_phone.eq.+1${normalizedFrom}`)
        .in('status', ['awaiting_time_confirm', 'scheduling_conflict'])
        .order('created_at', { ascending: false })
        .limit(1);

      if (workflowJobs && workflowJobs.length > 0) {
        // Customer is replying with a new time — handle normally
        console.log(`[SMS Inbound] Customer in time-confirm workflow — routing to handleCustomerTimeReply`);
        await handleCustomerTimeReply(workflowJobs[0], body);
        return;
      }
    }

    // ── ROUTE TO AI CONCIERGE ────────────────────────────────────────────────
    // Customer is either: new, has active job in other state, or returning
    if (body) {
      if (!handleConciergeMessage) {
        console.error('[SMS Inbound] Concierge not loaded — cannot handle message from', from);
        return;
      }
      console.log(`[SMS Inbound] Routing to AI concierge for ${from}`);
      try {
        await handleConciergeMessage(from, body);
      } catch (err) {
        console.error('[SMS Inbound] Concierge error full:', err.message, err.stack);
      }
    }

  } catch (err) {
    console.error('[SMS Inbound] Error:', err);
  }
});

module.exports = router;
