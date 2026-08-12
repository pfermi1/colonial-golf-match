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

    const firstPrompt = `
Read this ONE Colonial Golf Club scorecard as a whole image.
Identify every HANDWRITTEN player row and read exactly 18 HANDWRITTEN hole scores per player.

Ignore ALL printed numbers/labels: PAR, HANDICAP, tee yardages, hole numbers, OUT, IN, TOT, HCP, NET.
Never use printed PAR/HANDICAP/yardage rows as player scores.
Read holes 1-9, skip handwritten OUT subtotal, then holes 10-18.
Circled birdie: read the digit inside the circle.
Scores are normally integers 1-7. If unclear, return null instead of guessing.
Also read handwritten OUT, IN, and TOTAL values separately when visible.
Return players top-to-bottom as seen.

Return JSON only:
{"players":[{"name":"string","scores":[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null],"handwrittenOut":null,"handwrittenIn":null,"handwrittenTotal":null,"uncertainHoles":[]}]}

scores must contain exactly 18 entries. uncertainHoles uses 1-based hole numbers. A score of 1 must be marked uncertain.
`;

    const firstText = extractOutputText(await callVision(apiKey, firstPrompt, imageDataUrl, 1600));
    const firstParsed = parseJson(firstText);

    const verifyPrompt = `
Re-read the SAME full Colonial Golf Club scorecard and VERIFY this candidate:
${JSON.stringify(firstParsed)}

Do not simply repeat it. Independently inspect every handwritten name and every handwritten hole score again.

Rules:
- Ignore ALL printed PAR, HANDICAP, yardage, tee, hole-number, OUT/IN/TOT/HCP/NET information.
- Only handwritten player rows count.
- Handwritten OUT / IN / TOTAL are cross-checks, not hole scores.
- Sum holes 1-9 and compare to handwrittenOut when visible.
- Sum holes 10-18 and compare to handwrittenIn when visible.
- Sum all 18 and compare to handwrittenTotal when visible.
- If a total disagrees, re-check the individual handwritten boxes and correct likely misreads.
- If still unclear, return null and mark the hole uncertain.
- Circled birdie: read the digit inside the circle.
- Scores normally 1-7. A 1 must be uncertain.
- Return players in actual top-to-bottom order.

Return FINAL corrected JSON only:
{"players":[{"name":"string","scores":[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null],"handwrittenOut":null,"handwrittenIn":null,"handwrittenTotal":null,"uncertainHoles":[]}]}
`;

    const verifyText = extractOutputText(await callVision(apiKey, verifyPrompt, imageDataUrl, 1800));
    const verifyParsed = parseJson(verifyText);
    const players = normalizePlayers(verifyParsed.players);

    return reply(200, {
      players,
      debug: {
        firstPass: firstText,
        verificationPass: verifyText,
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
      ocrMode: 'whole-card-verified-v5.1'
    });
  } catch (error) {
    return reply(500, { error: error.message || 'Whole-card verification failed.', ocrMode: 'whole-card-verified-v5.1' });
  }
};

function normalizePlayers(src) {
  if (!Array.isArray(src)) return [];
  return src.filter(Boolean).map(item => {
    const scores = Array.from({length:18}, (_,i) => {
      const v = item.scores?.[i];
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 7 ? n : null;
    });
    const handwrittenOut = validTotal(item.handwrittenOut);
    const handwrittenIn = validTotal(item.handwrittenIn);
    const handwrittenTotal = validTotal(item.handwrittenTotal);
    const uncertain = new Set(Array.isArray(item.uncertainHoles) ? item.uncertainHoles.map(Number).filter(n => n>=1 && n<=18) : []);
    scores.forEach((v,i) => { if (v == null || v === 1) uncertain.add(i+1); });

    const out = sumNine(scores,0), inn = sumNine(scores,9), tot = sumAll(scores);
    if (handwrittenOut != null && out != null && handwrittenOut !== out) for(let h=1;h<=9;h++) uncertain.add(h);
    if (handwrittenIn != null && inn != null && handwrittenIn !== inn) for(let h=10;h<=18;h++) uncertain.add(h);
    if (handwrittenTotal != null && tot != null && handwrittenTotal !== tot) for(let h=1;h<=18;h++) uncertain.add(h);

    return {
      name: String(item.name || '').trim(),
      scores,
      handwrittenOut,
      handwrittenIn,
      handwrittenTotal,
      uncertainHoles: [...uncertain].sort((a,b)=>a-b)
    };
  }).filter(p => p.name);
}

function validTotal(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 9 && n <= 150 ? n : null;
}
function sumNine(scores,start) {
  const a=scores.slice(start,start+9);
  return a.some(v=>v==null) ? null : a.reduce((x,y)=>x+y,0);
}
function sumAll(scores) {
  return scores.some(v=>v==null) ? null : scores.reduce((x,y)=>x+y,0);
}
async function callVision(apiKey, prompt, imageDataUrl, max_output_tokens) {
  const r = await fetch('https://api.openai.com/v1/responses', {
    method:'POST',
    headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
    body:JSON.stringify({
      model:MODEL,
      input:[{role:'user',content:[
        {type:'input_text',text:prompt},
        {type:'input_image',image_url:imageDataUrl,detail:'high'}
      ]}],
      max_output_tokens
    })
  });
  const raw = await r.json();
  if (!r.ok) throw new Error(raw?.error?.message || `OpenAI request failed (${r.status}).`);
  return raw;
}
function extractOutputText(r) {
  if (typeof r.output_text === 'string') return r.output_text;
  const parts=[];
  for (const item of r.output || []) for (const c of item.content || []) if (c.type==='output_text' && typeof c.text==='string') parts.push(c.text);
  return parts.join('\n').trim();
}
function parseJson(text) {
  const c=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/i,'');
  try { return JSON.parse(c); } catch (_) {
    const a=c.indexOf('{'), b=c.lastIndexOf('}');
    if (a>=0 && b>a) return JSON.parse(c.slice(a,b+1));
    throw new Error('The whole-card reader returned an unreadable response.');
  }
}
function reply(statusCode, body) {
  return {statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)};
}
