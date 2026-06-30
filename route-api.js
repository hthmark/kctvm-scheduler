const express = require('express');
const router = express.Router();
const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ALLOWED_TABLES = new Set(['jobs', 'technicians', 'sms_conversations', 'prospects']);

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
