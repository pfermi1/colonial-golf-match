const sharp = require('sharp');

const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1';

const NORMALIZED_WIDTH = 1800;
const NORMALIZED_HEIGHT = 1050;

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return reply(405, { error: 'Method not allowed.' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return reply(500, { error: 'OPENAI_API_KEY is not configured in Netlify.' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const imageDataUrl = body.imageDataUrl;

    if (!imageDataUrl || !/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(imageDataUrl)) {
      return reply(400, { error: 'A scorecard image is required.' });
    }

    const originalBuffer = dataUrlToBuffer(imageDataUrl);

    // EXIF-normalize.
    const exifNormalized = await sharp(originalBuffer)
      .rotate()
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 95 })
      .toBuffer();

    const exifDataUrl = `data:image/jpeg;base64,${exifNormalized.toString('base64')}`;

    // Step 1: make card landscape.
    const landscapePrompt = `
GEOMETRY ONLY. Do not read handwritten player scores.

Look at this Colonial Golf Club scorecard photograph.

Choose the clockwise rotation needed ONLY to make the PHYSICAL CARD landscape.
Return exactly one of 0, 90, or 270.

Return JSON only:
{"rotateClockwiseDegrees":0}
`;

    const landscapeText = extractOutputText(
      await callVision(apiKey, landscapePrompt, exifDataUrl, 250)
    );
    const landscapeParsed = parseJson(landscapeText);
    const landscapeRotation = normalizeLandscapeRotation(
      landscapeParsed?.rotateClockwiseDegrees
    );

    const landscapeBuffer = landscapeRotation === 0
      ? exifNormalized
      : await sharp(exifNormalized)
          .rotate(landscapeRotation)
          .jpeg({ quality: 95 })
          .toBuffer();

    const landscapeDataUrl =
      `data:image/jpeg;base64,${landscapeBuffer.toString('base64')}`;

    // Step 2: choose 0 vs 180 from printed header.
    const headerPrompt = `
ORIENTATION ONLY. Do not read handwritten player names or scores.

This scorecard is already landscape.

Choose:
- 0 if the printed Colonial header is upright with HOLE 1 on the left and HOLE 18 on the right;
- 180 if the entire card must be flipped 180 degrees.

Use only the printed header structure:
HOLE, 1-9, OUT, 10-18, IN, TOT, HCP, NET.

Return JSON only:
{"flip180":0}
`;

    const headerText = extractOutputText(
      await callVision(apiKey, headerPrompt, landscapeDataUrl, 250)
    );
    const headerParsed = parseJson(headerText);
    const flip180 = Number(headerParsed?.flip180) === 180 ? 180 : 0;

    const uprightBuffer = flip180 === 0
      ? landscapeBuffer
      : await sharp(landscapeBuffer)
          .rotate(180)
          .jpeg({ quality: 95 })
          .toBuffer();

    const uprightMeta = await sharp(uprightBuffer).metadata();
    const uprightDataUrl =
      `data:image/jpeg;base64,${uprightBuffer.toString('base64')}`;

    // Step 3: locate physical card rectangle only.
    const cardPrompt = `
GEOMETRY ONLY. Do not read scores.

This Colonial Golf Club scorecard is upright.

Return the tight outer rectangle of the physical card itself.
Coordinates are normalized 0-1000 relative to this image.

Return JSON only:
{"cardBox":{"left":0,"top":0,"right":0,"bottom":0}}
`;

    const cardText = extractOutputText(
      await callVision(apiKey, cardPrompt, uprightDataUrl, 350)
    );
    const cardParsed = parseJson(cardText);
    const cardBox = normalizeBox(cardParsed?.cardBox, 250, 180);

    const debug = {
      landscapePass: landscapeText,
      landscapeRotationClockwiseDegrees: landscapeRotation,
      headerOrientationPass: headerText,
      flip180Degrees: flip180,
      cardPass: cardText,
      cardBox,
      normalizedCardDataUrl: null,
      gridGeometryPass: null,
      grid: null,
      templateRows: []
    };

    if (!cardBox) {
      return reply(200, {
        players: [],
        debug,
        warning: 'Could not locate the physical card rectangle.',
        ocrMode: 'semantic-row-reading-v6.0.5-proofreader'
      });
    }

    const cardPx = normBoxToPixels(cardBox, uprightMeta.width, uprightMeta.height);

    // Normalize physical card to a fixed coordinate system.
    const cardBuffer = await sharp(uprightBuffer)
      .extract({
        left: cardPx.left,
        top: cardPx.top,
        width: cardPx.right - cardPx.left,
        height: cardPx.bottom - cardPx.top
      })
      .resize({
        width: NORMALIZED_WIDTH,
        height: NORMALIZED_HEIGHT,
        fit: 'fill'
      })
      .jpeg({ quality: 96 })
      .toBuffer();

    const cardDataUrl =
      `data:image/jpeg;base64,${cardBuffer.toString('base64')}`;
    debug.normalizedCardDataUrl = cardDataUrl;

    // Step 4: v6.0.5 semantic primary read + conservative proofreader.
    // The first full-card read remains authoritative. The verifier may only
    // change a score when it reports a specific high-confidence correction.
    // It never blanks a valid primary score.
    const semanticPrompt = `
You are reading ONE golf scorecard image.

IMPORTANT:
- Read HANDWRITING, not printed course numbers.
- Do NOT use printed yardages, handicaps, pars, tee ratings, totals, or other printed numbers as player scores.
- Find the MAIN handwritten player block above the printed PAR row.
- There are up to five handwritten player names, one per row.
- For each player, start at that handwritten name and visually follow THE SAME HORIZONTAL HANDWRITTEN ROW to the right.
- Read holes 1 through 9, skip the printed OUT/total column, then continue on that SAME row for holes 10 through 18.
- Each golf score must be a single handwritten integer from 1 through 7.
- If a mark is genuinely unreadable, use null rather than substituting nearby printed text.
- Preserve player order exactly as it appears top-to-bottom on the card.
- Do not invent players from printed labels or the scorer/attest area.

Return JSON only, exactly this shape:
{
  "players": [
    {
      "name": "handwritten player name",
      "scores": [18 values, each an integer 1-7 or null],
      "uncertainHoles": [hole numbers that were genuinely unclear]
    }
  ]
}

Before returning the JSON, silently verify that every score came from the same handwritten row as that player's name and that no printed number was used.
`;

    const semanticResponse = await callVision(
      apiKey,
      semanticPrompt,
      cardDataUrl,
      1800
    );

    const semanticText = extractOutputText(semanticResponse);
    const primaryParsed = parseJson(semanticText);
    const players = cleanPrimaryPlayers(primaryParsed?.players);

    // Pass 2 is NOT another transcription. It receives the primary answer and
    // acts only as a conservative proofreader. It should report a correction
    // only when the handwriting clearly contradicts the primary score.
    const primaryForVerifier = players.map((p, i) => ({
      playerIndex: i + 1,
      name: p.name,
      scores: p.scores
    }));

    const verifierPrompt = `
You are a CONSERVATIVE PROOFREADER for a handwritten golf-score transcription.

The PRIMARY transcription below is the authoritative starting point. Do NOT reread the whole scorecard into a new score list. Do NOT rewrite correct values merely because another digit is plausible.

PRIMARY TRANSCRIPTION:
${JSON.stringify(primaryForVerifier)}

Inspect the SAME full scorecard image and report ONLY specific holes where you are HIGHLY CONFIDENT the primary score is wrong.

Verification rules:
- Follow the player's handwritten name to that same horizontal handwritten row.
- Compare the disputed digit visually with nearby handwriting from the SAME player when useful. For example, if adjacent handwritten marks have the same shape, consider whether they represent the same digit.
- Pay special attention to common handwritten confusions such as 3 vs 4, 4 vs 5, 5 vs 6, and similar-looking repeated digits in neighboring holes.
- Ignore all printed yardages, handicap numbers, par values, tee data, hole labels, OUT/IN totals, and scorer rows.
- Do NOT use arithmetic totals to force a correction.
- A replacement score must be an integer 1-7.
- Report a correction only if confidence is at least 0.95 that the primary value is wrong and the replacement is right.
- If the primary value might be wrong but you are not at least 0.95 confident, put that hole in suspectHoles instead; do NOT provide a correction.
- If the primary value is null and you are at least 0.95 confident of the handwritten digit, you may correct it.
- If there is no high-confidence correction, return an empty corrections array.

Return JSON only:
{
  "corrections": [
    {"playerIndex":1,"hole":8,"from":4,"to":5,"confidence":0.98,"reason":"same handwritten shape as neighboring 5"}
  ],
  "suspectHoles": [
    {"playerIndex":2,"hole":6}
  ]
}
`;

    const verifierText = extractOutputText(
      await callVision(apiKey, verifierPrompt, cardDataUrl, 1400)
    );
    const verifierParsed = parseJson(verifierText);
    const corrections = Array.isArray(verifierParsed?.corrections) ? verifierParsed.corrections : [];
    const suspectHoles = Array.isArray(verifierParsed?.suspectHoles) ? verifierParsed.suspectHoles : [];

    const appliedCorrections = [];
    const rejectedCorrections = [];

    for (const correction of corrections) {
      const playerIndex = Number(correction?.playerIndex);
      const hole = Number(correction?.hole);
      const replacement = cleanScore(correction?.to);
      const confidence = Number(correction?.confidence);

      if (!Number.isInteger(playerIndex) || playerIndex < 1 || playerIndex > players.length ||
          !Number.isInteger(hole) || hole < 1 || hole > 18 ||
          replacement === null || !Number.isFinite(confidence)) {
        continue;
      }

      const player = players[playerIndex - 1];
      const current = player.scores[hole - 1];

      // v6.0.5 safety rule: valid primary scores survive unless proofreader is >=95% confident.
      if (confidence >= 0.95 && replacement !== current) {
        player.scores[hole - 1] = replacement;
        player.uncertainHoles = player.uncertainHoles.filter(h => h !== hole);
        appliedCorrections.push({
          playerIndex, hole, from: current, to: replacement, confidence,
          reason: String(correction?.reason || '')
        });
      } else if (replacement !== current) {
        player.uncertainHoles = [...new Set([...player.uncertainHoles, hole])].sort((a,b)=>a-b);
        rejectedCorrections.push({ playerIndex, hole, from: current, to: replacement, confidence });
      }
    }

    // A verifier suspicion never deletes or replaces the primary score. It only
    // adds the yellow review marker so the user can inspect it if desired.
    for (const item of suspectHoles) {
      const playerIndex = Number(item?.playerIndex);
      const hole = Number(item?.hole);
      if (!Number.isInteger(playerIndex) || playerIndex < 1 || playerIndex > players.length) continue;
      if (!Number.isInteger(hole) || hole < 1 || hole > 18) continue;
      const player = players[playerIndex - 1];
      player.uncertainHoles = [...new Set([...player.uncertainHoles, hole])].sort((a,b)=>a-b);
    }

    // Never blank a valid primary score because of verifier disagreement.
    for (const player of players) {
      player.uncertainHoles = [...new Set([
        ...(player.uncertainHoles || []),
        ...player.scores.map((v, i) => v === null ? i + 1 : null).filter(Boolean)
      ])].sort((a,b)=>a-b);
    }

    debug.semanticRowRead = semanticText;
    debug.semanticProofreader = verifierText;
    debug.semanticAppliedCorrections = appliedCorrections;
    debug.semanticRejectedCorrections = rejectedCorrections;
    debug.semanticMode = true;
    debug.semanticVerificationMode = 'primary-read-plus-conservative-proofreader';

    return reply(200, {
      players,
      debug,
      ocrMode: 'semantic-row-reading-v6.0.5-proofreader'
    });

  } catch (error) {
    console.error('v6.0.5 semantic proofreader failure:', error);
    return reply(500, {
      error: error?.message || 'Semantic scorecard read failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'semantic-row-reading-v6.0.5-proofreader'
    });
  }
};

