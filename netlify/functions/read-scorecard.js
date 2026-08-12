const sharp = require('sharp');

const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1';

// Fixed Colonial hole-center ratios inside the detected physical card rectangle.
// No score OCR is performed in v5.7.
const HOLE_X_RATIOS = [
  0.155, 0.189, 0.223, 0.257, 0.291, 0.325, 0.359, 0.393, 0.427,
  0.515, 0.549, 0.583, 0.617, 0.651, 0.685, 0.719, 0.753, 0.787
];

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

    // Normalize EXIF orientation only. No perspective warp and no OCR.
    const normalizedBuffer = await sharp(originalBuffer)
      .rotate()
      .resize({ width: 2200, height: 2200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 95 })
      .toBuffer();

    const meta = await sharp(normalizedBuffer).metadata();
    const width = meta.width;
    const height = meta.height;
    const normalizedDataUrl = `data:image/jpeg;base64,${normalizedBuffer.toString('base64')}`;

    // ONE geometry-only vision call.
    const prompt = `
GEOMETRY ONLY. Do not read any golf score digits.

Look at this ONE Colonial Golf Club scorecard image.

Find:
1) the outer physical card rectangle;
2) every handwritten player NAME in the main handwritten player block ABOVE the printed PAR row;
3) for each player, a tight rowBox covering the same horizontal handwritten score row as that name.

Important:
- Do not include the printed PAR row.
- Do not include printed HANDICAP or yardage rows.
- Do not include the separate handwritten scorer row below PAR.
- rowBox should be only one player row high.
- Return players top-to-bottom exactly as seen.
- Coordinates are normalized integers 0-1000 relative to this image.

Return JSON only:
{
  "cardBox":{"left":0,"top":0,"right":0,"bottom":0},
  "players":[
    {"name":"string","rowBox":{"left":0,"top":0,"right":0,"bottom":0}}
  ]
}
`;

    const locatorText = extractOutputText(await callVision(apiKey, prompt, normalizedDataUrl, 1000));
    const parsed = parseJson(locatorText);

    const cardBox = normalizeBox(parsed?.cardBox, 200, 150);
    const locatedPlayers = normalizeLocatedPlayers(parsed?.players);

    const debug = {
      locatorPass: locatorText,
      normalizedImageDataUrl: normalizedDataUrl,
      cardBox,
      locatedPlayers: []
    };

    if (!cardBox || !locatedPlayers.length) {
      return reply(200, {
        players: [],
        debug,
        warning: 'Geometry locator did not return a usable card/player layout.',
        ocrMode: 'geometry-only-v5.7'
      });
    }

    const cardPx = normBoxToPixels(cardBox, width, height);
    const cardWidth = cardPx.right - cardPx.left;

    for (let pIndex = 0; pIndex < locatedPlayers.length; pIndex++) {
      const loc = locatedPlayers[pIndex];
      const rowPx = normBoxToPixels(loc.rowBox, width, height);
      const rowCenterY = Math.round((rowPx.top + rowPx.bottom) / 2);
      const rowHeight = Math.max(20, rowPx.bottom - rowPx.top);

      const normalSpacing = 0.034 * cardWidth;
      const cropW = Math.max(30, Math.round(normalSpacing * 1.0));
      const cropH = Math.max(40, Math.round(rowHeight * 1.65));

      const cells = [];

      for (let h = 0; h < 18; h++) {
        const cx = Math.round(cardPx.left + HOLE_X_RATIOS[h] * cardWidth);

        const left = clamp(Math.round(cx - cropW / 2), 0, width - 1);
        const top = clamp(Math.round(rowCenterY - cropH / 2), 0, height - 1);
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
          left,
          top,
          right,
          bottom,
          imageDataUrl: `data:image/jpeg;base64,${cellBuffer.toString('base64')}`
        });
      }

      debug.locatedPlayers.push({
        name: loc.name,
        rowBox: loc.rowBox,
        rowPx,
        rowCenterY,
        cropW,
        cropH,
        cells
      });
    }

    // No scores at all in v5.7. This build exists only to prove the geometry.
    return reply(200, {
      players: locatedPlayers.map(p => ({
        name: p.name,
        scores: Array(18).fill(null),
        uncertainHoles: Array.from({ length: 18 }, (_, i) => i + 1)
      })),
      debug,
      ocrMode: 'geometry-only-v5.7'
    });

  } catch (error) {
    console.error('v5.7 geometry-only failure:', error);
    return reply(500, {
      error: error?.message || 'Geometry-only diagnostic failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'geometry-only-v5.7'
    });
  }
};

function normalizeLocatedPlayers(src) {
  if (!Array.isArray(src)) return [];
  const out = [];

  for (const item of src) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    const rowBox = normalizeBox(item.rowBox, 150, 8);
    if (name && rowBox) out.push({ name, rowBox });
  }

  return out.slice(0, 5);
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
    throw new Error('The geometry locator returned an unreadable response.');
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
