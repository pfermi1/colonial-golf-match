const sharp = require('sharp');

const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1';

// Fixed Colonial template coordinates, applied ONLY after the card has been
// rotated upright, cropped to the physical card, and resized to 1800x1050.
const WARP_WIDTH = 1800;
const WARP_HEIGHT = 1050;

const HOLE_X_RATIOS = [
  0.155, 0.189, 0.223, 0.257, 0.291, 0.325, 0.359, 0.393, 0.427,
  0.515, 0.549, 0.583, 0.617, 0.651, 0.685, 0.719, 0.753, 0.787
];

const PLAYER_ROW_Y_RATIOS = [0.365, 0.405, 0.445, 0.485];

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

    // Normalize EXIF orientation first.
    const exifNormalized = await sharp(originalBuffer)
      .rotate()
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 95 })
      .toBuffer();

    const exifMeta = await sharp(exifNormalized).metadata();
    const exifDataUrl = `data:image/jpeg;base64,${exifNormalized.toString('base64')}`;

    // PASS 1: determine the 90-degree rotation needed to make the PHYSICAL CARD
    // landscape with HOLE 1 on the left and HOLE 18 on the right.
    const orientationPrompt = `
GEOMETRY ONLY. Do not read player scores.

Look at this Colonial Golf Club scorecard photograph.

Choose the clockwise rotation needed to make the PHYSICAL SCORECARD upright landscape:
- the word HOLE should read normally;
- Hole 1 should be on the LEFT;
- Hole 18 should be on the RIGHT;
- handwritten player names should read normally from left to right.

Return exactly one of 0, 90, 180, or 270 clockwise degrees.

Return JSON only:
{"rotateClockwiseDegrees":0}
`;

    const orientationText = extractOutputText(
      await callVision(apiKey, orientationPrompt, exifDataUrl, 250)
    );

    const orientationParsed = parseJson(orientationText);
    const rotation = normalizeRotation(orientationParsed?.rotateClockwiseDegrees);

    const uprightBuffer = rotation === 0
      ? exifNormalized
      : await sharp(exifNormalized)
          .rotate(rotation)
          .jpeg({ quality: 95 })
          .toBuffer();

    const uprightMeta = await sharp(uprightBuffer).metadata();
    const uprightWidth = uprightMeta.width;
    const uprightHeight = uprightMeta.height;
    const uprightDataUrl = `data:image/jpeg;base64,${uprightBuffer.toString('base64')}`;

    // PASS 2: on the now-upright image, locate only the physical card rectangle
    // and handwritten player names. No score rows and no score OCR.
    const locatorPrompt = `
GEOMETRY AND NAMES ONLY. Do not read any golf score digits.

This Colonial Golf Club scorecard image has already been rotated so the physical
card should be landscape with Hole 1 on the LEFT and Hole 18 on the RIGHT.

Return:
1) the tight outer rectangle of the physical scorecard itself;
2) the handwritten player names in the MAIN player block above the printed PAR row,
   top-to-bottom.

Do not include the separate handwritten scorer row below PAR.
Ignore printed PAR, HANDICAP, yardage, tee, scorer, attest and date information.

Coordinates are normalized integers 0-1000 relative to THIS upright image.

Return JSON only:
{
  "cardBox":{"left":0,"top":0,"right":0,"bottom":0},
  "names":["name1","name2","name3","name4"]
}
`;

    const locatorText = extractOutputText(
      await callVision(apiKey, locatorPrompt, uprightDataUrl, 700)
    );

    const locatorParsed = parseJson(locatorText);
    const cardBox = normalizeBox(locatorParsed?.cardBox, 250, 180);
    const names = Array.isArray(locatorParsed?.names)
      ? locatorParsed.names.map(v => String(v || '').trim()).filter(Boolean).slice(0, 4)
      : [];

    const debug = {
      orientationPass: orientationText,
      rotationClockwiseDegrees: rotation,
      locatorPass: locatorText,
      cardBox,
      uprightImageDataUrl: uprightDataUrl,
      normalizedCardDataUrl: null,
      templateRows: []
    };

    if (!cardBox) {
      return reply(200, {
        players: [],
        debug,
        warning: 'Could not locate the physical card rectangle after upright rotation.',
        ocrMode: 'upright-card-template-geometry-v5.8'
      });
    }

    const cardPx = normBoxToPixels(cardBox, uprightWidth, uprightHeight);

    // Crop the physical card and normalize it to a fixed landscape coordinate system.
    // This is the key v5.8 change: all template coordinates below are relative to
    // this standardized card image, not to the phone photograph.
    const cardBuffer = await sharp(uprightBuffer)
      .extract({
        left: cardPx.left,
        top: cardPx.top,
        width: cardPx.right - cardPx.left,
        height: cardPx.bottom - cardPx.top
      })
      .resize({
        width: WARP_WIDTH,
        height: WARP_HEIGHT,
        fit: 'fill'
      })
      .jpeg({ quality: 96 })
      .toBuffer();

    debug.normalizedCardDataUrl =
      `data:image/jpeg;base64,${cardBuffer.toString('base64')}`;

    // Generate four fixed Colonial player rows and 18 hole crops per row.
    const cropW = 58;
    const cropH = 58;

    const players = [];

    for (let pIndex = 0; pIndex < PLAYER_ROW_Y_RATIOS.length; pIndex++) {
      const rowCenterY = Math.round(PLAYER_ROW_Y_RATIOS[pIndex] * WARP_HEIGHT);
      const cells = [];

      for (let h = 0; h < 18; h++) {
        const cx = Math.round(HOLE_X_RATIOS[h] * WARP_WIDTH);

        const left = clamp(Math.round(cx - cropW / 2), 0, WARP_WIDTH - 1);
        const top = clamp(Math.round(rowCenterY - cropH / 2), 0, WARP_HEIGHT - 1);
        const right = clamp(left + cropW, left + 1, WARP_WIDTH);
        const bottom = clamp(top + cropH, top + 1, WARP_HEIGHT);

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

      const playerName = names[pIndex] || `Player ${pIndex + 1}`;

      debug.templateRows.push({
        name: playerName,
        playerIndex: pIndex + 1,
        rowYRatio: PLAYER_ROW_Y_RATIOS[pIndex],
        rowCenterY,
        cropW,
        cropH,
        cells
      });

      players.push({
        name: playerName,
        scores: Array(18).fill(null),
        uncertainHoles: Array.from({ length: 18 }, (_, i) => i + 1)
      });
    }

    return reply(200, {
      players,
      debug,
      ocrMode: 'upright-card-template-geometry-v5.8'
    });

  } catch (error) {
    console.error('v5.8 upright-card geometry failure:', error);
    return reply(500, {
      error: error?.message || 'Upright-card geometry diagnostic failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'upright-card-template-geometry-v5.8'
    });
  }
};

function normalizeRotation(v) {
  const n = Number(v);
  return [0, 90, 180, 270].includes(n) ? n : 0;
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

function normBoxToPixels(box, width, height) {
  const left = clamp(Math.floor(box.left / 1000 * width), 0, width - 1);
  const top = clamp(Math.floor(box.top / 1000 * height), 0, height - 1);
  const right = clamp(Math.ceil(box.right / 1000 * width), left + 1, width);
  const bottom = clamp(Math.ceil(box.bottom / 1000 * height), top + 1, height);

  return { left, top,right,bottom };
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
