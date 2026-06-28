// force redeploy
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { handleTechReply, handleJobCompletion, handleTechPhotos, handleRescheduleRequest, handleRescheduleConfirmDay, handleRescheduleReply, handleLateCancellation, handleTechCancelRequest, handleTechCancelConfirm, handleTechRescheduleRequest, handleTechRescheduleTime, handleTechRescheduleCustReply, handleTechRescheduleDayConfirm, handleTechRescheduleImpliedDayConfirm, handleTechRescheduleReconfirm, handleTechConfirmedMessage } = require('./service-orchestrator');
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
    const { data: tech, error: techLookupError } = await supabase
      .from('technicians').select('id, name')
      .or(`phone.eq.${from},phone.eq.+1${normalizedFrom}`).single();
    console.log(`[SMS Inbound] Tech lookup for ${from} (normalized: +1${normalizedFrom}) — result: ${tech ? `found: ${tech.name} (${tech.id})` : `not found (${techLookupError?.message || 'no match'})`}`);

    if (tech) {
      console.log(`[SMS Inbound] Tech found: ${tech.name}, body: "${bodyLower}", media: ${mediaUrls.length}`);

      // Fetch tech's most relevant active job for debug visibility and status-based routing
      const { data: techActiveJob } = await supabase
        .from('jobs').select('*')
        .or(`confirmed_tech_id.eq.${tech.id},current_tech_id.eq.${tech.id}`)
        .not('status', 'in', '("completed","cancelled")')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();
      console.log(`[TechHandler] status="${techActiveJob?.status}" confirmed_tech_id="${techActiveJob?.confirmed_tech_id}" current_tech_id="${techActiveJob?.current_tech_id}" body="${body}"`);

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

      // Tech has a job awaiting reply — match to the most recently dispatched job for this tech
      const { data: pendingJobs } = await supabase
        .from('jobs').select('id, status, current_tech_id, tech_notified_at')
        .eq('current_tech_id', tech.id)
        .eq('status', 'awaiting_tech_reply')
        .order('tech_notified_at', { ascending: false })
        .limit(1);
      const pendingJob = pendingJobs?.[0] || null;

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

      // Tech replying late — job already moved on to another tech
      if (!pendingJob && (bodyLower === 'yes' || bodyLower === 'y' || bodyLower === 'no' || bodyLower === 'n')) {
        const { data: movedJob } = await supabase
          .from('jobs').select('id, current_tech_id')
          .eq('id', techActiveJob?.id)
          .neq('current_tech_id', tech.id)
          .not('status', 'in', '("completed","cancelled")')
          .single();
        if (movedJob) {
          const { sendSMS: sms } = require('./service-sms');
          await sms(from, `Hey ${tech.name.split(' ')[0]}, thanks for getting back to us — we already routed this one to another tech but we'll keep you in mind for the next one!`);
          return;
        }
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

      // Tech confirming they want to cancel
      const { data: cancelConfirmJob } = await supabase
        .from('jobs').select('*')
        .eq('confirmed_tech_id', tech.id)
        .eq('status', 'tech_cancel_confirm')
        .single();

      if (cancelConfirmJob) {
        const isYes = bodyLower === 'yes' || bodyLower === 'y';
        handleTechCancelConfirm(cancelConfirmJob, tech.id, isYes).catch(err =>
          console.error('[SMS Inbound] TechCancelConfirm error:', err)
        );
        return;
      }

      // Tech providing a new time after requesting reschedule
      const { data: techReschedJob } = await supabase
        .from('jobs').select('*')
        .eq('confirmed_tech_id', tech.id)
        .eq('status', 'tech_reschedule_pending')
        .single();

      if (techReschedJob) {
        handleTechRescheduleTime(techReschedJob, tech.id, body).catch(err =>
          console.error('[SMS Inbound] TechRescheduleTime error:', err)
        );
        return;
      }

      // Tech responding to customer counter-time reconfirm request
      const { data: techReconfirmJob } = await supabase
        .from('jobs').select('*')
        .eq('confirmed_tech_id', tech.id)
        .eq('status', 'tech_reschedule_tech_reconfirm')
        .single();

      if (techReconfirmJob) {
        const isYes = bodyLower === 'yes' || bodyLower === 'y';
        handleTechRescheduleReconfirm(techReconfirmJob, tech.id, isYes).catch(err =>
          console.error('[SMS Inbound] TechRescheduleReconfirm error:', err)
        );
        return;
      }

      // Tech confirming day for a bare-time implied reschedule
      const { data: techImpliedDayJob } = await supabase
        .from('jobs').select('*')
        .eq('confirmed_tech_id', tech.id)
        .eq('status', 'tech_reschedule_day_confirm')
        .single();

      if (techImpliedDayJob) {
        handleTechRescheduleImpliedDayConfirm(techImpliedDayJob, tech.id, body).catch(err =>
          console.error('[SMS Inbound] TechRescheduleImpliedDayConfirm error:', err)
        );
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

      // Tech message on a confirmed/awaiting_payment job — time-first detection
      {
        const { data: activeConfirmedJob } = await supabase
          .from('jobs').select('*')
          .eq('confirmed_tech_id', tech.id)
          .in('status', ['confirmed', 'awaiting_payment'])
          .order('updated_at', { ascending: false })
          .limit(1)
          .single();

        if (activeConfirmedJob) {
          handleTechConfirmedMessage(activeConfirmedJob, tech.id, body, bodyLower).catch(err =>
            console.error('[SMS Inbound] TechConfirmedMessage error:', err)
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

    // ── TECH-INITIATED RESCHEDULE — customer confirming proposed time ─────────
    if (body) {
      const { data: techReschedCustJob } = await supabase
        .from('jobs').select('*')
        .or(`customer_phone.eq.${from},customer_phone.eq.+1${normalizedFrom}`)
        .eq('status', 'tech_reschedule_customer_confirm')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (techReschedCustJob) {
        console.log(`[SMS Inbound] Tech-reschedule customer reply from ${from} for job ${techReschedCustJob.id}: "${body}"`);
        handleTechRescheduleCustReply(techReschedCustJob, body).catch(err =>
          console.error('[SMS Inbound] TechRescheduleCustReply error:', err)
        );
        return;
      }
    }

    // ── TECH-RESCHEDULE DAY CONFIRM — customer confirming day for time-only counter ─
    if (body) {
      const { data: techReschedDayJob } = await supabase
        .from('jobs').select('*')
        .or(`customer_phone.eq.${from},customer_phone.eq.+1${normalizedFrom}`)
        .eq('status', 'tech_reschedule_day_confirm')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (techReschedDayJob) {
        console.log(`[SMS Inbound] Tech-reschedule day confirm from ${from} for job ${techReschedDayJob.id}: "${body}"`);
        handleTechRescheduleDayConfirm(techReschedDayJob, body).catch(err =>
          console.error('[SMS Inbound] TechRescheduleDayConfirm error:', err)
        );
        return;
      }
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
    // Strong reschedule signals — fire on their own
    const rescheduleStrongSignals = [
      'reschedule', 'change', 'move', 'different time', 'different day',
      'can we do', 'can i do', 'how about', 'what about'
    ];
    // Weak change-of-mind signals — only fire when paired with a time expression
    const rescheduleWeakSignals = ['actually', 'instead'];
    const rescheduleTimeExpressions = [
      /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i,
      /\btomorrow\b/i,
      /\bmonday\b|\btuesday\b|\bwednesday\b|\bthursday\b|\bfriday\b|\bsaturday\b|\bsunday\b/i,
      /\bnext\s+(week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      /\bthis\s+(morning|afternoon|evening)\b/i,
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i,
    ];
    const hasStrongSignal = rescheduleStrongSignals.some(kw => bodyLower.includes(kw));
    const hasWeakSignal = rescheduleWeakSignals.some(kw => bodyLower.includes(kw));
    const hasTimeExpression = rescheduleTimeExpressions.some(re => re.test(bodyLower));
    const isRescheduleRequest = hasStrongSignal || (hasWeakSignal && hasTimeExpression);

    if (isRescheduleRequest && body) {
      const { data: activeJob } = await supabase
        .from('jobs').select('*')
        .or(`customer_phone.eq.${from},customer_phone.eq.+1${normalizedFrom}`)
        .not('status', 'in', '("completed","cancelled")')
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
