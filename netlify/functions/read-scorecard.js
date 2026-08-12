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

    // One vision call only: locate player-name row and approximate score span.
    const geometry = await locateFirstPlayerRowByName(apiKey, normalizedDataUrl);

    if (!geometry.front || !geometry.back || !geometry.nameBox) {
      return reply(200, {
        ocrMode: 'grid-line-geometry-v2.7',
        playerName: geometry.name || '',
        message: 'Could not confidently locate the first handwritten player row.',
        debug: { geometry, cells: [], gridLines: [] }
      });
    }

    // Build one wide strip covering Hole 1 through Hole 18 on Paul's row.
    const leftNorm = geometry.front.left;
    const rightNorm = geometry.back.right;
    const topNorm = Math.min(geometry.front.top, geometry.back.top);
    const bottomNorm = Math.max(geometry.front.bottom, geometry.back.bottom);

    const rowStrip = await extractNormalizedBox(normalizedBuffer, width, height, {
      left: leftNorm,
      top: topNorm,
      right: rightNorm,
      bottom: bottomNorm
    });

    // Detect vertical printed grid lines from image pixels, not equal-width math.
    const grid = await detectVerticalGridLines(rowStrip);

    if (!grid || grid.lines.length < 19) {
      return reply(200, {
        ocrMode: 'grid-line-geometry-v2.7',
        playerName: geometry.name || '',
        message: 'Could not detect enough vertical score-grid lines for 18 holes.',
        debug: {
          geometry,
          gridLines: grid?.lines || [],
          cells: []
        }
      });
    }

    const cells = await cropCellsBetweenGridLines(rowStrip, grid.lines);

    return reply(200, {
      ocrMode: 'grid-line-geometry-v2.7',
      playerName: geometry.name || '',
      debug: {
        geometry,
        gridLines: grid.lines,
        gridStrengths: grid.strengths,
        cells
      }
    });
  } catch (error) {
    console.error('v2.7 geometry failure:', error);
    return reply(500, {
      error: error?.message || 'Grid-line geometry diagnostic failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'grid-line-geometry-v2.7'
    });
  }
};