function cleanScore(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 7 ? n : null;
}

function cleanPrimaryPlayers(src) {
  if (!Array.isArray(src)) return [];
  return src.slice(0, 5).map((player, index) => {
    const scores = Array.isArray(player?.scores) ? player.scores.slice(0, 18).map(cleanScore) : [];
    while (scores.length < 18) scores.push(null);

    const modelUncertain = Array.isArray(player?.uncertainHoles)
      ? player.uncertainHoles.map(Number).filter(h => Number.isInteger(h) && h >= 1 && h <= 18)
      : [];
    const nullHoles = scores.map((v, i) => v === null ? i + 1 : null).filter(Boolean);

    return {
      name: String(player?.name || `Player ${index + 1}`).trim(),
      scores,
      uncertainHoles: [...new Set([...modelUncertain, ...nullHoles])].sort((a,b)=>a-b)
    };
  });
}

function normalizeLandscapeRotation(v) {
  const n = Number(v);
  return [0, 90, 270].includes(n) ? n : 0;
}

function normalizeBox(box, minW, minH) {
  if (!box || typeof box !== 'object') return null;

  const left = Number(box.left);
  const top = Number(box.top);
  const right = Number(box.right);
  const bottom = Number(box.bottom);

  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  if (left < 0 || top < 0 || right > 1000 || bottom > 1000) return null;
  if (right - left < minW || bottom - top < minH) return null;

  return { left, top, right, bottom };
}

