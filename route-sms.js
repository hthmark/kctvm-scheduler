const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { handleTechReply, handleCustomerTimeReply, handleJobCompletion } = require('./service-orchestrator');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function parseInbound(req) {
  const provider = process.env.SMS_PROVIDER;
  if (provider === 'twilio') {
    return { from: req.body.From, body: (req.body.Body || '').trim() };
  }
  if (provider === 'telnyx') {
    const data = req.body?.data?.payload;
    return { from: data?.from?.phone_number, body: (data?.text || '').trim() };
  }
  return { from: null, body: null };
}

router.post('/inbound', async (req, res) => {
  res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  try {
    const { from, body } = parseInbound(req);
    if (!from || !body) return;
    const normalizedFrom = from.replace(/\D/g, '');
    const bodyLower = body.toLowerCase().trim();
    console.log(`[SMS Inbound] From: ${from} | Body: "${body}"`);

    // Check if sender is a tech
    const { data: tech } = await supabase
      .from('technicians').select('id, name')
      .or(`phone.eq.${from},phone.eq.+1${normalizedFrom}`).single();

    if (tech) {
      console.log(`[SMS Inbound] Tech found: ${tech.name}, body: "${bodyLower}"`);

      // Check if tech has a job awaiting their reply
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

      // Always check for Done regardless of pending jobs
      if (bodyLower === 'done' || bodyLower === 'complete' || bodyLower === 'finished') {
        console.log(`[SMS Inbound] Tech ${tech.name} replied Done — looking for confirmed job`);
        const { data: confirmedJob } = await supabase
          .from('jobs').select('id')
          .eq('confirmed_tech_id', tech.id)
          .eq('status', 'confirmed')
          .single();

        if (confirmedJob) {
          console.log(`[SMS Inbound] Found confirmed job ${confirmedJob.id} — marking complete`);
          await handleJobCompletion(confirmedJob.id);
          const { sendSMS } = require('./service-sms');
          await sendSMS(from, `Great work! Job marked complete and review request sent to the customer. 🎉`);
          return;
        } else {
          console.log(`[SMS Inbound] No confirmed job found for tech ${tech.name}`);
        }
      }
    }

    // Check if sender is a customer waiting for time confirmation
    const { data: jobs } = await supabase
      .from('jobs').select('*')
      .or(`customer_phone.eq.${from},customer_phone.eq.+1${normalizedFrom}`)
      .in('status', ['awaiting_time_confirm', 'scheduling_conflict'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (jobs && jobs.length > 0) {
      await handleCustomerTimeReply(jobs[0], body);
    }

  } catch (err) {
    console.error('[SMS Inbound] Error:', err);
  }
});

module.exports = router;
