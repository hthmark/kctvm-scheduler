const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { handleJobCompletion, cancelJob } = require('./service-orchestrator');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

router.get('/', async (req, res) => {
  const { status, limit = 50 } = req.query;
  let query = supabase.from('jobs').select('*').order('created_at', { ascending: false }).limit(parseInt(limit));
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.get('/stats/summary', async (req, res) => {
  const { data: jobs, error } = await supabase.from('jobs').select('status, total_price, created_at');
  if (error) return res.status(500).json({ error: error.message });
  const j = jobs || [];
  const today = new Date().toISOString().split('T')[0];
  const summary = {
    total: j.length,
    today: j.filter(x => x.created_at.startsWith(today)).length,
    awaiting_tech: j.filter(x => x.status === 'awaiting_tech_reply').length,
    awaiting_payment: j.filter(x => x.status === 'awaiting_payment').length,
    confirmed: j.filter(x => x.status === 'confirmed').length,
    completed: j.filter(x => x.status === 'completed').length,
    cancelled: j.filter(x => x.status === 'cancelled').length,
    revenue_total: j.filter(x => x.status === 'completed').reduce((sum, x) => sum + (x.total_price || 0), 0),
  };
  res.json(summary);
});

router.get('/techs/list', async (req, res) => {
  const { data, error } = await supabase.from('technicians').select('*').order('priority', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/techs/add', async (req, res) => {
  const { name, phone, priority } = req.body;
  const { data, error } = await supabase.from('technicians')
    .insert({ name, phone, priority: priority || 99, active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/techs/:id', async (req, res) => {
  const { data, error } = await supabase.from('technicians')
    .update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/:id', async (req, res) => {
  const { data: job, error } = await supabase.from('jobs')
    .select('*, tech_contacts(*)').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

router.post('/:id/complete', async (req, res) => {
  try {
    await handleJobCompletion(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    await cancelJob(req.params.id, req.body.reason || 'manual_cancel');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
