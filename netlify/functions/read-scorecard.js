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

    // PASS 1: full-photo transcription.
    const pass1Prompt = `
Read this exact uploaded Colonial Golf Club scorecard photograph directly.

Use only THIS image. Identify every handwritten player row and read exactly 18 handwritten hole scores per player.

Rules:
- Ignore ALL printed numbers and printed labels: PAR, HANDICAP, tee yardages, hole numbers, OUT, IN, TOT, HCP, NET.
- Only handwritten player names and handwritten player score rows count.
- Read holes 1-9, skip handwritten OUT subtotal, then holes 10-18.
- Read handwritten OUT / IN / TOTAL separately as cross-checks.
- Circled birdie: read the digit inside the circle.
- Scores are normally 1-7.
- If a handwritten digit is unclear, return null instead of guessing.
- A score of 1 is allowed, but must be uncertain.
- Return players top-to-bottom.

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
`;

    const pass1Text = extractOutputText(await callVision(apiKey, pass1Prompt, imageDataUrl, 1800));
    const pass1 = parseJson(pass1Text);

    // PASS 2: independent full-photo verification.
    const pass2Prompt = `
Independently re-read the SAME original Colonial Golf Club scorecard photograph.

Candidate first reading:
${JSON.stringify(pass1)}

Do not simply repeat the candidate. Re-check every handwritten player name and every handwritten hole score.

Rules:
- Ignore ALL printed PAR, HANDICAP, yardages, tee rows, hole numbers, OUT/IN/TOT/HCP/NET.
- Only handwritten player rows count.
- Handwritten OUT / IN / TOTAL are cross-checks only.
- If a candidate value does not visually match, correct it.
- If still unclear, return null and mark that hole uncertain.
- Do not "smooth" values toward typical golf scores.
- Do not fill uncertain cells with 4s.
- Circled birdie: read the digit inside the circle.
- Scores normally 1-7; a 1 must be uncertain.
- Return players top-to-bottom.

Return FINAL JSON only:
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

    // PASS 3: hole-by-hole adjudication. This is the key v5.4 change.
    // It sees both prior reads and must explicitly adjudicate every individual hole.
    const adjudicationPrompt = `
You are the FINAL adjudicator for the SAME original Colonial Golf Club scorecard photograph.

First reading:
${JSON.stringify(pass1)}

Second reading:
${JSON.stringify(pass2)}

Your task is NOT to create another general transcription.
Instead, adjudicate EVERY PLAYER and EVERY HOLE 1-18 one by one from the original photograph.

For each hole:
- Compare the first and second readings.
- Look directly at the corresponding handwritten box in the original photo.
- Return the digit only if the handwriting supports it.
- If the two readings disagree, carefully inspect that exact hole.
- If the digit is still ambiguous, return null and mark that hole uncertain.
- NEVER choose a value merely because it makes the total work.
- NEVER substitute the printed PAR or HANDICAP.
- NEVER default to 4.
- Circled birdie: ignore circle, read the digit inside.

Use handwritten OUT / IN / TOTAL only as secondary arithmetic evidence:
- They can alert you that one or more hole values may be wrong.
- They must NEVER force an unclear hole to a specific digit.
- If arithmetic still disagrees after visual inspection, leave the questionable hole(s) uncertain.

Return only the final adjudicated JSON:
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
- Exactly 18 score entries per player.
- Scores normally 1-7.
- Any null must be uncertain.
- Any 1 must be uncertain.
- Return players top-to-bottom as actually seen.
`;

    const adjudicationText = extractOutputText(await callVision(
      apiKey,
      adjudicationPrompt,
      imageDataUrl,
      2200
    ));

    const adjudicated = parseJson(adjudicationText);
    const players = normalizeAndValidate(adjudicated?.players);

    return reply(200, {
      players,
      debug: {
        firstPass: pass1Text,
        verificationPass: pass2Text,
        adjudicationPass: adjudicationText,
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
      ocrMode: 'original-photo-adjudicated-v5.4'
    });

  } catch (error) {
    console.error('v5.4 adjudication failure:', error);
    return reply(500, {
      error: error?.message || 'Original-photo adjudication failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'original-photo-adjudicated-v5.4'
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

    // Arithmetic mismatches mark the relevant section uncertain, but NEVER rewrite scores.
    const out = sumNine(scores, 0);
    const inn = sumNine(scores, 9);
    const total = sumAll(scores);

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
    throw new Error('The adjudication reader returned an unreadable response.');
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
