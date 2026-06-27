const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function formatJobTime(t) {
  if (!t) return t;
  const d = new Date(t);
  if (isNaN(d.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(t)) return t;
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function calculatePayout(job) {
  let payout = 0, tvCount = 0;
  for (let i = 1; i <= 10; i++) {
    const size = job[`tv_${i}_size`];
    if (!size || size === 'null' || size === 'undefined') continue;
    tvCount++;
    payout += tvCount === 1 ? 60 : 40;
    if (job[`tv_${i}_wire`] === 'cable') payout += 40;
  }
  return payout;
}

function buildJobNotes(job) {
  const notes = [];
  let mountCount = { fixed: 0, articulating: 0 };
  let wireCount = 0, brickCount = 0;
  for (let i = 1; i <= 10; i++) {
    const size = job[`tv_${i}_size`];
    if (!size || size === 'null' || size === 'undefined') continue;
    const mount = job[`tv_${i}_mount`];
    const wall  = job[`tv_${i}_wall`];
    const wire  = job[`tv_${i}_wire`];
    if (mount === 'fixed') mountCount.fixed++;
    if (mount === 'articulating') mountCount.articulating++;
    if (wire === 'cable') wireCount++;
    if (wall === 'brick') brickCount++;
  }
  if (mountCount.fixed > 0) notes.push(`Need to pick up ${mountCount.fixed} fixed mount${mountCount.fixed > 1 ? 's' : ''} from Walmart`);
  if (mountCount.articulating > 0) notes.push(`Need to pick up ${mountCount.articulating} articulating mount${mountCount.articulating > 1 ? 's' : ''} from Walmart`);
  if (wireCount > 0) notes.push(`Need wire concealment supplies from Home Depot for ${wireCount} TV${wireCount > 1 ? 's' : ''}`);
  if (brickCount > 0) notes.push(`${brickCount} TV${brickCount > 1 ? 's are' : ' is'} going into brick — bring masonry bits`);
  return notes;
}

async function generateTechMessage(job, tech) {
  const payout = calculatePayout(job);
  const notes = buildJobNotes(job);
  const tvLines = [];
  for (let i = 1; i <= 10; i++) {
    const size = job[`tv_${i}_size`];
    if (!size || size === 'null' || size === 'undefined') continue;
    const inches = job[`tv_${i}_inches`];
    const sizeLabel = inches ? `${inches}"` : (size === 'small' ? 'small TV' : 'large TV');
    const mount = job[`tv_${i}_mount`];
    const mountLabel = mount === 'yes' ? 'has own mount' : mount === 'fixed' ? 'needs fixed mount' : mount === 'articulating' ? 'needs articulating mount' : '';
    const wallLabel = job[`tv_${i}_wall`] === 'brick' ? 'brick wall' : 'drywall';
    const wireLabel = job[`tv_${i}_wire`] === 'cable' ? 'wire concealment' : 'no wire concealment';
    tvLines.push(`TV${i}: ${sizeLabel}, ${mountLabel}, ${wallLabel}, ${wireLabel}`);
  }

  const prompt = `Write a job notification text for a TV mounting technician.
Tech name: ${tech.name} (use first name only)
Customer first name: ${job.customer_name.split(' ')[0]}
City: ${job.city}
Time: ${formatJobTime(job.preferred_time)}
Number of TVs: ${job.num_tvs}
TV details:
${tvLines.join('\n')}
Payout: $${payout}
Supply notes (mention naturally if any):
${notes.length > 0 ? notes.join('\n') : 'None'}
Format EXACTLY:
"Hey [first name], have a job in [city] at [time] if you're interested. It's [natural concise description]. [If supplies needed: one sentence about picking up from Walmart/Home Depot]. Payout would be $[amount]. Please reply "Yes" if you're available or "No" if you're not"
Keep under 320 characters. Be concise and natural.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 320,
    messages: [{ role: 'user', content: prompt }],
  });
  return message.content[0].text.trim();
}

// ─── ANALYZE JOB PHOTOS ───────────────────────────────────────────────────────
async function analyzeJobPhotos(mediaUrls, numTvs) {
  console.log(`[Claude] Analyzing ${mediaUrls.length} photos for ${numTvs} TVs`);

  // Download all images as base64
  const imageDataList = [];
  for (const url of mediaUrls) {
    try {
      const response = await axios.get(url, { responseType: 'arraybuffer' });
      const base64 = Buffer.from(response.data).toString('base64');
      const contentType = response.headers['content-type'] || 'image/jpeg';
      imageDataList.push({ url, base64, contentType });
    } catch (err) {
      console.error(`[Claude] Failed to download photo ${url}:`, err.message);
    }
  }

  if (imageDataList.length === 0) {
    return { tvPhotos: [], receiptPhotos: [], receiptTotal: 0 };
  }

  // Build message content with all images
  const imageContent = imageDataList.map(img => ({
    type: 'image',
    source: { type: 'base64', media_type: img.contentType, data: img.base64 }
  }));

  const prompt = `You are analyzing photos sent by a TV mounting technician after completing a job.
There are ${numTvs} TVs that were mounted.

For each photo, determine:
1. Is it a RECEIPT (paper receipt, store receipt, hardware store receipt)?
2. Is it a TV INSTALLATION photo (mounted TV on wall)?
3. If receipt — what is the total dollar amount shown?

Respond in JSON only, no other text:
{
  "photos": [
    {
      "index": 0,
      "type": "tv_installation" | "receipt" | "other",
      "receipt_amount": 0.00
    }
  ],
  "total_receipt_amount": 0.00
}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        ...imageContent,
        { type: 'text', text: prompt }
      ]
    }]
  });

  let analysis;
  try {
    const text = response.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    analysis = JSON.parse(clean);
  } catch (err) {
    console.error('[Claude] Failed to parse photo analysis:', err.message);
    return { tvPhotos: mediaUrls, receiptPhotos: [], receiptTotal: 0 };
  }

  // Sort photos into TV photos and receipt photos
  const tvPhotos = [];
  const receiptPhotos = [];
  const receiptTotal = analysis.total_receipt_amount || 0;

  analysis.photos.forEach((p, i) => {
    if (i < imageDataList.length) {
      if (p.type === 'receipt') {
        receiptPhotos.push(imageDataList[i].url);
      } else if (p.type === 'tv_installation') {
        tvPhotos.push(imageDataList[i].url);
      }
    }
  });

  // Limit to one TV photo per TV
  const selectedTvPhotos = tvPhotos.slice(0, numTvs);

  console.log(`[Claude] Analysis: ${selectedTvPhotos.length} TV photos, ${receiptPhotos.length} receipts, $${receiptTotal} total receipts`);
  return { tvPhotos: selectedTvPhotos, receiptPhotos, receiptTotal };
}

module.exports = { generateTechMessage, calculatePayout, analyzeJobPhotos };
