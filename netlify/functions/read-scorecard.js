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

    // ONE vision call only:
    // identify the first player name, its name box, and the exact handwritten row centerline.
    const geometry = await locateFirstPlayerRowByName(apiKey, normalizedDataUrl);

    if (!geometry.front || !geometry.back) {
      return reply(200, {
        ocrMode: 'name-anchored-row-geometry-v2.6',
        playerName: geometry.name || '',
        message: 'Could not confidently locate the handwritten score row.',
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
        const trimY = Math.max(1, Math.floor(nineHeight * 0.04));

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
      ocrMode: 'name-anchored-row-geometry-v2.6',
      playerName: geometry.name || '',
      debug: { geometry, cells }
    });
  } catch (error) {
    console.error('v2.6 geometry failure:', error);
    return reply(500, {
      error: error?.message || 'Geometry diagnostic failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'name-anchored-row-geometry-v2.6'
    });
  }
};

async function locateFirstPlayerRowByName(apiKey, imageDataUrl) {
  const prompt = `
Geometry-only task on a photographed Colonial Golf Club scorecard.

The photo is preferably landscape:
- Hole 1 is on the left.
- Hole 18 is on the right.
- handwritten player names are on the left side of their score rows.
- player score rows are below the printed HANDICAP row and above the printed PAR row.

Find the FIRST handwritten player name that has handwritten scores on the same row.

Then use the VERTICAL CENTER of that handwritten NAME as the anchor for the player's score row.
The Hole 1-9 and Hole 10-18 boxes must be centered on exactly the same handwritten row as the name.

Return:
- name: handwritten player name
- nameBox: tight box around the handwritten name
- front: tight box around only that player's handwritten Hole 1-9 score cells
- back: tight box around only that player's handwritten Hole 10-18 score cells

CRITICAL:
- The vertical centers of nameBox, front and back must be nearly identical.
- Do not use the blank row above or below the player's writing.
- Do not select the printed HANDICAP row.
- Do not select the printed PAR row.
- Do not select yardages, OUT, IN, TOT, HCP, NET, table, knee or background.
- front must be left of back.
- Coordinates are normalized integers 0-1000 relative to the full image.

Return JSON only:
{
  "name":"",
  "nameBox":{"left":0,"top":0,"right":0,"bottom":0},
  "front":{"left":0,"top":0,"right":0,"bottom":0},
  "back":{"left":0,"top":0,"right":0,"bottom":0}
}`;

  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
  ], 500);

  const parsed = parseJson(extractOutputText(raw));
  const name = String(parsed?.name || '').trim();
  const nameBox = normalizeBox(parsed?.nameBox);
  let front = normalizeBox(parsed?.front);
  let back = normalizeBox(parsed?.back);

  if (!nameBox || !front || !back) return { name, nameBox, front: null, back: null };

  // Name-anchored vertical correction:
  // use the centerline of the handwritten name and force front/back to share it.
  const nameCenter = (nameBox.top + nameBox.bottom) / 2;
  const frontHeight = front.bottom - front.top;
  const backHeight = back.bottom - back.top;
  const rowHeight = Math.max(12, Math.min(70, (frontHeight + backHeight) / 2));

  front = {
    left: front.left,
    right: front.right,
    top: clamp(nameCenter - rowHeight / 2, 0, 999),
    bottom: clamp(nameCenter + rowHeight / 2, 1, 1000)
  };

  back = {
    left: back.left,
    right: back.right,
    top: clamp(nameCenter - rowHeight / 2, 0, 999),
    bottom: clamp(nameCenter + rowHeight / 2, 1, 1000)
  };

  const ordered = front.left < back.left;
  const nameAligned =
    Math.abs(((front.top + front.bottom) / 2) - nameCenter) <= 4 &&
    Math.abs(((back.top + back.bottom) / 2) - nameCenter) <= 4;

  if (!ordered || !nameAligned) {
    return { name, nameBox, front: null, back: null };
  }

  return { name, nameBox, front, back };
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
  if (right - left < 20 || bottom - top < 8) return null;
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
