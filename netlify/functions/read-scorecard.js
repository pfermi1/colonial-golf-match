const sharp = require('sharp');

const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini';

// Fixed Colonial scorecard geometry after the physical card is isolated and
// normalized to landscape. These values come from the known Colonial card
// template and intentionally do not depend on OCR/model-discovered grid lines.
const GEOMETRY = {
  front: [0.142, 0.486],
  back: [0.516, 0.846],
  name: [0.000, 0.142],
  // Five physical player rows between the first HANDICAP row and PAR row.
  rows: [
    [0.389, 0.430],
    [0.430, 0.471],
    [0.471, 0.512],
    [0.512, 0.553],
    [0.553, 0.594]
  ]
};

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed.' });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return reply(500, { error: 'OPENAI_API_KEY is not configured in Netlify.' });

  try {
    const body = JSON.parse(event.body || '{}');
    const { imageDataUrl, expectedPlayers } = body;
    if (!imageDataUrl || !/^data:image\//.test(imageDataUrl)) {
      return reply(400, { error: 'A scorecard image is required.' });
    }

    const playerCount = [4, 5].includes(Number(expectedPlayers)) ? Number(expectedPlayers) : 4;
    const originalBuffer = dataUrlToBuffer(imageDataUrl);

    // v1.3 deliberately removes template-string/grid-coordinate discovery.
    // The software first isolates the bright physical card, rotates it to
    // landscape, then uses fixed Colonial cell coordinates.
    let cardBuffer = await normalizeAndFindCard(originalBuffer);
    cardBuffer = await orientCardSafely(apiKey, cardBuffer);

    const cardMeta = await sharp(cardBuffer, { failOn: 'none' }).metadata();
    if (!cardMeta.width || !cardMeta.height) throw new Error('Could not prepare the scorecard image.');

    const nameImages = [];
    for (let i = 0; i < playerCount; i++) {
      nameImages.push(await cropNameCell(cardBuffer, GEOMETRY.rows[i], cardMeta.width, cardMeta.height));
    }
    const names = await readNamesSafely(apiKey, nameImages, playerCount);

    const players = [];
    for (let playerIndex = 0; playerIndex < playerCount; playerIndex++) {
      const row = GEOMETRY.rows[playerIndex];
      const frontCells = await makeFixedCells(cardBuffer, GEOMETRY.front, row, cardMeta.width, cardMeta.height);
      const backCells = await makeFixedCells(cardBuffer, GEOMETRY.back, row, cardMeta.width, cardMeta.height);

      // Each side is independent. If one side cannot be parsed, only those nine
      // holes become blank/highlighted instead of aborting the whole scorecard.
      const [front, back] = await Promise.all([
        readNineCellsSafely(apiKey, frontCells, 1),
        readNineCellsSafely(apiKey, backCells, 10)
      ]);

      const scores = [...front.scores, ...back.scores];
      const uncertainHoles = [...new Set([...front.uncertainHoles, ...back.uncertainHoles])];
      scores.forEach((score, index) => {
        if (score === 1 && !uncertainHoles.includes(index + 1)) uncertainHoles.push(index + 1);
        if (score == null && !uncertainHoles.includes(index + 1)) uncertainHoles.push(index + 1);
      });
      uncertainHoles.sort((a, b) => a - b);

      players.push({
        name: names[playerIndex] || `Player ${playerIndex + 1}`,
        scores,
        uncertainHoles
      });
    }

    return reply(200, {
      players,
      ocrMode: 'colonial-fixed-template-v1.3',
      warning: players.some(p => p.uncertainHoles.length)
        ? 'Please review the highlighted holes. Unclear cells were left blank rather than shifted or invented.'
        : undefined
    });
  } catch (error) {
    console.error(error);
    return reply(500, { error: friendlyError(error) });
  }
};

async function normalizeAndFindCard(buffer) {
  let img = sharp(buffer, { failOn: 'none' }).rotate();
  let meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error('Could not open the uploaded photo.');

  // Put the photo into landscape first. The later orientation check only needs
  // to decide between right-side-up and upside-down.
  if (meta.height > meta.width) img = img.rotate(90);
  let landscape = await img.jpeg({ quality: 95 }).toBuffer();

  // Find the physical scorecard from brightness. This avoids asking the model
  // to return coordinate strings. The scorecard is a large light rectangle in
  // typical cart/table/laptop photos.
  const box = await detectBrightCardBox(landscape);
  if (box) {
    try {
      landscape = await sharp(landscape, { failOn: 'none' })
        .extract(box)
        .resize({ width: 2800, height: 1700, fit: 'fill' })
        .sharpen()
        .jpeg({ quality: 96 })
        .toBuffer();
      return landscape;
    } catch (error) {
      console.warn('Bright-card crop skipped:', error.message);
    }
  }

  // Never stop the scan because card isolation was imperfect.
  return sharp(landscape, { failOn: 'none' })
    .resize({ width: 2800, height: 1700, fit: 'inside', background: '#ffffff' })
    .flatten({ background: '#ffffff' })
    .sharpen()
    .jpeg({ quality: 96 })
    .toBuffer();
}

