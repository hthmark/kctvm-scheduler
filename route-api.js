const express = require('express');
const router = express.Router();
const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ALLOWED_TABLES = new Set(['jobs', 'technicians', 'sms_conversations', 'prospects']);

router.post('/dashboard/suggest-reply', async (req, res) => {
  try {
    const { job, messages } = req.body;
    if (!messages) return res.status(400).json({ error: 'messages required' });

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let systemPrompt;
    if (job) {
      const tvDetails = [];
      for (let i = 1; i <= 10; i++) {
        const size = job[`tv_${i}_size`];
        if (!size || size === 'null' || size === 'undefined') continue;
        const inches = job[`tv_${i}_inches`];
        const mount = job[`tv_${i}_mount`];
        const wall = job[`tv_${i}_wall`];
        const wire = job[`tv_${i}_wire`];
        tvDetails.push(`TV${i}: ${inches ? inches + '"' : size}, mount=${mount || '?'}, wall=${wall || 'drywall'}, wire=${wire === 'cable' ? 'concealment' : 'none'}`);
      }
      systemPrompt = `You are the Hopscotch concierge — the friendly, professional SMS operator for Kansas City TV Mounting (KCTVM). You help customers schedule TV wall mounting appointments and answer their questions.

Current job context:
- Customer: ${job.customer_name || 'Unknown'}
- City: ${job.customer_city || 'N/A'}
- Status: ${job.status || 'N/A'}
- Scheduled time: ${job.preferred_time || 'Not yet scheduled'}
- Assigned tech: ${job.confirmed_tech_name || job.current_tech_name || 'Not yet assigned'}
- Total price: ${job.total_price ? '$' + job.total_price : 'Not set'}
- Number of TVs: ${job.num_tvs || 1}
${tvDetails.length > 0 ? '- TV details:\n  ' + tvDetails.join('\n  ') : ''}

Suggest a short, friendly, professional SMS reply to continue this conversation naturally. Keep it under 160 characters if possible. Reply ONLY with the suggested message text — no explanation, no quotes, no prefixes.`;
    } else {
      systemPrompt = `You are the Hopscotch concierge — the friendly, professional SMS operator for Kansas City TV Mounting (KCTVM). You help customers schedule TV wall mounting appointments and answer their questions.

This is a new inbound lead — no job has been created yet. The customer has just texted in. Suggest a short, friendly, professional SMS reply to continue the conversation and move them toward booking. Keep it under 160 characters if possible. Reply ONLY with the suggested message text — no explanation, no quotes, no prefixes.`;
    }

    const history = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: String(m.content) }));

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 300,
      system: systemPrompt,
      messages: history.length > 0 ? history : [{ role: 'user', content: 'Hello' }],
    });

    res.json({ suggestion: response.content[0]?.text || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/leads', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    const [{ data: jobRows }, { data: msgs }] = await Promise.all([
      supabase.from('jobs').select('customer_phone').not('customer_phone', 'is', null),
      supabase.from('sms_conversations').select('phone, content, created_at, role').order('created_at', { ascending: false }),
    ]);

    const jobPhoneSet = new Set((jobRows || []).map(r => r.customer_phone).filter(Boolean));

    const byPhone = {};
    for (const msg of (msgs || [])) {
      if (!msg.phone || jobPhoneSet.has(msg.phone)) continue;
      if (!byPhone[msg.phone]) {
        byPhone[msg.phone] = { phone: msg.phone, last_message_at: msg.created_at, last_message: msg.content, message_count: 0 };
      }
      byPhone[msg.phone].message_count++;
    }

    const leads = Object.values(byPhone).sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
    res.json(leads);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const sbHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

router.get('/system-status', async (req, res) => {
  try {
    const url = `${SUPABASE_URL}/rest/v1/system_settings?key=eq.system_enabled&select=value`;
    const resp = await axios.get(url, { headers: sbHeaders });
    const row = resp.data?.[0];
    res.json({ enabled: row?.value !== 'false' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/system-status', async (req, res) => {
  try {
    const { enabled } = req.body;
    const url = `${SUPABASE_URL}/rest/v1/system_settings?key=eq.system_enabled`;
    await axios.patch(url, { value: enabled ? 'true' : 'false' }, { headers: sbHeaders });
    res.json({ ok: true, enabled: !!enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.use('/:table', (req, res, next) => {
  if (!ALLOWED_TABLES.has(req.params.table)) return res.status(403).json({ error: 'Forbidden' });
  next();
});

router.get('/:table', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const url = `${SUPABASE_URL}/rest/v1/${req.params.table}${qs ? '?' + qs : ''}`;
    const resp = await axios.get(url, { headers: sbHeaders });
    res.json(resp.data);
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { error: e.message });
  }
});

router.patch('/:table/:id', async (req, res) => {
  try {
    const url = `${SUPABASE_URL}/rest/v1/${req.params.table}?id=eq.${req.params.id}`;
    const resp = await axios.patch(url, req.body, { headers: sbHeaders });
    res.json(resp.data);
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { error: e.message });
  }
});

router.post('/:table', async (req, res) => {
  try {
    const url = `${SUPABASE_URL}/rest/v1/${req.params.table}`;
    const resp = await axios.post(url, req.body, { headers: sbHeaders });
    res.json(resp.data);
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { error: e.message });
  }
});

router.delete('/:table/:id', async (req, res) => {
  try {
    const url = `${SUPABASE_URL}/rest/v1/${req.params.table}?id=eq.${req.params.id}`;
    await axios.delete(url, { headers: sbHeaders });
    res.status(204).send();
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { error: e.message });
  }
});

module.exports = router;
