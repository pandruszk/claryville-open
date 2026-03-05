const Anthropic = require('@anthropic-ai/sdk').default;
const fs = require('fs');
const path = require('path');

/**
 * Extract scores from a scorecard photo using Claude Vision.
 * @param {string} filePath — absolute path to the image file
 * @returns {{ holes: number[], confidence: string, notes: string }}
 */
async function extractScores(filePath) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const imageData = fs.readFileSync(filePath);
  const base64 = imageData.toString('base64');
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
  const mediaType = mimeMap[ext] || 'image/jpeg';

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        },
        {
          type: 'text',
          text: `This is a golf scorecard photo from a 4-person best ball scramble tournament. Extract the team's best ball score for each of the 18 holes.

Return ONLY valid JSON in this exact format, no markdown:
{"holes":[h1,h2,h3,h4,h5,h6,h7,h8,h9,h10,h11,h12,h13,h14,h15,h16,h17,h18],"confidence":"high|medium|low","notes":"any issues"}

Rules:
- Each hole score should be between 1-15
- If you can't read a hole, use 0 and set confidence to "low"
- In "notes", mention any holes you're unsure about`
        }
      ]
    }]
  });

  const text = msg.content[0]?.text || '';
  // Extract JSON from response (handle if wrapped in markdown code block)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Could not parse OCR response');
  }

  const result = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(result.holes) || result.holes.length !== 18) {
    throw new Error('OCR returned invalid hole count');
  }

  return {
    holes: result.holes.map(h => Math.max(0, Math.min(15, parseInt(h) || 0))),
    confidence: result.confidence || 'medium',
    notes: result.notes || '',
  };
}

module.exports = { extractScores };
