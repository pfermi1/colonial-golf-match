const sharp = require('sharp');

const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1';

// Colonial card geometry ratios, measured relative to the physical card rectangle.
// v5.7.1 does NO score OCR. It only proves card-relative grid cropping.
const HOLE_X_RATIOS = [
  0.155, 0.189, 0.223, 0.257, 0.291, 0.325, 0.359, 0.393, 0.427,
  0.515, 0.549, 0.583, 0.617, 0.651, 0.685, 0.719, 0.753, 0.787
];

// Main handwritten player block row centers relative to the detected physical card.
// These are deliberately template-relative, not raw-photo-relative.
const PLAYER_ROW_Y_RATIOS = [0.365, 0.405, 0.445, 0.485];

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

    const originalBuffer = dataUrlToBuffer(imageDataUrl);

    // EXIF-normalize only; preserve the full card photograph otherwise.
    const normalizedBuffer = await sharp(originalBuffer)
      .rotate()
      .resize({ width: 2200, height: 2200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 95 })
      .toBuffer();

    const meta = await sharp(normalizedBuffer).metadata();
    const width = meta.width;
    const height = meta.height;
    const normalizedDataUrl = `data:image/jpeg;base64,${normalizedBuffer.toString('base64')}`;

    // One simple geometry call: physical card bounds + handwritten names only.
    // Do NOT ask vision to locate score rows or read scores.
    const prompt = `
GEOMETRY AND NAMES ONLY. Do not read any golf score digits.

Look at this ONE Colonial Golf Club scorecard photograph.

Return:
1) the outer physical rectangle of the scorecard itself;
2) the handwritten player names in the main player block above the printed PAR row, top-to-bottom.

Do NOT locate score rows.
Do NOT read any score digits.
Do NOT include the separate handwritten scorer row below PAR.
Ignore printed PAR, HANDICAP, yardage, tee, scorer, attest and date information.

Coordinates are normalized integers 0-1000 relative to THIS image.

Return JSON only:
{
  "cardBox":{"left":0,"top":0,"right":0,"bottom":0},
  "names":["name1","name2","name3","name4"]
}
`;

    const locatorText = extractOutputText(await callVision(apiKey, prompt, normalizedDataUrl, 700));
    const parsed = parseJson(locatorText);

    const cardBox = normalizeBox(parsed?.cardBox, 200, 150);
    const names = Array.isArray(parsed?.names)
      ? parsed.names.map(v => String(v || '').trim()).filter(Boolean).slice(0, 4)
      : [];

    const debug = {
      locatorPass: locatorText,
      normalizedImageDataUrl: normalizedDataUrl,
      cardBox,
      cardPreviewDataUrl: null,
      templateRows: []
    };

    if (!cardBox) {
      return reply(200, {
        players: [],
        debug,
        warning: 'Could not locate the physical card rectangle.',
        ocrMode: 'card-template-geometry-v5.7.1'
      });
    }

    const cardPx = normBoxToPixels(cardBox, width, height);
    const cardW = cardPx.right - cardPx.left;
    const cardH = cardPx.bottom - cardPx.top;

    // Card preview for visual confirmation.
    const cardPreview = await sharp(normalizedBuffer)
      .extract({
        left: cardPx.left,
        top: cardPx.top,
        width: cardW,
        height: cardH
      })
      .resize({ width: 1000, fit: 'inside' })
      .jpeg({ quality: 90 })
      .toBuffer();

    debug.cardPreviewDataUrl = `data:image/jpeg;base64,${cardPreview.toString('base64')}`;

    // Create four fixed template rows regardless of whether all four names were read.
    const players = [];
    const normalSpacing = 0.034 * cardW;
    const cropW = Math.max(30, Math.round(normalSpacing * 1.02));
    const cropH = Math.max(42, Math.round(cardH * 0.045));

    for (let pIndex = 0; pIndex < PLAYER_ROW_Y_RATIOS.length; pIndex++) {
      const rowCenterY = Math.round(cardPx.top + PLAYER_ROW_Y_RATIOS[pIndex] * cardH);
      const cells = [];

      for (let h = 0; h < 18; h++) {
        const cx = Math.round(cardPx.left + HOLE_X_RATIOS[h] * cardW);

        const left = clamp(Math.round(cx - cropW/2), 0, width - 1);
        const top = clamp(Math.round(rowCenterY - cropH/2), 0, height - 1);
        const right = clamp(left + cropW, left + 1, width);
        const bottom = clamp(top + cropH, top + 1, height);

        const cellBuffer = await sharp(normalizedBuffer)
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
      ocrMode: 'card-template-geometry-v5.7.1'
    });

  } catch (error) {
    console.error('v5.7.1 card-template geometry failure:', error);
    return reply(500, {
      error: error?.message || 'Card-template geometry diagnostic failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'card-template-geometry-v5.7.1'
    });
  }
};

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
      'Content-Type':'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      input: [{
        role:'user',
        content:[
          { type:'input_text', text:prompt },
          { type:'input_image', image_url:imageDataUrl, detail:'high' }
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
    throw new Error('The card locator returned an unreadable response.');
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function reply(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':'application/json',
      'Cache-Control':'no-store'
    },
    body: JSON.stringify(body)
  };
}
