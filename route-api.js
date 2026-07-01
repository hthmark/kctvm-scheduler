const express = require('express');
const router = express.Router();
const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ALLOWED_TABLES = new Set(['jobs', 'technicians', 'sms_conversations', 'prospects']);

router.get('/conversations/:phone', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data, error } = await supabase
      .from('sms_conversations')
      .select('role, content, created_at, phone')
      .eq('phone', decodeURIComponent(req.params.phone))
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.set('Cache-Control', 'no-store, no-cache');
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/dashboard/suggest-reply', async (req, res) => {
  try {
    const { job, messages } = req.body;
    if (!messages) return res.status(400).json({ error: 'messages required' });

    console.log('[SuggestReply] Route hit — job status:', job ? (job.status || 'unknown') : 'null (lead)', '| message count:', messages.length);

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { KNOWLEDGE_BASE } = require('./service-concierge');

    const jobScheduled = job && (job.scheduled_time || job.preferred_time)
      ? new Date(job.scheduled_time || job.preferred_time).toLocaleString('en-US', { timeZone: 'America/Chicago' })
      : 'not scheduled';

    const systemPrompt =
      'You are texting for Kansas City TV Mounting (KCTVM) on behalf of Gabe. Keep replies short — this is SMS, max 2-3 sentences. Sound like a real person, not a bot. Never say you are AI.\n\n' +
      KNOWLEDGE_BASE + '\n\n' +
      'CRITICAL SMS RULES:\n' +
      'Your response is sent DIRECTLY as an SMS. No asterisks, no bullet points, no brackets, no bold, no internal notes. Plain conversational text only. Never ask more than one question per message.\n\n' +
      '---\n' +
      'DASHBOARD MODE — You are generating a suggested reply for the business owner to review and send manually.\n\n' +
      'Current job context:\n' +
      '- Customer name: ' + (job ? (job.customer_name || 'Unknown') : 'Unknown') + '\n' +
      '- City: ' + (job ? (job.city || 'Unknown') : 'Unknown') + '\n' +
      '- Job status: ' + (job ? (job.status || 'pre-job lead') : 'pre-job lead') + '\n' +
      '- Number of TVs: ' + (job ? (job.num_tvs || 'unknown') : 'unknown') + '\n' +
      '- Total price: ' + (job && job.total_price ? '$' + job.total_price : 'not yet quoted') + '\n' +
      '- Scheduled time: ' + jobScheduled + '\n' +
      '- Assigned tech: ' + (job ? (job.confirmed_tech_name || 'none yet') : 'none yet') + '\n' +
      '- Payment status: ' + (job ? (job.paid_at ? 'PAID' : job.stripe_payment_link ? 'link sent, unpaid' : 'no link yet') : 'no link yet') + '\n' +
      '- Customer address: ' + (job ? (job.customer_address || 'not collected') : 'not collected') + '\n\n' +
      'Based on the conversation history and job context above, generate the single best next SMS reply exactly as the KCTVM concierge system would send it if automated flows were active. Follow all the same rules, tone, and logic. Return ONLY the message text — no labels, no quotes, no explanation.';

    const history = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: String(m.content) }));

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 300,
      system: systemPrompt,
      messages: history.length > 0 ? history : [{ role: 'user', content: 'Hello' }],
    });

    const content = response.content;
    console.log('[SuggestReply] Raw content blocks:', JSON.stringify(content));
    const textBlock = Array.isArray(content) ? content.find(function(b) { return b.type === 'text'; }) : null;
    const suggestion = textBlock ? textBlock.text.trim() : '';
    console.log('[SuggestReply] Text blocks found:', content && content.map(function(b) { return b.type; }));
    console.log('[SuggestReply] Generated suggestion:', suggestion || '(EMPTY — no text block found)');
    res.json({ suggestion });
  } catch (e) {
    console.error('[SuggestReply] Anthropic API error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/leads', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    const EXCLUDED_PHONES = new Set(['+18162032001']);

    const [{ data: jobRows }, { data: msgs }] = await Promise.all([
      supabase.from('jobs').select('customer_phone').not('customer_phone', 'is', null),
      supabase.from('sms_conversations').select('phone, content, created_at, role').order('created_at', { ascending: false }),
    ]);

    const jobPhoneSet = new Set((jobRows || []).map(r => r.customer_phone).filter(Boolean));

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const byPhone = {};
    for (const msg of (msgs || [])) {
      if (!msg.phone || jobPhoneSet.has(msg.phone) || EXCLUDED_PHONES.has(msg.phone)) continue;
      if (!byPhone[msg.phone]) {
        byPhone[msg.phone] = { phone: msg.phone, last_message_at: msg.created_at, last_message: msg.content, message_count: 0, dormant: msg.created_at < twoHoursAgo };
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

router.post('/system-status/toggle', async (req, res) => {
  try {
    const getUrl = `${SUPABASE_URL}/rest/v1/system_settings?key=eq.system_enabled&select=value`;
    const current = await axios.get(getUrl, { headers: sbHeaders });
    const currentEnabled = current.data?.[0]?.value !== 'false';
    const newEnabled = !currentEnabled;
    const patchUrl = `${SUPABASE_URL}/rest/v1/system_settings?key=eq.system_enabled`;
    await axios.patch(patchUrl, { value: newEnabled ? 'true' : 'false' }, { headers: sbHeaders });
    res.json({ ok: true, enabled: newEnabled });
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
