const sharp = require('sharp');

const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1';

// v3.2 calibrated Colonial hole centers within the physical card rectangle.
// These explicitly account for the OUT gap between 9 and 10 and the IN/TOT area after 18.
const HOLE_X_RATIOS = [
  0.160, 0.194, 0.228, 0.262, 0.296, 0.330, 0.364, 0.398, 0.432,
  0.520, 0.554, 0.588, 0.622, 0.656, 0.690, 0.724, 0.758, 0.792
];

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed.' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return reply(500, { error: 'OPENAI_API_KEY is not configured in Netlify.' });

  try {
    const body = JSON.parse(event.body || '{}');
    const { imageDataUrl } = body;

    if (!imageDataUrl || !/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(imageDataUrl)) {
      return reply(400, { error: 'A scorecard image is required.' });
    }

    const inputBuffer = dataUrlToBuffer(imageDataUrl);
    const normalizedBuffer = await sharp(inputBuffer)
      .rotate()
      .resize({ width: 2200, height: 2200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();

    const meta = await sharp(normalizedBuffer).metadata();
    const width = meta.width;
    const height = meta.height;
    const normalizedDataUrl = `data:image/jpeg;base64,${normalizedBuffer.toString('base64')}`;

    // ONE vision call:
    // locate physical card and first handwritten player NAME only.
    const geometry = await locateCardAndFirstPlayerName(apiKey, normalizedDataUrl);

    if (!geometry.cardBox || !geometry.nameBox) {
      return reply(200, {
        ocrMode: 'name-y-offset-colonial-x-v3.3',
        playerName: geometry.name || '',
        message: 'Could not confidently locate the card and first handwritten player name.',
        debug: { geometry, cells: [] }
      });
    }

    const cardPx = normBoxToPixels(geometry.cardBox, width, height);
    const namePx = normBoxToPixels(geometry.nameBox, width, height);

    const cardWidth = cardPx.right - cardPx.left;
    const nameHeight = Math.max(1, namePx.bottom - namePx.top);

    // v3.3 Y-only calibration:
    // v3.2 consistently landed on the printed HANDICAP row immediately above Paul.
    // Keep the detected handwritten-name box as the anchor, but shift the score
    // crop down by one handwriting-row offset. X geometry is intentionally unchanged.
    const nameCenterY = Math.round((namePx.top + namePx.bottom) / 2);
    const yOffset = Math.max(10, Math.round(nameHeight * 0.95));
    const rowCenterY = clamp(nameCenterY + yOffset, 0, height - 1);

    // Slightly tighter crop so the row above is less likely to leak into the tile.
    const rowCropHeight = Math.max(18, Math.min(74, Math.round(nameHeight * 1.18)));
    const rowTop = clamp(Math.round(rowCenterY - rowCropHeight / 2), 0, height - 2);
    const rowBottom = clamp(rowTop + rowCropHeight, rowTop + 1, height);

    // Normal hole spacing is the small spacing inside each nine.
    const normalSpacings = [];
    for (let i = 1; i < 9; i++) {
      normalSpacings.push((HOLE_X_RATIOS[i] - HOLE_X_RATIOS[i - 1]) * cardWidth);
    }
    for (let i = 10; i < 18; i++) {
      normalSpacings.push((HOLE_X_RATIOS[i] - HOLE_X_RATIOS[i - 1]) * cardWidth);
    }
    normalSpacings.sort((a, b) => a - b);
    const medianSpacing = normalSpacings[Math.floor(normalSpacings.length / 2)];
    const cropWidth = Math.max(14, Math.floor(medianSpacing * 0.78));

    const cells = [];

    for (let i = 0; i < 18; i++) {
      const hole = i + 1;
      const cx = Math.round(cardPx.left + HOLE_X_RATIOS[i] * cardWidth);
      const halfW = Math.floor(cropWidth / 2);

      const left = clamp(cx - halfW, 0, width - 1);
      const right = clamp(cx + halfW, left + 1, width);

      const cellBuffer = await sharp(normalizedBuffer)
        .extract({
          left,
          top: rowTop,
          width: Math.max(1, right - left),
          height: Math.max(1, rowBottom - rowTop)
        })
        .resize({ width: 240, height: 180, fit: 'contain', background: '#ffffff' })
        .jpeg({ quality: 92 })
        .toBuffer();

      cells.push({
        hole,
        xRatio: HOLE_X_RATIOS[i],
        imageDataUrl: `data:image/jpeg;base64,${cellBuffer.toString('base64')}`
      });
    }

    return reply(200, {
      ocrMode: 'name-y-offset-colonial-x-v3.3',
      playerName: geometry.name || '',
      debug: {
        geometry,
        nameCenterY,
        yOffset,
        rowCenterY,
        rowCropHeight,
        templateHoleXRatios: HOLE_X_RATIOS,
        cropWidth,
        cells
      }
    });
  } catch (error) {
    console.error('v3.3 geometry failure:', error);
    return reply(500, {
      error: error?.message || 'v3.3 geometry diagnostic failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'name-y-offset-colonial-x-v3.3'
    });
  }
};

async function locateCardAndFirstPlayerName(apiKey, imageDataUrl) {
  const prompt = `
GEOMETRY-ONLY task on ONE photographed Colonial Golf Club scorecard.

Do NOT transcribe score digits.

Preferred orientation:
- scorecard is landscape;
- Hole 1 is left and Hole 18 is right;
- handwritten player names are on the left;
- four player rows are above the printed PAR row.

Find the FIRST handwritten player name above PAR that has handwritten scores on the same row.

Return ONLY:
1) name: the visible handwritten player name;
2) cardBox: outer rectangle of the physical scorecard;
3) nameBox: a TIGHT rectangle around ONLY the handwritten letters of that player's name.

CRITICAL:
- nameBox must tightly surround the handwritten name, not the printed HANDICAP/PAR text.
- Do not return the score row as nameBox.
- Do not use the fifth player below PAR.
- cardBox excludes table, keyboard, knee, and all background.
- Coordinates are normalized 0-1000 relative to the full image.

Return JSON only:
{
  "name":"",
  "cardBox":{"left":0,"top":0,"right":0,"bottom":0},
  "nameBox":{"left":0,"top":0,"right":0,"bottom":0}
}`;

  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
  ], 450);

  const parsed = parseJson(extractOutputText(raw));
  const name = String(parsed?.name || '').trim();
  const cardBox = normalizeBox(parsed?.cardBox, 120, 120);
  const nameBox = normalizeBox(parsed?.nameBox, 20, 8);

  if (!cardBox || !nameBox) {
    return { name, cardBox: null, nameBox: null };
  }

  const nameInside =
    nameBox.left >= cardBox.left &&
    nameBox.right <= cardBox.right &&
    nameBox.top >= cardBox.top &&
    nameBox.bottom <= cardBox.bottom;

  if (!nameInside) {
    return { name, cardBox: null, nameBox: null };
  }

  return { name, cardBox, nameBox };
}

function normalizeBox(box, minWidth, minHeight) {
  if (!box || typeof box !== 'object') return null;
  const left = Number(box.left);
  const top = Number(box.top);
  const right = Number(box.right);
  const bottom = Number(box.bottom);

  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  if (left < 0 || top < 0 || right > 1000 || bottom > 1000) return null;
  if (right - left < minWidth || bottom - top < minHeight) return null;

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
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('The v3.3 geometry locator returned an unreadable response.');
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
