const sharp = require('sharp');

const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1';

// Fixed normalized Colonial hole centers on the STRAIGHTENED card.
// The perspective warp makes these independent of phone framing/skew.
const HOLE_X_RATIOS = [
  0.121, 0.155, 0.189, 0.223, 0.257, 0.291, 0.325, 0.359, 0.393,
  0.515, 0.549, 0.583, 0.617, 0.651, 0.685, 0.719, 0.753, 0.787
];

const WARP_WIDTH = 1800;
const WARP_HEIGHT = 1050;

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

    // Normalize EXIF orientation first.
    const normalizedBuffer = await sharp(inputBuffer)
      .rotate()
      .resize({ width: 2200, height: 2200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();

    const meta = await sharp(normalizedBuffer).metadata();
    const srcWidth = meta.width;
    const srcHeight = meta.height;
    const normalizedDataUrl = `data:image/jpeg;base64,${normalizedBuffer.toString('base64')}`;

    // ONE vision call:
    // locate four physical card corners + first handwritten player-name box.
    const geometry = await locateCardCornersAndPlayerName(apiKey, normalizedDataUrl);

    if (!geometry.corners || !geometry.nameBox) {
      return reply(200, {
        ocrMode: 'perspective-template-calibrated-v3.7',
        playerName: geometry.name || '',
        message: 'Could not confidently locate all four card corners and the first player name.',
        debug: { geometry, cells: [] }
      });
    }

    // Convert source normalized coordinates to pixels.
    const srcCorners = {
      tl: normPointToPixel(geometry.corners.tl, srcWidth, srcHeight),
      tr: normPointToPixel(geometry.corners.tr, srcWidth, srcHeight),
      br: normPointToPixel(geometry.corners.br, srcWidth, srcHeight),
      bl: normPointToPixel(geometry.corners.bl, srcWidth, srcHeight)
    };

    // Perspective-warp card into a fixed rectangle.
    const warp = await perspectiveWarp(
      normalizedBuffer,
      srcWidth,
      srcHeight,
      srcCorners,
      WARP_WIDTH,
      WARP_HEIGHT
    );

    // Transform the detected handwritten-name center into the straightened card.
    const nameCenterSrc = normPointToPixel({
      x: (geometry.nameBox.left + geometry.nameBox.right) / 2,
      y: (geometry.nameBox.top + geometry.nameBox.bottom) / 2
    }, srcWidth, srcHeight);

    const nameCenterWarp = applyHomography(warp.srcToDstH, nameCenterSrc.x, nameCenterSrc.y);

    // v3.7 key change:
    // Once the physical card is perspective-normalized, stop deriving the first-player
    // score-row Y from the photo. Use a fixed Colonial-template Y instead.
    // v3.6 consistently hit the printed PAR row, so move to the known first-player band
    // on the normalized card.
    const transformedNameCenterY = clamp(Math.round(nameCenterWarp.y), 0, WARP_HEIGHT - 1);

    // Fixed first-player row center on normalized 1800x1050 Colonial card.
    // Calibrated from the controlled card image: above PAR, below HANDICAP.
    const FIRST_PLAYER_Y_RATIO = 0.335;
    const rowCenterY = Math.round(FIRST_PLAYER_Y_RATIO * WARP_HEIGHT);

    const rowCropHeight = 50;
    const rowTop = clamp(Math.round(rowCenterY - rowCropHeight / 2), 0, WARP_HEIGHT - 2);
    const rowBottom = clamp(rowTop + rowCropHeight, rowTop + 1, WARP_HEIGHT);

    // Determine normal hole width from the straightened template.
    const normalSpacing = Math.round(0.034 * WARP_WIDTH);
    const cropWidth = Math.max(34, Math.round(normalSpacing * 0.78));

    const cells = [];

    for (let i = 0; i < 18; i++) {
      const hole = i + 1;
      const cx = Math.round(HOLE_X_RATIOS[i] * WARP_WIDTH);
      const halfW = Math.floor(cropWidth / 2);

      const left = clamp(cx - halfW, 0, WARP_WIDTH - 1);
      const right = clamp(cx + halfW, left + 1, WARP_WIDTH);

      const cellBuffer = await sharp(warp.buffer)
        .extract({
          left,
          top: rowTop,
          width: Math.max(1, right - left),
          height: Math.max(1, rowBottom - rowTop)
        })
        .resize({ width: 240, height: 180, fit: 'contain', background: '#ffffff' })
        .jpeg({ quality: 94 })
        .toBuffer();

      cells.push({
        hole,
        xRatio: HOLE_X_RATIOS[i],
        imageDataUrl: `data:image/jpeg;base64,${cellBuffer.toString('base64')}`
      });
    }

    // Include a small straightened-card preview for debugging.
    const preview = await sharp(warp.buffer)
      .resize({ width: 900 })
      .jpeg({ quality: 82 })
      .toBuffer();

    return reply(200, {
      ocrMode: 'perspective-template-calibrated-v3.7',
      playerName: geometry.name || '',
      debug: {
        geometry,
        transformedNameCenterY,
        firstPlayerYRatio: 0.335,
        rowCenterY,
        rowCropHeight,
        cropWidth,
        warpSize: { width: WARP_WIDTH, height: WARP_HEIGHT },
        straightenedCardDataUrl: `data:image/jpeg;base64,${preview.toString('base64')}`,
        cells
      }
    });
  } catch (error) {
    console.error('v3.7 template-calibration failure:', error);
    return reply(500, {
      error: error?.message || 'v3.7 template-calibration diagnostic failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'perspective-template-calibrated-v3.7'
    });
  }
};