async function detectBrightCardBox(buffer) {
  const preview = sharp(buffer, { failOn: 'none' }).resize({ width: 700 }).grayscale();
  const { data, info } = await preview.raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  if (!width || !height) return null;

  // Ignore a small outside margin, then count bright pixels per row/column.
  const threshold = 150;
  const colCounts = new Array(width).fill(0);
  const rowCounts = new Array(height).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x];
      if (v >= threshold) {
        colCounts[x]++;
        rowCounts[y]++;
      }
    }
  }

  const xCandidates = colCounts
    .map((count, x) => ({ x, count }))
    .filter(v => v.count > height * 0.22)
    .map(v => v.x);
  const yCandidates = rowCounts
    .map((count, y) => ({ y, count }))
    .filter(v => v.count > width * 0.30)
    .map(v => v.y);

  if (!xCandidates.length || !yCandidates.length) return null;
  let x1 = Math.max(0, Math.min(...xCandidates) - 8);
  let x2 = Math.min(width - 1, Math.max(...xCandidates) + 8);
  let y1 = Math.max(0, Math.min(...yCandidates) - 8);
  let y2 = Math.min(height - 1, Math.max(...yCandidates) + 8);

  // Reject implausibly small boxes; the full image fallback is safer.
  if ((x2 - x1) < width * 0.45 || (y2 - y1) < height * 0.28) return null;

  const fullMeta = await sharp(buffer, { failOn: 'none' }).metadata();
  if (!fullMeta.width || !fullMeta.height) return null;
  const sx = fullMeta.width / width;
  const sy = fullMeta.height / height;
  const left = clamp(Math.floor(x1 * sx), 0, fullMeta.width - 2);
  const top = clamp(Math.floor(y1 * sy), 0, fullMeta.height - 2);
  const right = clamp(Math.ceil((x2 + 1) * sx), left + 2, fullMeta.width);
  const bottom = clamp(Math.ceil((y2 + 1) * sy), top + 2, fullMeta.height);
  return { left, top, width: right - left, height: bottom - top };
}

async function orientCardSafely(apiKey, cardBuffer) {
  const cardUrl = await bufferToDataUrl(cardBuffer);
  try {
    const raw = await callVision(apiKey, [{
      type: 'input_text',
      text: 'This is a Colonial golf scorecard already cropped to landscape. Is it upside down? Return ONLY JSON: {"rotate":0} or {"rotate":180}. The correct orientation has HOLE then holes 1-9 on the left and holes 10-18 on the right, with player rows below the first HANDICAP row.'
    }, {
      type: 'input_image', image_url: cardUrl, detail: 'low'
    }], 120);
    const parsed = parseJson(extractOutputText(raw));
    if (Number(parsed.rotate) === 180) {
      return sharp(cardBuffer, { failOn: 'none' }).rotate(180).jpeg({ quality: 96 }).toBuffer();
    }
  } catch (error) {
    // Orientation uncertainty must never block the card. Most user photos are
    // already right-side-up after EXIF normalization.
    console.warn('180-degree orientation check skipped:', error.message);
  }
  return cardBuffer;
}

async function cropNameCell(buffer, rowRange, width, height) {
  const left = Math.floor(GEOMETRY.name[0] * width);
  const right = Math.ceil(GEOMETRY.name[1] * width);
  const top = Math.max(0, Math.floor(rowRange[0] * height) - 6);
  const bottom = Math.min(height, Math.ceil(rowRange[1] * height) + 6);
  const crop = await sharp(buffer, { failOn: 'none' })
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize({ width: 700, height: 260, fit: 'contain', background: '#ffffff' })
    .grayscale()
    .normalize()
    .sharpen()
    .jpeg({ quality: 96 })
    .toBuffer();
  return `data:image/jpeg;base64,${crop.toString('base64')}`;
}

async function readNamesSafely(apiKey, images, count) {
  const content = [{
    type: 'input_text',
    text: `Read the handwritten golfer name from each separate image, top-to-bottom. Return ONLY JSON exactly like {"names":["Paul","Steve","Dec","Craig"]}. Exactly ${count} names. If a name is unclear, return "Player N" for that position. Do not read scores.`
  }];
  images.forEach((image, i) => {
    content.push({ type: 'input_text', text: `Player ${i + 1} name cell` });
    content.push({ type: 'input_image', image_url: image, detail: 'high' });
  });
  try {
    const raw = await callVision(apiKey, content, 350);
    const parsed = parseJson(extractOutputText(raw));
    if (!Array.isArray(parsed.names) || parsed.names.length !== count) throw new Error('Name count mismatch.');
    return parsed.names.map((name, i) => String(name || '').trim() || `Player ${i + 1}`);
  } catch (error) {
    console.warn('Name OCR skipped:', error.message);
    return Array.from({ length: count }, (_, i) => `Player ${i + 1}`);
  }
}

