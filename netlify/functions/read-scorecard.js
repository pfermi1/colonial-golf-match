const sharp = require('sharp');

const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini';
const BOX_SCALE = 1000;

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

    // v1.1: first isolate the physical scorecard from background clutter. If the
    // crop cannot be located reliably, continue with the full photo instead of
    // failing the entire scan.
    const cardBuffer = await isolateScorecard(apiKey, imageDataUrl, originalBuffer);
    const cardImage = sharp(cardBuffer, { failOn: 'none' }).rotate();
    const metadata = await cardImage.metadata();
    if (!metadata.width || !metadata.height) throw new Error('Could not determine the scorecard image size.');
    const normalizedCardUrl = await bufferToDataUrl(cardBuffer);

    let layout;
    try {
      layout = await locateGrid(apiKey, normalizedCardUrl, playerCount);
      layout = normalizeGridLayout(layout, playerCount);
    } catch (layoutError) {
      console.warn('Fixed-cell layout failed, using graceful OCR fallback:', layoutError.message);
      const fallback = await readWholeCardFallback(apiKey, normalizedCardUrl, playerCount);
      return reply(200, {
        players: fallback.players,
        ocrMode: 'fallback-review',
        warning: 'The fixed score grid could not be locked cleanly. Please review the highlighted scores.'
      });
    }

    const players = [];
    for (let playerIndex = 0; playerIndex < playerCount; playerIndex++) {
      const item = layout.players[playerIndex];
      const frontBox = rowGridBox(layout.frontGrid, item.row);
      const backBox = rowGridBox(layout.backGrid, item.row);

      const frontCells = await makeNineCellImages(cardBuffer, frontBox, metadata.width, metadata.height);
      const backCells = await makeNineCellImages(cardBuffer, backBox, metadata.width, metadata.height);

      const front = await readNineCells(apiKey, frontCells, 1);
      const back = await readNineCells(apiKey, backCells, 10);

      const scores = [...front.scores, ...back.scores];
      const uncertainHoles = [...new Set([...front.uncertainHoles, ...back.uncertainHoles])];
      scores.forEach((score, index) => {
        if (score === 1 && !uncertainHoles.includes(index + 1)) uncertainHoles.push(index + 1);
      });
      uncertainHoles.sort((a, b) => a - b);

      players.push({
        name: item.name,
        scores,
        uncertainHoles
      });
    }

    return reply(200, { players, ocrMode: 'fixed-cell-v1.1' });
  } catch (error) {
    console.error(error);
    return reply(500, { error: error.message || 'Unable to read this scorecard.' });
  }
};

async function isolateScorecard(apiKey, imageDataUrl, originalBuffer) {
  try {
    const raw = await callVision(apiKey, [{
      type: 'input_text',
      text: `Locate the physical rectangular golf scorecard in this photo. Ignore table, clothing, hands, cart, or background. Return ONLY JSON with normalized 0-1000 coordinates: {"cardBox":[x1,y1,x2,y2]}. Include the complete scorecard edges with a small margin. If an edge is close to the image boundary, use 0 or 1000. No commentary.`
    }, {
      type: 'input_image', image_url: imageDataUrl, detail: 'high'
    }], 500);

    const parsed = parseJson(extractOutputText(raw));
    const image = sharp(originalBuffer, { failOn: 'none' }).rotate();
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) return originalBuffer;
    const safeBox = sanitizeBox(parsed.cardBox, { minWidth: 350, minHeight: 140 });
    if (!safeBox) return originalBuffer;
    const px = boxToPixels(safeBox, metadata.width, metadata.height);
    const width = px.right - px.left;
    const height = px.bottom - px.top;
    if (width < metadata.width * 0.45 || height < metadata.height * 0.15) return originalBuffer;

    return await image
      .extract({ left: px.left, top: px.top, width, height })
      .resize({ width: 2400, withoutEnlargement: false })
      .sharpen()
      .jpeg({ quality: 94 })
      .toBuffer();
  } catch (error) {
    console.warn('Scorecard isolation skipped:', error.message);
    return originalBuffer;
  }
}

async function locateGrid(apiKey, cardDataUrl, playerCount) {
  const prompt = `You are locating the handwritten player-score grid on a cropped Colonial Golf scorecard. The scorecard itself fills most of the image.

There are exactly ${playerCount} handwritten player rows. Return players TOP to BOTTOM.

Instead of locating 8 separate front/back boxes, identify the stable shared geometry:
- frontGrid: [x1,x2] spanning ONLY the nine score columns for holes 1-9 for every player row. Do not include player names or OUT.
- backGrid: [x1,x2] spanning ONLY the nine score columns for holes 10-18 for every player row. Do not include IN/TOT.
- for each player: name and row:[y1,y2] spanning only that player's handwritten score row. The same row y-range is used for both front and back.

All coordinates are normalized integers 0-1000 relative to this cropped scorecard image.

Return ONLY JSON:
{"frontGrid":[120,485],"backGrid":[535,900],"players":[{"name":"Paul","row":[390,440]}]}

Rules:
- Exactly ${playerCount} player objects.
- frontGrid and backGrid are x ranges only.
- Each player row is a y range only.
- Player rows must be top-to-bottom and must not overlap substantially.
- Slightly generous row height is acceptable; do not include another player's row.
- Do not read or return any hole scores in this pass.
- If a coordinate lies very near an image edge, clamp it to 0 or 1000 rather than returning an out-of-range number.
- No markdown or commentary.`;

  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: cardDataUrl, detail: 'high' }
  ], 1300);
  return parseJson(extractOutputText(raw));
}

