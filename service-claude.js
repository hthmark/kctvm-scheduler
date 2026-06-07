const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function calculatePayout(job) {
  let payout = 0;
  let tvCount = 0;
  for (let i = 1; i <= 10; i++) {
    const size = job[`tv_${i}_size`];
    if (!size || size === 'null' || size === 'undefined') continue;
    tvCount++;
    payout += tvCount === 1 ? 60 : 40;
    if (job[`tv_${i}_wire`] === 'cable') payout += 40;
  }
  return payout;
}

function buildSupplyNotes(job) {
  const notes = [];
  for (let i = 1; i <= 10; i++) {
    const size = job[`tv_${i}_size`];
    if (!size || size === 'null' || size === 'undefined') continue;
    const mount = job[`tv_${i}_mount`];
    const wall = job[`tv_${i}_wall`];
    const wire = job[`tv_${i}_wire`];
    if (mount === 'fixed') notes.push(`Pick up fixed mount from Walmart for TV ${i}`);
    if (mount === 'articulating') notes.push(`Pick up articulating mount from Walmart for TV ${i}`);
    if (wire === 'cable') notes.push(`Pick up wire concealment supplies for TV ${i}`);
    if (wall === 'brick') notes.push(`TV ${i} is going into BRICK — bring masonry bits`);
  }
  return notes;
}

async function generateTechMessage(job, tech) {
  const payout = calculatePayout(job);
  const supplyNotes = buildSupplyNotes(job);
  const tvLines = [];
  for (let i = 1; i <= 10; i++) {
    const size = job[`tv_${i}_size`];
    if (!size || size === 'null' || size === 'undefined') continue;
    tvLines.push(`TV ${i}: size=${size}, mount=${job[`tv_${i}_mount`]}, wall=${job[`tv_${i}_wall`]}, wire=${job[`tv_${i}_wire`]}`);
  }
  const prompt = `Write a job notification text for a TV mounting technician.
Tech name: ${tech.name} (first name only in message)
Customer first name: ${job.customer_name.split(' ')[0]}
City: ${job.city}
Preferred time: ${job.preferred_time}
Number of TVs: ${job.num_tvs}
${tvLines.join('\n')}
Payout: $${payout}
Supply notes: ${supplyNotes.length > 0 ? supplyNotes.join(', ') : 'None'}
Format EXACTLY: "Hey [tech first name], have a job in [city] at [time] if you're interested. It's [concise TV description]. [Supply note if needed.] Payout would be $[amount]. Please reply "Yes" if you're available or "No" if you're not"
Keep under 300 characters. Be concise.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  return message.content[0].text.trim();
}

module.exports = { generateTechMessage, calculatePayout };