function normalizeRows(src) {
  if (!Array.isArray(src)) return [];

  const rows = [];

  for (const item of src) {
    if (!item || typeof item !== 'object') continue;

    const top = Number(item.top);
    const bottom = Number(item.bottom);
    const name = String(item.name || '').trim();

    if (![top, bottom].every(Number.isFinite)) continue;
    if (top < 0 || bottom > 1000 || bottom <= top) continue;
    if (bottom - top < 8) continue;

    rows.push({ name, top, bottom });
  }

  return rows.slice(0, 4);
}

function normalizeAnchors(src) {
  if (!src || typeof src !== 'object') return null;

  const frontLeft = Number(src.frontLeft);
  const outSeparator = Number(src.outSeparator);
  const backRight = Number(src.backRight);

  if (![frontLeft, outSeparator, backRight].every(Number.isFinite)) return null;
  if (frontLeft < 0 || backRight > 1000) return null;
  if (!(frontLeft < outSeparator && outSeparator < backRight)) return null;

  // Each nine-hole section must have meaningful width.
  if (outSeparator - frontLeft < 120) return null;
  if (backRight - outSeparator < 120) return null;

  return { frontLeft, outSeparator, backRight };
}

function deriveHoleCenters(anchors) {
  const { frontLeft, outSeparator, backRight } = anchors;

  // Front nine: divide Hole 1 left boundary -> Hole 9 right boundary into 9 equal cells.
  // The OUT column begins at outSeparator, so infer Hole 9 right boundary one hole-cell width before it.
  const frontSpanToOut = outSeparator - frontLeft;
  const frontCell = frontSpanToOut / 10; // 9 holes + 1 OUT-width slot
  const frontRight = outSeparator - frontCell;

  // Back nine: infer Hole 10 left boundary one OUT-width slot after separator.
  const backSpanFromOut = backRight - outSeparator;
  const backCell = backSpanFromOut / 10; // 1 gap/OUT-width + 9 holes
  const backLeft = outSeparator + backCell;

  const centers = [];

  for (let i = 0; i < 9; i++) {
    centers.push(frontLeft + frontCell * (i + 0.5));
  }
  for (let i = 0; i < 9; i++) {
    centers.push(backLeft + backCell * (i + 0.5));
  }

  return centers.map(v => Math.round(v));
}