function normalizeGridLayout(data, expectedPlayers) {
  if (!data || !Array.isArray(data.players) || data.players.length !== expectedPlayers) {
    throw new Error(`Expected ${expectedPlayers} player rows, but the score grid could not be located reliably.`);
  }

  const frontGrid = sanitizeRange(data.frontGrid, 0.16, 'front-nine grid');
  const backGrid = sanitizeRange(data.backGrid, 0.16, 'back-nine grid');
  if (backGrid[0] <= frontGrid[0]) throw new Error('Front and back score grids could not be separated.');

  const players = data.players.map((player, index) => ({
    name: String(player.name || '').trim() || `Player ${index + 1}`,
    row: sanitizeRange(player.row, 0.012, `player ${index + 1} row`)
  }));

  // Be forgiving: lightly clamp and regularize row bands rather than rejecting the
  // whole card because one row coordinate is a few points off.
  const centers = players.map(p => (p.row[0] + p.row[1]) / 2);
  for (let i = 1; i < centers.length; i++) {
    if (centers[i] <= centers[i - 1]) throw new Error('Player rows were not found top-to-bottom.');
  }

  // If a row is abnormally tall/narrow compared with the group, regularize it to
  // the median row height centered on the detected row center.
  const heights = players.map(p => p.row[1] - p.row[0]).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 40;
  players.forEach(player => {
    const height = player.row[1] - player.row[0];
    if (height < medianHeight * 0.55 || height > medianHeight * 1.8) {
      const center = (player.row[0] + player.row[1]) / 2;
      player.row = [clamp(Math.round(center - medianHeight / 2), 0, 998), clamp(Math.round(center + medianHeight / 2), 2, 1000)];
    }
  });

  return { frontGrid, backGrid, players };
}

function rowGridBox(xRange, yRange) {
  return [xRange[0], yRange[0], xRange[1], yRange[1]];
}

function sanitizeRange(value, minimumFraction, label) {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`Could not locate the ${label}.`);
  let a = Number(value[0]);
  let b = Number(value[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`Could not locate the ${label}.`);
  a = clamp(Math.round(a), 0, 1000);
  b = clamp(Math.round(b), 0, 1000);
  if (b < a) [a, b] = [b, a];
  if ((b - a) < BOX_SCALE * minimumFraction) throw new Error(`The ${label} was located too narrowly.`);
  return [a, b];
}

function sanitizeBox(value, options = {}) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  let nums = value.map(Number);
  if (nums.some(n => !Number.isFinite(n))) return null;
  let [x1, y1, x2, y2] = nums.map(n => clamp(Math.round(n), 0, 1000));
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  if ((x2 - x1) < (options.minWidth || 40) || (y2 - y1) < (options.minHeight || 20)) return null;
  return [x1, y1, x2, y2];
}

async function makeNineCellImages(sourceBuffer, box, imageWidth, imageHeight) {
  const safeBox = sanitizeBox(box, { minWidth: 150, minHeight: 10 });
  if (!safeBox) throw new Error('A player score row could not be cropped safely.');
  const px = boxToPixels(safeBox, imageWidth, imageHeight);
  const rowWidth = px.right - px.left;
  const rowHeight = px.bottom - px.top;
  if (rowWidth < 120 || rowHeight < 10) throw new Error('The score grid was located too narrowly.');

  const images = [];
  for (let cell = 0; cell < 9; cell++) {
    const rawLeft = px.left + (rowWidth * cell / 9);
    const rawRight = px.left + (rowWidth * (cell + 1) / 9);
    const cellWidth = rawRight - rawLeft;
    const insetX = Math.max(1, Math.round(cellWidth * 0.05));
    const left = clamp(Math.round(rawLeft) + insetX, 0, imageWidth - 2);
    const right = clamp(Math.round(rawRight) - insetX, left + 2, imageWidth);
    const verticalPad = Math.max(2, Math.round(rowHeight * 0.15));
    const top = clamp(px.top - verticalPad, 0, imageHeight - 2);
    const bottom = clamp(px.bottom + verticalPad, top + 2, imageHeight);

    const crop = await sharp(sourceBuffer, { failOn: 'none' })
      .rotate()
      .extract({ left, top, width: right - left, height: bottom - top })
      .resize({ width: 360, height: 360, fit: 'contain', background: '#ffffff' })
      .sharpen()
      .jpeg({ quality: 94 })
      .toBuffer();

    images.push(`data:image/jpeg;base64,${crop.toString('base64')}`);
  }
  return images;
}

