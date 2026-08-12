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
        ocrMode: 'grid-derived-geometry-v5.9'
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

    // Step 4: derive actual score grid geometry from the normalized card.
    // No score transcription; only boundaries and player names.
    const gridPrompt = `
GEOMETRY ONLY. Do not read any handwritten score digits.

This is a normalized upright Colonial Golf Club scorecard.

Locate the MAIN handwritten player score grid ABOVE the printed PAR row.

Return:
1) the four horizontal player-row bands, top-to-bottom;
2) the handwritten player names for those rows;
3) the 18 hole-column centers, left-to-right, EXCLUDING the OUT and IN/TOTAL columns.

Use the actual printed grid lines on THIS image.

Important:
- Do not use printed handicap or par rows.
- Do not include OUT between holes 9 and 10.
- Do not include IN/TOT/HCP/NET after hole 18.
- The player rows must correspond to the four handwritten player rows above PAR.

Coordinates are normalized integers 0-1000 relative to THIS normalized card.

Return JSON only:
{
  "playerRows":[
    {"name":"string","top":0,"bottom":0},
    {"name":"string","top":0,"bottom":0},
    {"name":"string","top":0,"bottom":0},
    {"name":"string","top":0,"bottom":0}
  ],
  "holeCenters":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
}
`;

    const gridText = extractOutputText(
      await callVision(apiKey, gridPrompt, cardDataUrl, 1100)
    );
    debug.gridGeometryPass = gridText;

    const gridParsed = parseJson(gridText);
    const rows = normalizeRows(gridParsed?.playerRows);
    const holeCenters = normalizeCenters(gridParsed?.holeCenters);

    debug.grid = {
      rows,
      holeCenters
    };

    if (rows.length !== 4 || holeCenters.length !== 18) {
      return reply(200, {
        players: [],
        debug,
        warning: `Grid geometry incomplete: ${rows.length} player rows, ${holeCenters.length} hole centers.`,
        ocrMode: 'grid-derived-geometry-v5.9'
      });
    }

    // Step 5: crop exactly one cell per actual row/column intersection.
    const cropW = 62;
    const players = [];

    for (let pIndex = 0; pIndex < rows.length; pIndex++) {
      const row = rows[pIndex];
      const rowTop = Math.round(row.top / 1000 * NORMALIZED_HEIGHT);
      const rowBottom = Math.round(row.bottom / 1000 * NORMALIZED_HEIGHT);
      const rowCenterY = Math.round((rowTop + rowBottom) / 2);

      const rowHeight = Math.max(36, rowBottom - rowTop);
      const cropH = Math.max(42, Math.min(76, Math.round(rowHeight * 0.92)));

      const cells = [];

      for (let h = 0; h < 18; h++) {
        const cx = Math.round(holeCenters[h] / 1000 * NORMALIZED_WIDTH);

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

      debug.templateRows.push({
        name: row.name || `Player ${pIndex + 1}`,
        playerIndex: pIndex + 1,
        rowTop,
        rowBottom,
        rowCenterY,
        cropW,
        cropH,
        cells
      });

      players.push({
        name: row.name || `Player ${pIndex + 1}`,
        scores: Array(18).fill(null),
        uncertainHoles: Array.from({ length: 18 }, (_, i) => i + 1)
      });
    }

    return reply(200, {
      players,
      debug,
      ocrMode: 'grid-derived-geometry-v5.9'
    });

  } catch (error) {
    console.error('v5.9 grid-derived geometry failure:', error);
    return reply(500, {
      error: error?.message || 'Grid-derived geometry diagnostic failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'grid-derived-geometry-v5.9'
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

function normalizeCenters(src) {
  if (!Array.isArray(src)) return [];

  const centers = src
    .map(Number)
    .filter(v => Number.isFinite(v) && v >= 0 && v <= 1000);

  if (centers.length !== 18) return [];

  for (let i = 1; i < centers.length; i++) {
    if (centers[i] <= centers[i - 1]) return [];
  }

  return centers;
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