function normBoxToPixels(box, width, height) {
  const left = clamp(Math.floor(box.left / 1000 * width), 0, width - 1);
  const top = clamp(Math.floor(box.top / 1000 * height), 0, height - 1);
  const right = clamp(Math.ceil(box.right / 1000 * width), left + 1, width);
  const bottom = clamp(Math.ceil(box.bottom / 1000 * height), top + 1, height);

  return { left, top, right, bottom };
}

function dataUrlToBuffer(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Invalid image data.');
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
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
  if (!r.ok) {
    throw new Error(raw?.error?.message || `OpenAI request failed (${r.status}).`);
  }

  return raw;
}

function extractOutputText(r) {
  if (typeof r.output_text === 'string') return r.output_text;

  const parts = [];
  for (const item of r.output || []) {
    for (const c of item.content || []) {
      if (c.type === 'output_text' && typeof c.text === 'string') {
        parts.push(c.text);
      }
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
  } catch (_) {}

  const start = c.indexOf('{');
  if (start < 0) throw new Error('Vision returned no JSON object.');

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < c.length; i++) {
    const ch = c[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = c.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch (error) {
          throw new Error(`Vision returned malformed JSON: ${error.message}`);
        }
      }
    }
  }

  throw new Error('Vision returned an incomplete JSON object.');
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
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
