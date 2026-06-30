const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function isSystemEnabled() {
  try {
    const { data } = await supabase
      .from('system_settings').select('value').eq('key', 'system_enabled').single();
    return data?.value !== 'false';
  } catch {
    return true; // fail open — don't block traffic on DB errors
  }
}

module.exports = { isSystemEnabled };