async function makeFixedCells(sourceBuffer, xRange, yRange, imageWidth, imageHeight) {
  const leftPx = Math.round(xRange[0] * imageWidth);
  const rightPx = Math.round(xRange[1] * imageWidth);
  const rowTop = Math.round(yRange[0] * imageHeight);
  const rowBottom = Math.round(yRange[1] * imageHeight);
  const totalWidth = rightPx - leftPx;
  const rowHeight = rowBottom - rowTop;
  if (totalWidth < 180 || rowHeight < 10) throw new Error('Fixed score-cell geometry was not usable.');

  const images = [];
  for (let cell = 0; cell < 9; cell++) {
    const rawLeft = leftPx + totalWidth * cell / 9;
    const rawRight = leftPx + totalWidth * (cell + 1) / 9;
    const cellWidth = rawRight - rawLeft;
    const insetX = Math.max(2, Math.round(cellWidth * 0.06));
    const verticalPad = Math.max(2, Math.round(rowHeight * 0.12));
    const left = clamp(Math.round(rawLeft) + insetX, 0, imageWidth - 2);
    const right = clamp(Math.round(rawRight) - insetX, left + 2, imageWidth);
    const top = clamp(rowTop - verticalPad, 0, imageHeight - 2);
    const bottom = clamp(rowBottom + verticalPad, top + 2, imageHeight);

    const crop = await sharp(sourceBuffer, { failOn: 'none' })
      .extract({ left, top, width: right - left, height: bottom - top })
      .resize({ width: 420, height: 420, fit: 'contain', background: '#ffffff' })
      .grayscale()
      .normalize()
      .sharpen()
      .jpeg({ quality: 96 })
      .toBuffer();
    images.push(`data:image/jpeg;base64,${crop.toString('base64')}`);
  }
  return images;
}

async function readNineCellsSafely(apiKey, cellImages, firstHole) {
  try {
    const content = [{
      type: 'input_text',
      text: `Read nine SEPARATE handwritten golf-score cell images, one image per physical hole, in order for holes ${firstHole}-${firstHole + 8}. Valid individual scores are 1 through 7. Return ONLY JSON exactly like {"scores":[6,5,6,4,5,4,5,4,5],"uncertain":[4]}. Exactly 9 entries. Use null if a cell is unclear. Never shift a score to a neighboring hole. Never invent a missing final-hole score. A 1 is possible but rare and must be listed uncertain.`
    }];
    cellImages.forEach((image, i) => {
      content.push({ type: 'input_text', text: `Hole ${firstHole + i} ONLY` });
      content.push({ type: 'input_image', image_url: image, detail: 'high' });
    });

    const raw = await callVision(apiKey, content, 800);
    const parsed = parseJson(extractOutputText(raw));
    if (!Array.isArray(parsed.scores) || parsed.scores.length !== 9) throw new Error('Nine-cell response length mismatch.');

    const uncertain = new Set(Array.isArray(parsed.uncertain) ? parsed.uncertain.map(Number) : []);
    const scores = parsed.scores.map((value, index) => {
      if (value == null || value === '') {
        uncertain.add(index + 1);
        return null;
      }
      const score = Number(value);
      if (!Number.isInteger(score) || score < 1 || score > 7) {
        uncertain.add(index + 1);
        return null;
      }
      if (score === 1) uncertain.add(index + 1);
      return score;
    });
    return {
      scores,
      uncertainHoles: [...uncertain]
        .filter(n => Number.isInteger(n) && n >= 1 && n <= 9)
        .map(n => firstHole + n - 1)
    };
  } catch (error) {
    console.warn(`Holes ${firstHole}-${firstHole + 8} OCR failed; leaving blank for review:`, error.message);
    return {
      scores: Array(9).fill(null),
      uncertainHoles: Array.from({ length: 9 }, (_, i) => firstHole + i)
    };
  }
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

async function bufferToDataUrl(buffer) {
  const jpeg = await sharp(buffer, { failOn: 'none' }).jpeg({ quality: 94 }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

function dataUrlToBuffer(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Invalid scorecard image data.');
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
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
  const cleaned = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The AI response did not contain usable JSON.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function friendlyError(error) {
  const message = String(error?.message || 'Unable to read this scorecard.');
  if (/string did not match|expected pattern/i.test(message)) {
    return 'The scan could not complete, but this is no longer a photo-alignment requirement. Please try once more; if it repeats, the function log will identify the exact failing step.';
  }
  return message;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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