async function readNineCells(apiKey, cellImages, firstHole) {
  const content = [{
    type: 'input_text',
    text: `Read nine SEPARATE handwritten golf-score cell images. Each image is one physical hole box. The images are supplied in order for holes ${firstHole} through ${firstHole + 8}.

For EACH image independently, read only the single handwritten player score in that cell. Ignore printed grid lines or tiny printed text. Valid individual scores for this Colonial group are 1 through 7.

Return ONLY JSON in this exact shape:
{"scores":[6,5,6,4,5,4,5,4,5],"uncertain":[4]}

Rules:
- scores must have exactly 9 entries, one per supplied image in the same order.
- Each entry must be an integer 1-7, or null if the cell cannot be read confidently.
- Do not infer or repair a pattern from neighboring cells.
- Never borrow a digit from another image.
- A 1 is possible but extremely rare; include its position (1-9) in uncertain.
- Put any null or genuinely hard-to-read cell position in uncertain.
- No markdown or commentary.`
  }];

  cellImages.forEach((image, index) => {
    content.push({ type: 'input_text', text: `Cell ${index + 1}; Hole ${firstHole + index}` });
    content.push({ type: 'input_image', image_url: image, detail: 'high' });
  });

  const raw = await callVision(apiKey, content, 900);
  const parsed = parseJson(extractOutputText(raw));
  if (!Array.isArray(parsed.scores) || parsed.scores.length !== 9) {
    throw new Error(`Could not read holes ${firstHole}-${firstHole + 8} as nine separate cells.`);
  }

  const uncertainPositions = new Set(
    Array.isArray(parsed.uncertain)
      ? parsed.uncertain.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 9)
      : []
  );

  const scores = parsed.scores.map((value, index) => {
    if (value === null || value === '' || typeof value === 'undefined') {
      uncertainPositions.add(index + 1);
      return null;
    }
    const score = Number(value);
    if (!Number.isInteger(score) || score < 1 || score > 7) {
      uncertainPositions.add(index + 1);
      return null;
    }
    if (score === 1) uncertainPositions.add(index + 1);
    return score;
  });

  return {
    scores,
    uncertainHoles: [...uncertainPositions].map(position => firstHole + position - 1)
  };
}

async function readWholeCardFallback(apiKey, cardDataUrl, playerCount) {
  const prompt = `Read the handwritten player names and 18 individual hole scores from this Colonial Golf scorecard. There are exactly ${playerCount} player rows, top to bottom. Read each hole by its printed column number, holes 1 through 18. Do not read OUT, IN, TOT, par, handicap, yardage, or betting rows.

Return ONLY JSON:
{"players":[{"name":"Paul","holes":{"1":5,"2":4,"3":3,"4":4,"5":3,"6":4,"7":5,"8":5,"9":4,"10":4,"11":4,"12":4,"13":5,"14":4,"15":5,"16":5,"17":4,"18":4},"uncertainHoles":[6]}]}

Rules:
- Exactly ${playerCount} players in top-to-bottom order.
- Every hole key 1-18 must appear.
- Valid scores are 1-7; use null if uncertain rather than shifting neighboring scores.
- Never infer a missing hole from surrounding values.
- No markdown or commentary.`;

  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: cardDataUrl, detail: 'high' }
  ], 2200);
  const parsed = parseJson(extractOutputText(raw));
  if (!parsed || !Array.isArray(parsed.players) || parsed.players.length !== playerCount) {
    throw new Error('The scorecard could not be read reliably. Try a straighter, closer photo.');
  }

  const players = parsed.players.map((player, index) => {
    const scores = [];
    const uncertain = new Set(Array.isArray(player.uncertainHoles) ? player.uncertainHoles.map(Number) : []);
    for (let hole = 1; hole <= 18; hole++) {
      const rawValue = player.holes?.[String(hole)] ?? player.holes?.[hole];
      const score = Number(rawValue);
      if (!Number.isInteger(score) || score < 1 || score > 7) {
        scores.push(null);
        uncertain.add(hole);
      } else {
        scores.push(score);
        if (score === 1) uncertain.add(hole);
      }
    }
    return {
      name: String(player.name || '').trim() || `Player ${index + 1}`,
      scores,
      // Fallback output is intentionally review-first. Flag every hole so the user
      // knows this was not a locked fixed-cell read.
      uncertainHoles: Array.from({ length: 18 }, (_, i) => i + 1)
    };
  });

  return { players };
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
  const jpeg = await sharp(buffer, { failOn: 'none' }).rotate().jpeg({ quality: 94 }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

function boxToPixels(box, width, height) {
  const [x1, y1, x2, y2] = box;
  return {
    left: clamp(Math.floor(x1 / BOX_SCALE * width), 0, width - 2),
    top: clamp(Math.floor(y1 / BOX_SCALE * height), 0, height - 2),
    right: clamp(Math.ceil(x2 / BOX_SCALE * width), 2, width),
    bottom: clamp(Math.ceil(y2 / BOX_SCALE * height), 2, height)
  };
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
  if (start < 0 || end < start) throw new Error('The reader did not return valid score data. Try a clearer photo.');
  return JSON.parse(cleaned.slice(start, end + 1));
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
