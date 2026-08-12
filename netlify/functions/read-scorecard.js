const sharp = require('sharp');

const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1';

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

    // ONE vision call only: locate first visible handwritten player row.
    const geometry = await locateFirstPlayerRow(apiKey, normalizedDataUrl);

    if (!geometry.front || !geometry.back) {
      return reply(200, {
        ocrMode: 'geometry-only-v2.5',
        playerName: geometry.name || '',
        message: 'Could not confidently locate both nine-hole score regions.',
        debug: { geometry, cells: [] }
      });
    }

    const cells = [];
    for (const half of [
      { box: geometry.front, startHole: 1, label: 'front' },
      { box: geometry.back, startHole: 10, label: 'back' }
    ]) {
      const nineBuffer = await extractNormalizedBox(normalizedBuffer, width, height, half.box);
      const nineMeta = await sharp(nineBuffer).metadata();
      const nineWidth = nineMeta.width;
      const nineHeight = nineMeta.height;

      for (let i = 0; i < 9; i++) {
        const hole = half.startHole + i;
        const x0 = Math.floor(i * nineWidth / 9);
        const x1 = Math.floor((i + 1) * nineWidth / 9);
        const rawW = Math.max(1, x1 - x0);

        const trimX = Math.max(1, Math.floor(rawW * 0.05));
        const trimY = Math.max(1, Math.floor(nineHeight * 0.05));

        const left = Math.min(nineWidth - 1, x0 + trimX);
        const top = Math.min(nineHeight - 1, trimY);
        const cellW = Math.max(1, Math.min(nineWidth - left, rawW - trimX * 2));
        const cellH = Math.max(1, Math.min(nineHeight - top, nineHeight - trimY * 2));

        const cellBuffer = await sharp(nineBuffer)
          .extract({ left, top, width: cellW, height: cellH })
          .resize({ width: 240, height: 180, fit: 'contain', background: '#ffffff' })
          .jpeg({ quality: 92 })
          .toBuffer();

        cells.push({
          hole,
          half: half.label,
          imageDataUrl: `data:image/jpeg;base64,${cellBuffer.toString('base64')}`
        });
      }
    }

    return reply(200, {
      ocrMode: 'geometry-only-v2.5',
      playerName: geometry.name || '',
      debug: {
        geometry,
        cells
      }
    });
  } catch (error) {
    console.error('v2.5 geometry-only failure:', error);
    return reply(500, {
      error: error?.message || 'Geometry diagnostic failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'geometry-only-v2.5'
    });
  }
};

async function locateFirstPlayerRow(apiKey, imageDataUrl) {
  const prompt = `
You are locating ONE handwritten player score row on a Colonial Golf Club paper scorecard.

This is a GEOMETRY-ONLY task. Do not transcribe scores.

Use THIS image only.

Preferred orientation:
- scorecard is landscape;
- Hole 1 is at the left;
- Hole 18 is at the right;
- player names are at the left of handwritten rows;
- handwritten player rows are below the printed HANDICAP row and above the printed PAR row.

Locate the FIRST handwritten player row that actually contains handwritten scores.

Return:
1) the visible handwritten player name;
2) a tight bounding box around ONLY that player's handwritten Hole 1-9 score cells;
3) a tight bounding box around ONLY that same player's handwritten Hole 10-18 score cells.

CRITICAL:
- Do not select printed yardages.
- Do not select the printed HANDICAP row.
- Do not select the printed PAR row.
- Do not select OUT, IN, TOT, HCP or NET.
- Do not select background, table, knee, keyboard, or anything outside the card.
- Front and back boxes must be on the SAME handwritten horizontal row.
- Front box must be left of back box.
- Coordinates are normalized integers 0-1000 relative to the full image.

Return JSON only:
{
  "name":"",
  "front":{"left":0,"top":0,"right":0,"bottom":0},
  "back":{"left":0,"top":0,"right":0,"bottom":0}
}`;

  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
  ], 400);

  const parsed = parseJson(extractOutputText(raw));
  const front = normalizeBox(parsed?.front);
  const back = normalizeBox(parsed?.back);
  const name = String(parsed?.name || '').trim();

  if (!front || !back) return { name, front: null, back: null };

  const sameRow = Math.abs(front.top - back.top) <= 35 &&
                  Math.abs(front.bottom - back.bottom) <= 35;
  const ordered = front.left < back.left;
  const similarHeight = Math.abs((front.bottom-front.top) - (back.bottom-back.top)) <= 25;

  if (!sameRow || !ordered || !similarHeight) {
    return { name, front: null, back: null };
  }

  return { name, front, back };
}

async function extractNormalizedBox(imageBuffer, imageWidth, imageHeight, box) {
  const left = clamp(Math.floor(box.left / 1000 * imageWidth), 0, imageWidth - 1);
  const top = clamp(Math.floor(box.top / 1000 * imageHeight), 0, imageHeight - 1);
  const right = clamp(Math.ceil(box.right / 1000 * imageWidth), left + 1, imageWidth);
  const bottom = clamp(Math.ceil(box.bottom / 1000 * imageHeight), top + 1, imageHeight);

  return sharp(imageBuffer)
    .extract({ left, top, width: right - left, height: bottom - top })
    .jpeg({ quality: 94 })
    .toBuffer();
}

function normalizeBox(box) {
  if (!box || typeof box !== 'object') return null;
  const left = Number(box.left);
  const top = Number(box.top);
  const right = Number(box.right);
  const bottom = Number(box.bottom);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  if (left < 0 || top < 0 || right > 1000 || bottom > 1000) return null;
  if (right - left < 30 || bottom - top < 8) return null;
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
      if (content.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
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
    throw new Error('The geometry locator returned an unreadable response.');
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