async function locateFirstPlayerRowByName(apiKey, imageDataUrl) {
  const prompt = `
Geometry-only task on a photographed Colonial Golf Club scorecard.

Preferred orientation:
- Hole 1 is at the left.
- Hole 18 is at the right.
- handwritten player names are at the left of their score rows.
- player score rows are below the printed HANDICAP row and above the printed PAR row.

Find the FIRST handwritten player name that has handwritten scores on the same row.

Return:
- name: handwritten player name
- nameBox: tight box around handwritten name
- front: approximate box spanning that player's handwritten Hole 1-9 score area
- back: approximate box spanning that same player's handwritten Hole 10-18 score area

CRITICAL:
- nameBox, front and back must share the same vertical handwritten row.
- Do not select blank rows above/below.
- Do not select the printed HANDICAP row or PAR row.
- Do not select OUT, IN, TOT, HCP, NET, yardages, table, knee or background.
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

  // Force the score bands onto the vertical centerline of the handwritten name.
  const nameCenter = (nameBox.top + nameBox.bottom) / 2;
  const frontHeight = front.bottom - front.top;
  const backHeight = back.bottom - back.top;
  const rowHeight = Math.max(16, Math.min(64, (frontHeight + backHeight) / 2));

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

  if (!(front.left < back.left)) {
    return { name, nameBox, front: null, back: null };
  }

  return { name, nameBox, front, back };
}

async function detectVerticalGridLines(rowBuffer) {
  // Convert to grayscale raw pixels.
  const { data, info } = await sharp(rowBuffer)
    .grayscale()
    .normalize()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  if (!width || !height || width < 180) return null;

  // Vertical grid lines are dark and extend through most of the short row strip.
  // Score handwriting is dark too, but only occupies a small portion of height.
  const darkThreshold = 150;
  const scores = new Array(width).fill(0);

  for (let x = 0; x < width; x++) {
    let darkCount = 0;
    let transitionCount = 0;
    let prev = data[x];
    for (let y = 0; y < height; y++) {
      const v = data[y * width + x];
      if (v < darkThreshold) darkCount++;
      if (y > 0 && Math.abs(v - prev) > 45) transitionCount++;
      prev = v;
    }
    // Reward persistent dark vertical content; slight reward for edge continuity.
    scores[x] = (darkCount / height) + 0.05 * (transitionCount / Math.max(1, height - 1));
  }

  // Smooth horizontally to merge 1-3 pixel line widths.
  const smooth = new Array(width).fill(0);
  const radius = 2;
  for (let x = 0; x < width; x++) {
    let sum = 0, n = 0;
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx;
      if (xx >= 0 && xx < width) {
        sum += scores[xx];
        n++;
      }
    }
    smooth[x] = sum / n;
  }

  // Find local peaks above a conservative threshold.
  const peaks = [];
  const minPeak = 0.42;
  for (let x = 2; x < width - 2; x++) {
    if (smooth[x] >= minPeak &&
        smooth[x] >= smooth[x - 1] &&
        smooth[x] >= smooth[x + 1]) {
      peaks.push({ x, strength: smooth[x] });
    }
  }

  // Collapse nearby peaks into single line centers.
  const clustered = [];
  for (const p of peaks) {
    const last = clustered[clustered.length - 1];
    if (!last || p.x - last.x > 6) {
      clustered.push({ x: p.x, strength: p.strength });
    } else if (p.strength > last.strength) {
      clustered[clustered.length - 1] = { x: p.x, strength: p.strength };
    }
  }

  // Estimate normal hole-cell spacing using robust differences between peaks.
  const diffs = [];
  for (let i = 1; i < clustered.length; i++) {
    const d = clustered[i].x - clustered[i - 1].x;
    if (d >= 10 && d <= width / 6) diffs.push(d);
  }
  diffs.sort((a, b) => a - b);
  const median = diffs.length ? diffs[Math.floor(diffs.length / 2)] : width / 18;

  // Select a 19-line sequence (boundaries for 18 cells) with near-regular spacing.
  let best = null;
  const expected = median || width / 18;
  const tolerance = Math.max(8, expected * 0.38);

  for (let start = 0; start < clustered.length; start++) {
    const seq = [clustered[start]];
    let currentX = clustered[start].x;

    for (let hole = 1; hole < 19; hole++) {
      const target = currentX + expected;
      let candidate = null;
      let bestCost = Infinity;

      for (const p of clustered) {
        if (p.x <= currentX + 5) continue;
        const cost = Math.abs(p.x - target) - p.strength * 8;
        if (Math.abs(p.x - target) <= tolerance && cost < bestCost) {
          candidate = p;
          bestCost = cost;
        }
      }

      if (!candidate) break;
      seq.push(candidate);
      currentX = candidate.x;
    }

    if (seq.length >= 19) {
      const span = seq[18].x - seq[0].x;
      const spacingErrors = [];
      for (let i = 1; i < 19; i++) {
        spacingErrors.push(Math.abs((seq[i].x - seq[i-1].x) - expected));
      }
      const error = spacingErrors.reduce((a,b)=>a+b,0) / spacingErrors.length;
      const strength = seq.reduce((a,b)=>a+b.strength,0) / seq.length;
      const cost = error - strength * 4 - span / width;
      if (!best || cost < best.cost) best = { seq, cost };
    }
  }

  // Fallback: if exact sequence not found, infer 19 boundaries from strongest endpoints.
  let lines;
  let strengths;
  if (best) {
    lines = best.seq.slice(0, 19).map(p => p.x);
    strengths = best.seq.slice(0, 19).map(p => Number(p.strength.toFixed(3)));
  } else {
    // Find a plausible left/right extent from dense peak region and interpolate.
    if (clustered.length < 2) return { lines: [], strengths: [] };
    const left = clustered[0].x;
    const right = clustered[clustered.length - 1].x;
    if (right - left < width * 0.55) return { lines: [], strengths: [] };

    lines = Array.from({ length: 19 }, (_, i) =>
      Math.round(left + (right - left) * i / 18)
    );
    strengths = lines.map(() => 0);
  }

  return { lines, strengths };
}

async function cropCellsBetweenGridLines(rowBuffer, lines) {
  const meta = await sharp(rowBuffer).metadata();
  const width = meta.width;
  const height = meta.height;
  const cells = [];

  for (let i = 0; i < 18; i++) {
    const hole = i + 1;
    const x0 = clamp(Math.floor(lines[i]), 0, width - 1);
    const x1 = clamp(Math.ceil(lines[i + 1]), x0 + 1, width);

    // Trim a few pixels off the detected grid lines.
    const trimX = Math.max(1, Math.floor((x1 - x0) * 0.06));
    const trimY = Math.max(1, Math.floor(height * 0.04));

    const left = clamp(x0 + trimX, 0, width - 1);
    const top = clamp(trimY, 0, height - 1);
    const cellWidth = Math.max(1, Math.min(width - left, (x1 - x0) - trimX * 2));
    const cellHeight = Math.max(1, Math.min(height - top, height - trimY * 2));

    const cellBuffer = await sharp(rowBuffer)
      .extract({ left, top, width: cellWidth, height: cellHeight })
      .resize({ width: 240, height: 180, fit: 'contain', background: '#ffffff' })
      .jpeg({ quality: 92 })
      .toBuffer();

    cells.push({
      hole,
      imageDataUrl: `data:image/jpeg;base64,${cellBuffer.toString('base64')}`
    });
  }

  return cells;
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
