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
    // locate the first handwritten player row AND the printed hole-header centers.
    const geometry = await locateRowAndHoleCenters(apiKey, normalizedDataUrl);

    if (!geometry.rowBox || geometry.holeCenters.length !== 18) {
      return reply(200, {
        ocrMode: 'hole-header-geometry-v2.8',
        playerName: geometry.name || '',
        message: 'Could not confidently locate the player row and all 18 printed hole columns.',
        debug: { geometry, cells: [] }
      });
    }

    const rowBox = geometry.rowBox;
    const leftPx = clamp(Math.floor(rowBox.left / 1000 * width), 0, width - 1);
    const rightPx = clamp(Math.ceil(rowBox.right / 1000 * width), leftPx + 1, width);
    const topPx = clamp(Math.floor(rowBox.top / 1000 * height), 0, height - 1);
    const bottomPx = clamp(Math.ceil(rowBox.bottom / 1000 * height), topPx + 1, height);

    // Convert 18 normalized header centers into pixel centers.
    const centersPx = geometry.holeCenters.map(x => clamp(Math.round(x / 1000 * width), 0, width - 1));

    // Estimate a crop width from neighboring header centers.
    const diffs = [];
    for (let i = 1; i < centersPx.length; i++) {
      const d = centersPx[i] - centersPx[i - 1];
      if (d > 4) diffs.push(d);
    }
    diffs.sort((a, b) => a - b);
    const medianSpacing = diffs.length ? diffs[Math.floor(diffs.length / 2)] : Math.max(12, Math.floor((rightPx - leftPx) / 18));
    const cropWidth = Math.max(12, Math.floor(medianSpacing * 0.82));

    const cells = [];

    for (let i = 0; i < 18; i++) {
      const hole = i + 1;
      const cx = centersPx[i];
      const halfW = Math.floor(cropWidth / 2);

      const left = clamp(cx - halfW, 0, width - 1);
      const right = clamp(cx + halfW, left + 1, width);
      const cellW = Math.max(1, right - left);
      const cellH = Math.max(1, bottomPx - topPx);

      const cellBuffer = await sharp(normalizedBuffer)
        .extract({ left, top: topPx, width: cellW, height: cellH })
        .resize({ width: 240, height: 180, fit: 'contain', background: '#ffffff' })
        .jpeg({ quality: 92 })
        .toBuffer();

      cells.push({
        hole,
        centerX: geometry.holeCenters[i],
        imageDataUrl: `data:image/jpeg;base64,${cellBuffer.toString('base64')}`
      });
    }

    return reply(200, {
      ocrMode: 'hole-header-geometry-v2.8',
      playerName: geometry.name || '',
      debug: {
        geometry,
        medianSpacing,
        cropWidth,
        cells
      }
    });
  } catch (error) {
    console.error('v2.8 geometry failure:', error);
    return reply(500, {
      error: error?.message || 'Hole-header geometry diagnostic failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'hole-header-geometry-v2.8'
    });
  }
};

async function locateRowAndHoleCenters(apiKey, imageDataUrl) {
  const prompt = `
GEOMETRY-ONLY task on a photographed Colonial Golf Club scorecard.

Do NOT transcribe any scores.

Preferred orientation:
- Hole 1 is on the left.
- Hole 18 is on the right.
- The printed HOLE header row is near the top of the card.
- Player names and handwritten scores are below the printed HANDICAP row and above the printed PAR row.

Tasks:
1) Find the FIRST handwritten player name that has handwritten scores on the same row.
2) Return a tight rowBox around ONLY that player's handwritten score row from just above the digits to just below the digits. The rowBox should span horizontally across all 18 hole columns but exclude the player's name and exclude OUT/IN/TOT/HCP/NET totals.
3) Read the PRINTED HOLE header row and return the horizontal center X-coordinate of each printed hole-number column 1 through 18.

Coordinates are normalized 0-1000 relative to the full image.

CRITICAL:
- holeCenters[0] must be the center of the printed Hole 1 column.
- holeCenters[17] must be the center of the printed Hole 18 column.
- holeCenters must be strictly increasing left-to-right.
- Do not include OUT, IN, TOT, HCP, or NET as hole centers.
- rowBox must be on the same handwritten row as the returned player name.
- Do not use the printed PAR or HANDICAP rows as rowBox.
- Do not select background, table, knee, keyboard, or anything outside the card.

Return JSON only:
{
  "name":"",
  "rowBox":{"left":0,"top":0,"right":0,"bottom":0},
  "holeCenters":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
}`;

  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
  ], 650);

  const parsed = parseJson(extractOutputText(raw));
  const name = String(parsed?.name || '').trim();
  const rowBox = normalizeBox(parsed?.rowBox);
  const source = Array.isArray(parsed?.holeCenters) ? parsed.holeCenters : [];
  const holeCenters = source.map(Number).filter(Number.isFinite);

  if (holeCenters.length !== 18) return { name, rowBox, holeCenters: [] };

  // Mechanical validation.
  for (let i = 0; i < holeCenters.length; i++) {
    if (holeCenters[i] < 0 || holeCenters[i] > 1000) {
      return { name, rowBox, holeCenters: [] };
    }
    if (i > 0 && holeCenters[i] <= holeCenters[i - 1]) {
      return { name, rowBox, holeCenters: [] };
    }
  }

  // Reject wildly irregular spacing; center fold can be wider, so allow broad tolerance.
  const diffs = [];
  for (let i = 1; i < holeCenters.length; i++) diffs.push(holeCenters[i] - holeCenters[i - 1]);
  const sorted = [...diffs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const tooIrregular = diffs.filter(d => d < median * 0.45 || d > median * 2.2).length > 2;

  if (tooIrregular) return { name, rowBox, holeCenters: [] };

  return { name, rowBox, holeCenters };
}

function normalizeBox(box) {
  if (!box || typeof box !== 'object') return null;
  const left = Number(box.left);
  const top = Number(box.top);
  const right = Number(box.right);
  const bottom = Number(box.bottom);

  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  if (left < 0 || top < 0 || right > 1000 || bottom > 1000) return null;
  if (right - left < 100 || bottom - top < 8) return null;

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
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error('The hole-header geometry locator returned an unreadable response.');
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
