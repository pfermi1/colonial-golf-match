const sharp = require('sharp');

const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1';

// v3.1 calibration: v3.0 was roughly two hole-columns too far right.
// Shift the fixed template left by about two normal hole spacings.
const HOLE_X_RATIOS = [
  0.120, 0.155, 0.190, 0.225, 0.260, 0.295, 0.330, 0.365, 0.400,
  0.485, 0.520, 0.555, 0.590, 0.625, 0.660, 0.695, 0.730, 0.765
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

    // One vision call:
    // locate physical card, printed PAR row, and first handwritten player name.
    const geometry = await locateCardParAndPlayer(apiKey, normalizedDataUrl);

    if (!geometry.cardBox || !geometry.parBox || !geometry.nameBox) {
      return reply(200, {
        ocrMode: 'template-calibration-v3.1',
        playerName: geometry.name || '',
        message: 'Could not confidently locate card, PAR row, and player name.',
        debug: { geometry, cells: [] }
      });
    }

    const cardPx = normBoxToPixels(geometry.cardBox, width, height);
    const parPx = normBoxToPixels(geometry.parBox, width, height);
    const namePx = normBoxToPixels(geometry.nameBox, width, height);

    const cardWidth = cardPx.right - cardPx.left;

    // Determine score-row center mechanically.
    // The first player row is immediately above the other player rows and above PAR.
    // Use the player's actual name Y if available, but sanity-check it relative to PAR.
    let rowCenterY = Math.round((namePx.top + namePx.bottom) / 2);

    const parCenterY = Math.round((parPx.top + parPx.bottom) / 2);

    // Expected first-player row should be above PAR by roughly 3.5-5 row-heights.
    // If the name center is implausibly close to PAR or below it, repair from PAR.
    const nameHeight = Math.max(8, namePx.bottom - namePx.top);
    const estimatedRowStep = Math.max(12, Math.round(nameHeight * 1.05));
    if (rowCenterY >= parCenterY - estimatedRowStep * 1.5 || rowCenterY > parCenterY) {
      rowCenterY = parCenterY - Math.round(estimatedRowStep * 4.2);
    }

    const rowCropHeight = Math.max(18, Math.min(90, Math.round(nameHeight * 1.5)));
    const rowTop = clamp(Math.round(rowCenterY - rowCropHeight / 2), 0, height - 2);
    const rowBottom = clamp(rowTop + rowCropHeight, rowTop + 1, height);

    // Fixed Colonial X positions with two-column calibration correction.
    const spacings = [];
    for (let i = 1; i < HOLE_X_RATIOS.length; i++) {
      spacings.push((HOLE_X_RATIOS[i] - HOLE_X_RATIOS[i - 1]) * cardWidth);
    }
    spacings.sort((a, b) => a - b);
    const medianSpacing = spacings[Math.floor(spacings.length / 2)];
    const cropWidth = Math.max(14, Math.floor(medianSpacing * 0.80));

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
      ocrMode: 'template-calibration-v3.1',
      playerName: geometry.name || '',
      debug: {
        geometry,
        rowCenterY,
        parCenterY,
        templateHoleXRatios: HOLE_X_RATIOS,
        cropWidth,
        cells
      }
    });
  } catch (error) {
    console.error('v3.1 geometry failure:', error);
    return reply(500, {
      error: error?.message || 'v3.1 geometry diagnostic failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'template-calibration-v3.1'
    });
  }
};

async function locateCardParAndPlayer(apiKey, imageDataUrl) {
  const prompt = `
GEOMETRY-ONLY task on ONE photographed Colonial Golf Club scorecard.

Do NOT transcribe scores.

Preferred orientation:
- scorecard landscape;
- Hole 1 left, Hole 18 right;
- handwritten player names at left;
- four player rows sit directly ABOVE the printed PAR row;
- a fifth handwritten player may appear BELOW the PAR row.

Find:
1) the outer physical scorecard rectangle;
2) the printed PAR row box;
3) the FIRST handwritten player name above PAR that has handwritten scores on that row.

Return:
- name
- cardBox
- parBox: tight box around the printed PAR row across the card
- nameBox: tight box around only that handwritten player name

CRITICAL:
- Do not confuse the PAR row with a player row.
- Do not use the fifth player below PAR.
- nameBox must be above parBox.
- cardBox excludes table, keyboard, knee, and background.
- Coordinates are normalized 0-1000.

Return JSON only:
{
  "name":"",
  "cardBox":{"left":0,"top":0,"right":0,"bottom":0},
  "parBox":{"left":0,"top":0,"right":0,"bottom":0},
  "nameBox":{"left":0,"top":0,"right":0,"bottom":0}
}`;

  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
  ], 550);

  const parsed = parseJson(extractOutputText(raw));
  const name = String(parsed?.name || '').trim();
  const cardBox = normalizeBox(parsed?.cardBox, 120, 120);
  const parBox = normalizeBox(parsed?.parBox, 120, 8);
  const nameBox = normalizeBox(parsed?.nameBox, 20, 8);

  if (!cardBox || !parBox || !nameBox) {
    return { name, cardBox: null, parBox: null, nameBox: null };
  }

  const inside = (b) =>
    b.left >= cardBox.left && b.right <= cardBox.right &&
    b.top >= cardBox.top && b.bottom <= cardBox.bottom;

  if (!inside(parBox) || !inside(nameBox) || nameBox.top >= parBox.top) {
    return { name, cardBox: null, parBox: null, nameBox: null };
  }

  return { name, cardBox, parBox, nameBox };
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
    throw new Error('The v3.1 geometry locator returned an unreadable response.');
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
