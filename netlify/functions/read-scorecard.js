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
        ocrMode: 'fixed-template-geometry-v5.9.2'
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

    // Step 4: fixed Colonial template geometry on the NORMALIZED upright card.
    // No more AI-generated row/column coordinates in v5.9.2.
    //
    // These ratios are calibrated to the normalized physical card itself,
    // not to the original phone photograph.
    //
    // Main handwritten rows on this Colonial scorecard:
    // Paul, Steve, Dec, Crain — top to bottom.
    const PLAYER_ROW_CENTERS = [0.275, 0.306, 0.337, 0.368];

    // Hole columns are based on the actual Colonial layout:
    // 9 front-nine cells, OUT gap, then 9 back-nine cells.
    // The card is 1800 px wide after normalization.
    const FRONT_LEFT = 0.185;
    const FRONT_RIGHT = 0.487;
    const BACK_LEFT = 0.530;
    const BACK_RIGHT = 0.832;

    const frontStep = (FRONT_RIGHT - FRONT_LEFT) / 9;
    const backStep = (BACK_RIGHT - BACK_LEFT) / 9;

    const holeCenters = [];
    for (let i = 0; i < 9; i++) {
      holeCenters.push(FRONT_LEFT + frontStep * (i + 0.5));
    }
    for (let i = 0; i < 9; i++) {
      holeCenters.push(BACK_LEFT + backStep * (i + 0.5));
    }

    // Names still come from the normalized card, but geometry does not.
    const namesPrompt = `
NAMES ONLY. Do not read any golf score digits.

This is a normalized upright Colonial Golf Club scorecard.

Read the handwritten player names in the MAIN player block above the printed PAR row.
Return up to four names in top-to-bottom order.

Do not include the handwritten scorer row below PAR.

Return JSON only:
{"names":["name1","name2","name3","name4"]}
`;

    const namesText = extractOutputText(
      await callVision(apiKey, namesPrompt, cardDataUrl, 450)
    );
    const namesParsed = parseJson(namesText);
    const names = Array.isArray(namesParsed?.names)
      ? namesParsed.names.map(v => String(v || '').trim()).filter(Boolean).slice(0, 4)
      : [];

    debug.gridGeometryPass = namesText;
    debug.grid = {
      mode: 'fixed-colonial-template',
      playerRowCenters: PLAYER_ROW_CENTERS,
      holeCenters,
      frontLeft: FRONT_LEFT,
      frontRight: FRONT_RIGHT,
      backLeft: BACK_LEFT,
      backRight: BACK_RIGHT
    };

    const players = [];

    // Tight crop dimensions, still slightly generous for handwriting.
    const cropW = 62;
    const cropH = 54;

    for (let pIndex = 0; pIndex < PLAYER_ROW_CENTERS.length; pIndex++) {
      const rowCenterY = Math.round(PLAYER_ROW_CENTERS[pIndex] * NORMALIZED_HEIGHT);
      const cells = [];

      for (let h = 0; h < 18; h++) {
        const cx = Math.round(holeCenters[h] * NORMALIZED_WIDTH);

        const left = clamp(Math.round(cx - cropW / 2), 0, NORMALIZED_WIDTH - 1);
        const top = clamp(Math.round(rowCenterY - cropH / 2), 0, NORMALIZED_HEIGHT - 1);
        const right = clamp(left + cropW, left + 1, NORMALIZED_WIDTH);
        const bottom = clamp(top + cropH, top + 1, NORMALIZED_HEIGHT);

        const cellBuffer = await sharp(cardBuffer)
          .extract({
            left,
            top,
            width: right - left,
            height: bottom - top
          })
          .resize({
            width: 220,
            height: 220,
            fit: 'contain',
            background: '#ffffff'
          })
          .jpeg({ quality: 96 })
          .toBuffer();

        cells.push({
          hole: h + 1,
          left, top, right, bottom,
          imageDataUrl: `data:image/jpeg;base64,${cellBuffer.toString('base64')}`
        });
      }

      const name = names[pIndex] || `Player ${pIndex + 1}`;

      debug.templateRows.push({
        name,
        playerIndex: pIndex + 1,
        rowCenterY,
        rowYRatio: PLAYER_ROW_CENTERS[pIndex],
        cropW,
        cropH,
        cells
      });

      players.push({
        name,
        scores: Array(18).fill(null),
        uncertainHoles: Array.from({ length: 18 }, (_, i) => i + 1)
      });
    }

    return reply(200, {
      players,
      debug,
      ocrMode: 'fixed-template-geometry-v5.9.2'
    });

  } catch (error) {
    console.error('v5.9.2 fixed-template geometry failure:', error);
    return reply(500, {
      error: error?.message || 'Grid-derived geometry diagnostic failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'fixed-template-geometry-v5.9.2'
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
  } catch (_) {
    const a = c.indexOf('{');
    const b = c.lastIndexOf('}');

    if (a >= 0 && b > a) return JSON.parse(c.slice(a, b + 1));
    throw new Error('The geometry reader returned an unreadable response.');
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
