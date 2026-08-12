const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1';

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return reply(405, { error: 'Method not allowed.' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return reply(500, { error: 'OPENAI_API_KEY is not configured in Netlify.' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { imageDataUrl } = body;

    if (!imageDataUrl || !/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(imageDataUrl)) {
      return reply(400, { error: 'A scorecard image is required.' });
    }

    const prompt = `
You are reading a photographed Colonial Golf Club scorecard.

Read the WHOLE CARD visually. Do not crop mentally to printed rows.

Your job:
1) Identify every handwritten player name in the main player-score area.
2) For each handwritten player, read exactly 18 handwritten hole scores in left-to-right order:
   holes 1-9, then holes 10-18.
3) Ignore all printed information:
   - printed PAR
   - printed HANDICAP
   - printed yardages
   - printed tee rows
   - printed hole numbers
   - printed OUT / IN / TOT / HCP / NET labels
4) Ignore handwritten OUT, IN, and total sums; return only the 18 individual hole scores.
5) If a score is circled for a birdie, ignore the circle and read the digit inside it.
6) Do not reuse names or scores from previous images. Use THIS image only.
7) If a hole is unclear, return null and mark that hole uncertain instead of guessing.
8) Normal score digits are 1-7. A 1 is allowed but should always be marked uncertain=true for confirmation.
9) Return players in top-to-bottom order as they appear on the card.

Return JSON only in this exact structure:
{
  "players": [
    {
      "name": "string",
      "scores": [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null],
      "uncertainHoles": [1]
    }
  ]
}

Important:
- scores must contain exactly 18 entries per player.
- uncertainHoles uses 1-based hole numbers.
- Do not invent placeholder players.
`;

    const raw = await callVision(apiKey, [
      { type: 'input_text', text: prompt },
      { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
    ], 1200);

    const text = extractOutputText(raw);
    const parsed = parseJson(text);

    const players = normalizePlayers(parsed?.players);

    return reply(200, {
      players,
      debug: {
        rawWholeCardResponse: text
      },
      ocrMode: 'whole-card-vision-v5.0'
    });
  } catch (error) {
    console.error('v5.0 whole-card vision failure:', error);
    return reply(500, {
      error: error?.message || 'Whole-card vision failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'whole-card-vision-v5.0'
    });
  }
};

function normalizePlayers(source) {
  if (!Array.isArray(source)) return [];

  const players = [];

  for (const item of source) {
    if (!item || typeof item !== 'object') continue;

    const name = String(item.name || '').trim();
    if (!name) continue;

    const rawScores = Array.isArray(item.scores) ? item.scores : [];
    const scores = Array.from({ length: 18 }, (_, i) => {
      const n = Number(rawScores[i]);
      return Number.isInteger(n) && n >= 1 && n <= 7 ? n : null;
    });

    const suppliedUncertain = Array.isArray(item.uncertainHoles)
      ? item.uncertainHoles.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 18)
      : [];

    const uncertain = new Set(suppliedUncertain);

    for (let i = 0; i < 18; i++) {
      if (scores[i] == null || scores[i] === 1) uncertain.add(i + 1);
    }

    players.push({
      name,
      scores,
      uncertainHoles: [...uncertain].sort((a, b) => a - b)
    });
  }

  return players;
}

async function callVision(apiKey, content, maxOutputTokens) {
  const apiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      input: [{ role: 'user', content }],
      max_output_tokens: maxOutputTokens
    })
  });

  const raw = await apiResponse.json();

  if (!apiResponse.ok) {
    const message = raw?.error?.message || `OpenAI request failed (${apiResponse.status}).`;
    throw new Error(message);
  }

  return raw;
}

function extractOutputText(response) {
  if (typeof response.output_text === 'string') return response.output_text;

  const parts = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }
  return parts.join('\n').trim();
}

function parseJson(text) {
  const cleaned = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error('The whole-card reader returned an unreadable response.');
  }
}

function reply(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}
