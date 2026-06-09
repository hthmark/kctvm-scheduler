const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { processNewJob } = require('./service-orchestrator');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

router.post('/quote', async (req, res) => {
  try {
    const payload = req.body;
    console.log('[Webhook] Received quote:', JSON.stringify(payload));
    if (!payload.name || !payload.phone) {
      return res.status(400).json({ error: 'Missing required fields: name, phone' });
    }
    const jobData = {
      customer_name: payload.name,
      customer_phone: payload.phone.startsWith('+') ? payload.phone : `+1${payload.phone.replace(/\D/g, '')}`,
      city: payload.city,
      preferred_time: payload.preferred_time,
      num_tvs: parseInt(payload.num_tvs) || 1,
      total_price: parseFloat(payload.total_price) || 0,
      status: 'new',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    for (let i = 1; i <= 10; i++) {
      jobData[`tv_${i}_size`]   = payload[`tv_${i}_size`]   || null;
      jobData[`tv_${i}_inches`] = payload[`tv_${i}_inches`] ? parseInt(payload[`tv_${i}_inches`]) : null;
      jobData[`tv_${i}_mount`]  = payload[`tv_${i}_mount`]  || null;
      jobData[`tv_${i}_wall`]   = payload[`tv_${i}_wall`]   || null;
      jobData[`tv_${i}_wire`]   = payload[`tv_${i}_wire`]   || null;
    }
    const { data: job, error } = await supabase
      .from('jobs').insert(jobData).select().single();
    if (error) {
      console.error('[Webhook] DB insert error:', error);
      return res.status(500).json({ error: 'Failed to create job' });
    }
    console.log(`[Webhook] Job created: ${job.id}`);
    res.json({ success: true, job_id: job.id });
    processNewJob(job).catch(err => {
      console.error(`[Orchestrator] Error processing job ${job.id}:`, err);
    });
  } catch (err) {
    console.error('[Webhook] Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