async function locateCardCornersAndPlayerName(apiKey, imageDataUrl) {
  const prompt = `
GEOMETRY-ONLY task on ONE photographed Colonial Golf Club scorecard.

Do NOT transcribe score digits.

Find the FOUR OUTER PHYSICAL CORNERS of the scorecard itself:
- tl = top-left corner
- tr = top-right corner
- br = bottom-right corner
- bl = bottom-left corner

Also find the FIRST handwritten player name above the printed PAR row that has handwritten scores on the same row.

Return:
- name
- corners as normalized points 0-1000 relative to the full photo
- nameBox as a tight normalized box around only the handwritten player name

CRITICAL:
- Corners must follow the actual blue/white physical card edges, not the keyboard/table/knee/background.
- Keep corner order exactly tl, tr, br, bl.
- nameBox must surround handwritten player letters only.
- Do not return the score row as nameBox.
- Do not use printed HANDICAP/PAR labels.

Return JSON only:
{
  "name":"",
  "corners":{
    "tl":{"x":0,"y":0},
    "tr":{"x":0,"y":0},
    "br":{"x":0,"y":0},
    "bl":{"x":0,"y":0}
  },
  "nameBox":{"left":0,"top":0,"right":0,"bottom":0}
}`;

  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
  ], 650);

  const parsed = parseJson(extractOutputText(raw));
  const name = String(parsed?.name || '').trim();
  const nameBox = normalizeBox(parsed?.nameBox, 20, 8);
  const corners = normalizeCorners(parsed?.corners);

  return { name, corners, nameBox };
}

