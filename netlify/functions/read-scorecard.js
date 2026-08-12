const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1';

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed.' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return reply(500, { error: 'OPENAI_API_KEY is not configured in Netlify.' });

  try {
    const body = JSON.parse(event.body || '{}');
    const imageDataUrl = body.imageDataUrl;

    if (!imageDataUrl || !/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(imageDataUrl)) {
      return reply(400, { error: 'A scorecard image is required.' });
    }

    // v5.3 deliberately sends the ORIGINAL uploaded image directly to the model.
    // No resize, crop, warp, OCR, or local image preprocessing.
    const pass1Prompt = `
Read this exact uploaded Colonial Golf Club scorecard photograph directly.

Important:
- Use ONLY what is visible in THIS photo.
- Do not assume any player's name or score from prior images.
- Do not use printed numbers as player scores.
- The handwritten player block is the only source of player scores.
- Ignore printed PAR, HANDICAP, tee yardages, printed hole numbers, OUT, IN, TOT, HCP, NET.
- Ignore handwritten OUT, IN, and TOTAL as hole values; read them separately as cross-checks.
- A circled birdie means read the digit inside the circle.
- Scores are normally 1-7. If a handwritten digit is not clear enough, return null instead of guessing.
- Return players in top-to-bottom order.

For every handwritten player:
1) read the handwritten name;
2) read exactly 18 handwritten hole scores, holes 1-9 then holes 10-18;
3) separately read handwritten OUT, IN, and TOTAL if visible;
4) list uncertain hole numbers in uncertainHoles.

Return JSON only:
{
  "players": [
    {
      "name": "string",
      "scores": [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null],
      "handwrittenOut": null,
      "handwrittenIn": null,
      "handwrittenTotal": null,
      "uncertainHoles": []
    }
  ]
}

Requirements:
- scores must contain exactly 18 entries per player.
- uncertainHoles is 1-based.
- A score of 1 is allowed, but always mark it uncertain.
- Never invent placeholder players.
`;

    const pass1Text = extractOutputText(await callVision(apiKey, pass1Prompt, imageDataUrl, 1800));
    const pass1 = parseJson(pass1Text);

    const pass2Prompt = `
You are independently verifying a transcription of the SAME original scorecard photograph.

Candidate transcription:
${JSON.stringify(pass1)}

Re-read the ORIGINAL photograph yourself. Do not merely repeat the candidate.

Verification rules:
- Only handwritten player names and handwritten player score rows count.
- Ignore printed PAR, HANDICAP, tee yardages, printed hole numbers, OUT, IN, TOT, HCP, NET.
- Handwritten OUT / IN / TOTAL are cross-checks only.
- Re-check every player name and every one of the 18 handwritten hole scores.
- If a candidate value does not visually match the handwriting, correct it.
- If a handwritten digit is not clear enough, return null and mark that hole uncertain.
- Do not "smooth" values toward likely golf scores and do not fill uncertain cells with 4s.
- Circled birdies: read the digit inside the circle.
- Scores are normally 1-7. A 1 must be uncertain.
- Use handwritten OUT / IN / TOTAL to challenge the candidate arithmetic, but never force a digit just to make totals match.
- Return players top-to-bottom as seen in this exact image.

Return FINAL corrected JSON only:
{
  "players": [
    {
      "name": "string",
      "scores": [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null],
      "handwrittenOut": null,
      "handwrittenIn": null,
      "handwrittenTotal": null,
      "uncertainHoles": []
    }
  ]
}
`;

    const pass2Text = extractOutputText(await callVision(apiKey, pass2Prompt, imageDataUrl, 2000));
    const pass2 = parseJson(pass2Text);

    const players = normalizeAndValidate(pass2?.players);

    return reply(200, {
      players,
      debug: {
        firstPass: pass1Text,
        verificationPass: pass2Text,
        arithmetic: players.map(p => ({
          name: p.name,
          computedOut: sumNine(p.scores, 0),
          handwrittenOut: p.handwrittenOut,
          computedIn: sumNine(p.scores, 9),
          handwrittenIn: p.handwrittenIn,
          computedTotal: sumAll(p.scores),
          handwrittenTotal: p.handwrittenTotal
        }))
      },
      ocrMode: 'original-photo-two-pass-v5.3'
    });

  } catch (error) {
    console.error('v5.3 original-photo read failure:', error);
    return reply(500, {
      error: error?.message || 'Original-photo reading failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'original-photo-two-pass-v5.3'
    });
  }
};

function normalizeAndValidate(src) {
  if (!Array.isArray(src)) return [];

  return src.filter(Boolean).map(item => {
    const scores = Array.from({ length: 18 }, (_, i) => {
      const v = item?.scores?.[i];
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 7 ? n : null;
    });

    const uncertain = new Set(
      Array.isArray(item?.uncertainHoles)
        ? item.uncertainHoles.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 18)
        : []
    );

    scores.forEach((v, i) => {
      if (v == null || v === 1) uncertain.add(i + 1);
    });

    const handwrittenOut = validTotal(item?.handwrittenOut);
    const handwrittenIn = validTotal(item?.handwrittenIn);
    const handwrittenTotal = validTotal(item?.handwrittenTotal);

    const out = sumNine(scores, 0);
    const inn = sumNine(scores, 9);
    const total = sumAll(scores);

    // Arithmetic mismatch is a warning only; it does not rewrite scores.
    if (handwrittenOut != null && out != null && handwrittenOut !== out) {
      for (let h = 1; h <= 9; h++) uncertain.add(h);
    }
    if (handwrittenIn != null && inn != null && handwrittenIn !== inn) {
      for (let h = 10; h <= 18; h++) uncertain.add(h);
    }
    if (handwrittenTotal != null && total != null && handwrittenTotal !== total) {
      for (let h = 1; h <= 18; h++) uncertain.add(h);
    }

    return {
      name: String(item?.name || '').trim(),
      scores,
      handwrittenOut,
      handwrittenIn,
      handwrittenTotal,
      uncertainHoles: [...uncertain].sort((a, b) => a - b)
    };
  }).filter(p => p.name);
}

function validTotal(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 9 && n <= 150 ? n : null;
}

function sumNine(scores, start) {
  const a = scores.slice(start, start + 9);
  return a.some(v => v == null) ? null : a.reduce((x, y) => x + y, 0);
}

function sumAll(scores) {
  return scores.some(v => v == null) ? null : scores.reduce((x, y) => x + y, 0);
}

async function callVision(apiKey, prompt, imageDataUrl, max_output_tokens) {
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
        ]
      }],
      max_output_tokens
    })
  });

  const raw = await r.json();
  if (!r.ok) throw new Error(raw?.error?.message || `OpenAI request failed (${r.status}).`);
  return raw;
}

function extractOutputText(r) {
  if (typeof r.output_text === 'string') return r.output_text;
  const parts = [];
  for (const item of r.output || []) {
    for (const c of item.content || []) {
      if (c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
}

function parseJson(text) {
  const c = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

  try {
    return JSON.parse(c);
  } catch (_) {
    const a = c.indexOf('{');
    const b = c.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(c.slice(a, b + 1));
    throw new Error('The original-photo reader returned an unreadable response.');
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
