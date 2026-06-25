// force redeploy
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { handleTechReply, handleJobCompletion, handleTechPhotos, handleRescheduleRequest, handleRescheduleConfirmDay, handleRescheduleReply, handleLateCancellation } = require('./service-orchestrator');
const { handleConciergeMessage } = require('./service-concierge');

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
    return { from: data?.from?.phone_number, body: (data?.text || '').trim(), mediaUrls };
  }
  return { from: null, body: null, mediaUrls: [] };
}

router.post('/inbound', async (req, res) => {
  res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  try {
    const { from, body, mediaUrls } = parseInbound(req);
    if (!from) return;
    console.log('[SMS Inbound] Raw from number:', from, '| Telnyx number:', process.env.TELNYX_PHONE_NUMBER);
    if (from === '+18162032001' || from === process.env.TELNYX_PHONE_NUMBER) return;
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
          await sendSMS(from, `Just reply Yes if you're available or No if you're not and we'll get you taken care of!`);
        }
        return;
      }

      // Tech is replying to a reschedule confirmation request
      const { data: reschedulingJob } = await supabase
        .from('jobs').select('*')
        .eq('current_tech_id', tech.id)
        .eq('status', 'rescheduling_tech_confirm')
        .single();

      if (reschedulingJob) {
        if (bodyLower === 'yes' || bodyLower === 'y') {
          await handleRescheduleReply(reschedulingJob, tech.id, 'yes');
        } else if (bodyLower === 'no' || bodyLower === 'n') {
          await handleRescheduleReply(reschedulingJob, tech.id, 'no');
        } else {
          const { sendSMS } = require('./service-sms');
          await sendSMS(from, `Just reply Yes if the new time works or No if not and we'll get you taken care of!`);
        }
        return;
      }

      // Late cancellation — tech says No on a job they already accepted
      if ((bodyLower === 'no' || bodyLower === 'n') && !pendingJob && !reschedulingJob) {
        const { data: activeJob } = await supabase
          .from('jobs').select('*')
          .eq('confirmed_tech_id', tech.id)
          .in('status', ['confirmed', 'awaiting_payment'])
          .single();
        if (activeJob) {
          console.log(`[SMS Inbound] Late cancellation from tech ${tech.name} on job ${activeJob.id}`);
          handleLateCancellation(activeJob, tech.id).catch(err =>
            console.error('[SMS Inbound] Late cancellation error:', err)
          );
          return;
        }
      }

      // Tech replied Done
      if (bodyLower === 'done' || bodyLower === 'complete' || bodyLower === 'finished') {
        console.log(`[SMS Inbound] Tech ${tech.name} replied Done — looking for confirmed job`);
        const { data: confirmedJobs } = await supabase
          .from('jobs').select('id, tv_1_photo, photos_received_at')
          .eq('confirmed_tech_id', tech.id)
          .eq('status', 'confirmed')
          .order('paid_at', { ascending: false })
          .limit(1);
        const confirmedJob = confirmedJobs?.[0] || null;
        if (confirmedJob) {
          if (!confirmedJob.tv_1_photo && !confirmedJob.photos_received_at) {
            const { sendSMS } = require('./service-sms');
            await sendSMS(from, `Don't forget to send your completion photos before we wrap up — we need those on file!`);
            return;
          }
          console.log(`[SMS Inbound] Found confirmed job ${confirmedJob.id} — marking complete`);
          await handleJobCompletion(confirmedJob.id);
          const { sendSMS } = require('./service-sms');
          await sendSMS(from, `Great work! Job marked complete and review request sent to the customer. 🎉`);
          return;
        }
      }

      // Check if tech mentions money/supplies without a receipt photo
      var moneyKeywords = ['spent', 'paid', 'cost', 'receipt', 'reimbur', 'supplies', 'bought', 'picked up', '$'];
      var mentionsMoney = moneyKeywords.some(function(k) { return bodyLower.includes(k); });
      if (mentionsMoney && mediaUrls.length === 0) {
        const { sendSMS: sms } = require('./service-sms');
        await sms(from, 'No problem! Can you send a photo of the receipt so we can add it to your payout?');
        return;
      }

      // If tech has a confirmed job whose scheduled time has passed and no photos yet, remind them
      const { data: overdueJob } = await supabase
        .from('jobs').select('id, scheduled_time, tv_1_photo, photos_received_at')
        .eq('confirmed_tech_id', tech.id)
        .eq('status', 'confirmed')
        .single();
      if (overdueJob && !overdueJob.tv_1_photo && !overdueJob.photos_received_at) {
        const scheduledTime = new Date(overdueJob.scheduled_time);
        if (scheduledTime < new Date()) {
          const { sendSMS: sms } = require('./service-sms');
          await sms(from, `Don't forget to send your completion photos before we wrap up — we need those on file!`);
          return;
        }
      }

      // Tech sent something else — ignore silently
      return;
    }

    // ── CHECK FOR RESCHEDULING DAY CONFIRM (customer replying to "11 AM tomorrow?") ─
    if (body) {
      const { data: dayConfirmJob } = await supabase
        .from('jobs').select('*')
        .or(`customer_phone.eq.${from},customer_phone.eq.+1${normalizedFrom}`)
        .eq('status', 'rescheduling_day_confirm')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (dayConfirmJob) {
        console.log(`[SMS Inbound] Day-confirm reply from ${from} for job ${dayConfirmJob.id}: "${body}"`);
        handleRescheduleConfirmDay(dayConfirmJob, body).catch(err =>
          console.error('[SMS Inbound] RescheduleConfirmDay error:', err)
        );
        return;
      }
    }

    // ── CHECK FOR RESCHEDULE REQUEST ─────────────────────────────────────────
    const rescheduleKeywords = ['reschedule', 'change', 'move', 'different time', 'different day', 'can we do', 'can you come'];
    const isRescheduleRequest = rescheduleKeywords.some(kw => bodyLower.includes(kw));

    if (isRescheduleRequest && body) {
      const { data: activeJob } = await supabase
        .from('jobs').select('*')
        .or(`customer_phone.eq.${from},customer_phone.eq.+1${normalizedFrom}`)
        .in('status', ['confirmed', 'awaiting_payment'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (activeJob) {
        console.log(`[SMS Inbound] Reschedule request from ${from} for job ${activeJob.id}`);
        handleRescheduleRequest(activeJob, body).catch(err =>
          console.error('[SMS Inbound] Reschedule error:', err)
        );
        return;
      }
    }

    // ── ROUTE TO AI CONCIERGE ────────────────────────────────────────────────
    // Customer is either: new, has active job in other state, or returning
    if (body) {
      console.log(`[SMS Inbound] Routing to AI concierge for ${from}`);
      handleConciergeMessage(from, body, mediaUrls).catch(err =>
        console.error('[SMS Inbound] Concierge error:', err)
      );
    }

  } catch (err) {
    console.error('[SMS Inbound] Error:', err);
  }
});

module.exports = router;