async function perspectiveWarp(srcBuffer, srcWidth, srcHeight, srcCorners, dstWidth, dstHeight) {
  const dstCorners = {
    tl: { x: 0, y: 0 },
    tr: { x: dstWidth - 1, y: 0 },
    br: { x: dstWidth - 1, y: dstHeight - 1 },
    bl: { x: 0, y: dstHeight - 1 }
  };

  // Homographies both directions.
  const srcToDstH = computeHomography(
    [srcCorners.tl, srcCorners.tr, srcCorners.br, srcCorners.bl],
    [dstCorners.tl, dstCorners.tr, dstCorners.br, dstCorners.bl]
  );
  const dstToSrcH = computeHomography(
    [dstCorners.tl, dstCorners.tr, dstCorners.br, dstCorners.bl],
    [srcCorners.tl, srcCorners.tr, srcCorners.br, srcCorners.bl]
  );

  // Decode source to raw RGB.
  const { data: srcRaw, info } = await sharp(srcBuffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const out = Buffer.alloc(dstWidth * dstHeight * 3, 255);

  // Bilinear inverse mapping.
  for (let y = 0; y < dstHeight; y++) {
    for (let x = 0; x < dstWidth; x++) {
      const p = applyHomography(dstToSrcH, x, y);
      const sx = p.x;
      const sy = p.y;

      if (sx < 0 || sy < 0 || sx >= srcWidth - 1 || sy >= srcHeight - 1) continue;

      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = x0 + 1, y1 = y0 + 1;
      const dx = sx - x0, dy = sy - y0;

      for (let c = 0; c < 3; c++) {
        const p00 = srcRaw[(y0 * srcWidth + x0) * channels + c];
        const p10 = srcRaw[(y0 * srcWidth + x1) * channels + c];
        const p01 = srcRaw[(y1 * srcWidth + x0) * channels + c];
        const p11 = srcRaw[(y1 * srcWidth + x1) * channels + c];

        const top = p00 * (1 - dx) + p10 * dx;
        const bot = p01 * (1 - dx) + p11 * dx;
        out[(y * dstWidth + x) * 3 + c] = Math.round(top * (1 - dy) + bot * dy);
      }
    }
  }

  const warpedBuffer = await sharp(out, {
    raw: { width: dstWidth, height: dstHeight, channels: 3 }
  }).jpeg({ quality: 94 }).toBuffer();

  return { buffer: warpedBuffer, srcToDstH, dstToSrcH };
}

function computeHomography(src, dst) {
  // Solve 8 unknowns with h33 fixed to 1.
  const A = [];
  const b = [];

  for (let i = 0; i < 4; i++) {
    const x = src[i].x, y = src[i].y;
    const u = dst[i].x, v = dst[i].y;

    A.push([x, y, 1, 0, 0, 0, -u*x, -u*y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v*x, -v*y]);
    b.push(v);
  }

  const h = solveLinearSystem(A, b);
  return [
    h[0], h[1], h[2],
    h[3], h[4], h[5],
    h[6], h[7], 1
  ];
}

function solveLinearSystem(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-10) throw new Error('Perspective transform is singular.');

    [M[col], M[pivot]] = [M[pivot], M[col]];

    const div = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= div;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }

  return M.map(row => row[n]);
}

function applyHomography(H, x, y) {
  const d = H[6]*x + H[7]*y + H[8];
  return {
    x: (H[0]*x + H[1]*y + H[2]) / d,
    y: (H[3]*x + H[4]*y + H[5]) / d
  };
}

function normalizeCorners(corners) {
  if (!corners || typeof corners !== 'object') return null;
  const keys = ['tl','tr','br','bl'];
  const out = {};

  for (const k of keys) {
    const p = corners[k];
    if (!p) return null;
    const x = Number(p.x), y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < 0 || x > 1000 || y < 0 || y > 1000) return null;
    out[k] = { x, y };
  }

  // Basic ordering sanity.
  if (!(out.tl.x < out.tr.x && out.bl.x < out.br.x)) return null;
  if (!(out.tl.y < out.bl.y && out.tr.y < out.br.y)) return null;

  return out;
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

function normPointToPixel(p, width, height) {
  return {
    x: clamp(p.x / 1000 * width, 0, width - 1),
    y: clamp(p.y / 1000 * height, 0, height - 1)
  };
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
    throw new Error('The v3.7 geometry locator returned an unreadable response.');
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
