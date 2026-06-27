const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { handleJobCompletion, cancelJob, handlePaymentComplete } = require('./service-orchestrator');

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
  res.json(data);
});

router.get('/stats/summary', async (req, res) => {
  const { data: jobs } = await supabase.from('jobs').select('status, total_price, created_at');
  const today = new Date().toISOString().split('T')[0];
  const summary = {
    total: jobs.length,
    today: jobs.filter(j => j.created_at.startsWith(today)).length,
    awaiting_tech: jobs.filter(j => j.status === 'awaiting_tech_reply').length,
    awaiting_payment: jobs.filter(j => j.status === 'awaiting_payment').length,
    confirmed: jobs.filter(j => j.status === 'confirmed').length,
    completed: jobs.filter(j => j.status === 'completed').length,
    cancelled: jobs.filter(j => j.status === 'cancelled').length,
    revenue_total: jobs.filter(j => j.status === 'completed').reduce((sum, j) => sum + (j.total_price || 0), 0),
  };
  res.json(summary);
});

router.get('/techs/list', async (req, res) => {
  const { data, error } = await supabase.from('technicians').select('*').order('priority', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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

router.post('/:id/resend-tech-sms', async (req, res) => {
  try {
    const { data: job, error } = await supabase.from('jobs').select('*').eq('id', req.params.id).single();
    if (error || !job) return res.status(404).json({ error: 'Job not found' });
    const { buildSupplyList, calculateBasePayout } = require('./service-orchestrator');
    const { sendSMS } = require('./service-sms');
    const { data: tech } = await supabase.from('technicians').select('*').eq('id', job.confirmed_tech_id).single();
    if (!tech) return res.status(400).json({ error: 'No confirmed tech on job' });
    const WIRE_CONCEAL_LINKS = [
      { label: 'Brush Plate (1 per TV)', url: 'https://www.homedepot.com/p/Commercial-Electric-1-Gang-Brush-Plastic-Wall-Plate-White-5038-WH/207161871' },
      { label: 'Single Gang Box (1 per TV)', url: 'https://www.homedepot.com/p/Carlon-1-Gang-Non-Metallic-Low-Voltage-Old-Work-Bracket-SC100RR-SC100RR/100160916' }
    ];
    const { mountItems, wireItems, brickTVs } = buildSupplyList(job);
    const tvLines = [];
    for (let i = 1; i <= 10; i++) {
      const size = job[`tv_${i}_size`];
      if (!size || size === 'null') continue;
      const inches = job[`tv_${i}_inches`];
      const sizeLabel = inches ? `${inches}"` : (size === 'small' ? 'under 65"' : '65"+');
      const mount = job[`tv_${i}_mount`];
      const mountLabel = mount === 'yes' ? 'has mount' : mount === 'fixed' ? 'fixed mount needed' : mount === 'articulating' ? 'articulating mount needed' : mount;
      const wallLabel = job[`tv_${i}_wall`] === 'brick' ? 'BRICK WALL' : 'drywall';
      const wireLabel = job[`tv_${i}_wire`] === 'cable' ? 'wire concealment' : 'no wire concealment';
      tvLines.push(`TV${i}: ${sizeLabel}, ${mountLabel}, ${wallLabel}, ${wireLabel}`);
    }
    let supplySection = '';
    if (mountItems.length > 0) {
      supplySection += `\n\n🛒 MOUNTS — pick up from Walmart:`;
      mountItems.forEach(m => { supplySection += `\nTV${m.tvNum} (${m.inches || m.size}") — ${m.label}: ${m.url}`; });
    }
    if (wireItems.length > 0) {
      supplySection += `\n\n🛒 WIRE CONCEAL SUPPLIES (${wireItems.length}x each) — Home Depot:`;
      WIRE_CONCEAL_LINKS.forEach(item => { supplySection += `\n${item.label}: ${item.url}`; });
    }
    if (brickTVs.length > 0) {
      const brickNums = brickTVs.map(t => `TV${t.tvNum}`).join(', ');
      supplySection += `\n\n🧱 BRICK — ${brickNums}: Bring masonry drill bits + anchors!`;
    }
    const basePayout = job.base_payout || calculateBasePayout(job);
    const part1 = `Job confirmed & paid!\n${job.customer_name} — ${job.customer_address}\nTime: ${job.preferred_time}\n\n${tvLines.join('\n')}\n\nBase payout: $${basePayout}`;
    const part2 = (supplySection.trim() ? supplySection.trim() + '\n\n' : '') + `Send photos + receipts via MMS and reply "Done" when finished. Thanks ${tech.name.split(' ')[0]}!`;
    console.log(`[Jobs] resend-tech-sms part1 (${part1.length} chars): ${part1}`);
    console.log(`[Jobs] resend-tech-sms part2 (${part2.length} chars): ${part2}`);
    await sendSMS(tech.phone, part1);
    await sendSMS(tech.phone, part2);
    res.json({ success: true, part1_length: part1.length, part2_length: part2.length });
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
