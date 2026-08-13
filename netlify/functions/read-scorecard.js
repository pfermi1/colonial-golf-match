const sharp = require('sharp');

const MODEL = 'gpt-5.6-sol';

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
    const landscapeParsed = parseJson(landscapeText, 'landscape orientation');
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
    const headerParsed = parseJson(headerText, 'header orientation');
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
    const cardParsed = parseJson(cardText, 'card rectangle');
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
        ocrMode: 'gpt-5.6-sol-single-semantic-read-v6.1.1-diagnostic'
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

    // Step 4: v6.0 semantic row reading.
    // No X/Y geometry. No per-cell crops. No traditional OCR.
    // Give the normalized full card to the vision model and ask it to reason
    // from each handwritten player name across that SAME handwritten row.
    const semanticPrompt = `
You are reading ONE golf scorecard image.

IMPORTANT:
- Read HANDWRITING, not the printed course numbers.
- Do NOT use printed yardages, handicaps, pars, tee ratings, totals, or other printed numbers as player scores.
- Find the MAIN handwritten player block above the printed PAR row.
- There are up to four handwritten player names, one per row.
- For each player, start at that handwritten name and visually follow THE SAME HORIZONTAL HANDWRITTEN ROW to the right.
- Read holes 1 through 9, skip the printed OUT/total column, then continue on that SAME row for holes 10 through 18.
- A normal golf score is generally a single handwritten digit. If a mark is genuinely unreadable, use null rather than substituting nearby printed text.
- Preserve the player order exactly as it appears top-to-bottom on the card.
- Do not invent players from printed labels or the scorer/attest area.

Return JSON only, exactly this shape:
{
  "players": [
    {
      "name": "handwritten player name",
      "scores": [18 values, each an integer 1-12 or null],
      "uncertainHoles": [hole numbers that were unclear]
    }
  ]
}

Before returning the JSON, silently verify:
1. every score came from the same handwritten row as that player's name;
2. no printed three-digit yardage or printed handicap/par number was used;
3. each player has exactly 18 score entries;
4. uncertain marks are null.
`;

    const semanticResponse = await callVision(
      apiKey,
      semanticPrompt,
      cardDataUrl,
      1800
    );

    const semanticText = extractOutputText(semanticResponse);
    const parsed = parseJson(semanticText, 'semantic score read');
    const rawPlayers = Array.isArray(parsed?.players) ? parsed.players : [];

    const players = rawPlayers.slice(0, 4).map((player, index) => {
      const scores = Array.isArray(player?.scores) ? player.scores.slice(0, 18) : [];
      while (scores.length < 18) scores.push(null);

      const cleanedScores = scores.map(value => {
        if (value === null || value === undefined || value === '') return null;
        const n = Number(value);
        return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
      });

      const modelUncertain = Array.isArray(player?.uncertainHoles)
        ? player.uncertainHoles.map(Number).filter(h => Number.isInteger(h) && h >= 1 && h <= 18)
        : [];

      const nullHoles = cleanedScores
        .map((v, i) => v === null ? i + 1 : null)
        .filter(Boolean);

      return {
        name: String(player?.name || `Player ${index + 1}`).trim(),
        scores: cleanedScores,
        uncertainHoles: [...new Set([...modelUncertain, ...nullHoles])].sort((a, b) => a - b)
      };
    });

    debug.semanticRowRead = semanticText;
    debug.semanticParsed = parsed;
    debug.semanticModel = MODEL;
    debug.semanticImageDetail = 'original';
    debug.semanticPassCount = 1;
    debug.semanticMode = true;

    return reply(200, {
      players,
      debug,
      ocrMode: 'gpt-5.6-sol-single-semantic-read-v6.1.1-diagnostic'
    });

  } catch (error) {
    console.error('v6.1.1 GPT-5.6 Sol diagnostic failure:', error);

    if (error?.name === 'VisionParseError') {
      return reply(200, {
        players: [],
        diagnosticFailure: true,
        debug: {
          semanticMode: true,
          parseFailure: {
            stage: error.stage || 'unknown stage',
            rawResponse: error.rawResponse || '',
            cleanedResponse: error.cleanedResponse || '',
            parserError: error.initialParseError || error.message || ''
          },
          semanticModel: MODEL,
          semanticImageDetail: 'original',
          semanticPassCount: 1
        },
        warning: `GPT-5.6 response could not be parsed during ${error.stage || 'an unknown stage'}.`,
        ocrMode: 'gpt-5.6-sol-single-semantic-read-v6.1.1-diagnostic'
      });
    }

    return reply(500, {
      error: error?.message || 'GPT-5.6 Sol semantic scorecard read failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'gpt-5.6-sol-single-semantic-read-v6.1.1-diagnostic'
    });
  }
};

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
          { type: 'input_image', image_url: imageDataUrl, detail: 'original' }
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

function parseJson(text, stage = 'unknown stage') {
  const rawText = String(text || '');
  const c = rawText.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

  try {
    return JSON.parse(c);
  } catch (firstError) {
    // Extract the first complete top-level JSON object, ignoring any prose or
    // extra material the model may have added before/after it.
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < c.length; i++) {
      const ch = c[i];

      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }

      if (ch === '"') { inString = true; continue; }
      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}' && depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          const candidate = c.slice(start, i + 1);
          try { return JSON.parse(candidate); } catch (_) {}
          start = -1;
        }
      }
    }

    const error = new Error(`GPT-5.6 returned unreadable JSON during ${stage}.`);
    error.name = 'VisionParseError';
    error.stage = stage;
    error.rawResponse = rawText;
    error.cleanedResponse = c;
    error.initialParseError = firstError?.message || String(firstError);
    throw error;
  }
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
