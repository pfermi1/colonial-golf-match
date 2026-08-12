const sharp = require('sharp');

const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1';

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed.' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return reply(500, { error: 'OPENAI_API_KEY is not configured in Netlify.' });

  try {
    const body = JSON.parse(event.body || '{}');
    const { imageDataUrl, expectedPlayers } = body;
    if (!imageDataUrl || !/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(imageDataUrl)) {
      return reply(400, { error: 'A scorecard image is required.' });
    }

    const playerCount = [4, 5].includes(Number(expectedPlayers)) ? Number(expectedPlayers) : 4;

    // Normalize orientation and use this exact image both for geometry and OCR.
    const inputBuffer = dataUrlToBuffer(imageDataUrl);
    const normalizedBuffer = await sharp(inputBuffer)
      .rotate()
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();

    const meta = await sharp(normalizedBuffer).metadata();
    const width = meta.width;
    const height = meta.height;
    const normalizedDataUrl = `data:image/jpeg;base64,${normalizedBuffer.toString('base64')}`;

    const nameResult = await locatePlayerNames(apiKey, normalizedDataUrl, playerCount);
    const visibleNames = nameResult.names;
    const players = [];
    const rowGeometry = [];
    const allCellDiagnostics = [];

    for (let playerIndex = 0; playerIndex < visibleNames.length; playerIndex++) {
      const name = visibleNames[playerIndex];

      const geometry = await locatePlayerNineBoxes(
        apiKey,
        normalizedDataUrl,
        playerIndex,
        name,
        visibleNames.length
      );

      const checkedGeometry = await verifyAndRepairGeometry(
        apiKey, normalizedDataUrl, playerIndex, name, visibleNames.length, geometry
      );

      rowGeometry.push({ name, ...checkedGeometry });

      const playerResult = await readPlayerFromTrueCells(
        apiKey,
        normalizedBuffer,
        width,
        height,
        name,
        checkedGeometry
      );

      players.push({
        name,
        scores: playerResult.scores,
        uncertainHoles: playerResult.uncertainHoles
      });

      allCellDiagnostics.push({
        name,
        frontBox: geometry.front,
        backBox: geometry.back,
        cells: playerResult.cells
      });
    }

    return reply(200, {
      players,
      debug: {
        visibleNameCount: visibleNames.length,
        rawNamesResponse: nameResult.rawText,
        rowGeometry,
        cellDiagnostics: allCellDiagnostics
      },
      ocrMode: 'oriented-card-cell-crop-v2.4'
    });
  } catch (error) {
    console.error('v2.3 scorecard read failed:', error);
    return reply(500, { error: friendlyError(error) });
  }
};

async function locatePlayerNames(apiKey, imageDataUrl, playerCount) {
  const prompt = `
Literal transcription task. Look only at THIS photographed scorecard.

Identify handwritten PLAYER NAMES visibly present in the score-entry area.
Do not invent, remember, autocomplete, or reuse names.
If only one handwritten name is visible, return exactly one.
If no handwritten names are visible, return none.

Return JSON only:
{"names":[]}

Maximum ${playerCount} names. No placeholders.`;

  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
  ], 300);

  const rawText = extractOutputText(raw);
  const parsed = parseJson(rawText);
  const source = Array.isArray(parsed?.names) ? parsed.names.slice(0, playerCount) : [];

  return {
    names: source.map(v => String(v || '').trim()).filter(Boolean),
    rawText
  };
}

async function locatePlayerNineBoxes(apiKey, imageDataUrl, playerIndex, playerName, playerCount) {
  const ordinal = ordinalWord(playerIndex + 1);

  const prompt = `
You are locating grid geometry on ONE Colonial golf scorecard image that has been normalized to landscape orientation.

The expected visual layout is:
- HOLE 1 is at the LEFT and HOLE 18 is at the RIGHT.
- Player names are at the LEFT of their handwritten score rows.
- Front-nine handwritten cells run left-to-right from Hole 1 through Hole 9.
- Back-nine handwritten cells continue left-to-right from Hole 10 through Hole 18.
- Do NOT select the printed HANDICAP row above the player rows.
- Do NOT select the printed PAR row below the player rows.

Target: the ${ordinal} handwritten player row out of ${playerCount} visible player rows.
Player name is approximately ${JSON.stringify(playerName)}.

Return TWO bounding boxes:
1) "front": ONLY the 9 handwritten score cells for holes 1 through 9.
2) "back": ONLY the 9 handwritten score cells for holes 10 through 18.

Important:
- Exclude the handwritten player name.
- Exclude OUT, IN, TOT, HCP, NET cells and totals.
- Exclude printed PAR/HANDICAP/yardage rows above/below.
- The vertical center of each box MUST pass through the handwritten score digits for this player.
- Reject any candidate box whose contents are primarily printed yardages, printed handicap numbers, printed par values, or background outside the card.
- Each box should tightly cover the full nine handwritten score cells from the left edge of the first score cell to the right edge of the ninth score cell.
- Coordinates are normalized integers from 0 to 1000 relative to the full image:
  left=0 is image left, top=0 is image top, right=1000 is image right, bottom=1000 is image bottom.
- If you cannot locate a box confidently, set it to null. Never guess another player's row.

Return JSON only:
{
  "front":{"left":0,"top":0,"right":0,"bottom":0},
  "back":{"left":0,"top":0,"right":0,"bottom":0}
}`;

  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
  ], 450);

  const parsed = parseJson(extractOutputText(raw));
  return {
    front: normalizeBox(parsed?.front),
    back: normalizeBox(parsed?.back)
  };
}


async function verifyAndRepairGeometry(apiKey, imageDataUrl, playerIndex, playerName, playerCount, geometry) {
  const prompt = `
Geometry verification for a Colonial golf scorecard.

The card should be landscape: Hole 1 at left, Hole 18 at right.
Target player: ${JSON.stringify(playerName)}, the ${ordinalWord(playerIndex + 1)} visible handwritten player row.

Candidate front-nine box: ${JSON.stringify(geometry.front)}
Candidate back-nine box: ${JSON.stringify(geometry.back)}

Inspect THIS image and return corrected boxes if necessary.
Each returned box must contain ONLY the target player's handwritten score cells:
front = Holes 1-9, back = Holes 10-18.

Critical rejection rules:
- Printed HANDICAP numbers are NOT player scores.
- Printed PAR numbers are NOT player scores.
- Yardages are NOT player scores.
- Background/knee/table is NOT part of either box.
- Both boxes must lie on the SAME handwritten player row.
- The front and back boxes should have nearly the same top and bottom coordinates.
- The front box must be left of the back box.
- Exclude OUT, IN, TOT, HCP and NET totals.

Return JSON only:
{"front":{"left":0,"top":0,"right":0,"bottom":0},"back":{"left":0,"top":0,"right":0,"bottom":0}}
`;
  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
  ], 450);
  const parsed = parseJson(extractOutputText(raw));
  const front = normalizeBox(parsed?.front);
  const back = normalizeBox(parsed?.back);
  if (!front || !back) return geometry;

  // Mechanical sanity checks for the standard landscape layout.
  const sameRow = Math.abs(front.top - back.top) <= 35 && Math.abs(front.bottom - back.bottom) <= 35;
  const ordered = front.left < back.left;
  if (!sameRow || !ordered) return geometry;
  return { front, back };
}

async function readPlayerFromTrueCells(apiKey, imageBuffer, imageWidth, imageHeight, playerName, geometry) {
  const scores = Array(18).fill(null);
  const uncertainHoles = [];
  const cells = [];

  const halves = [
    { label: 'front', box: geometry.front, startHole: 1 },
    { label: 'back', box: geometry.back, startHole: 10 }
  ];

  for (const half of halves) {
    if (!half.box) {
      for (let j = 0; j < 9; j++) {
        const hole = half.startHole + j;
        uncertainHoles.push(hole);
        cells.push({ hole, half: half.label, digit: null, uncertain: true, imageDataUrl: null, error: 'nine-box not located' });
      }
      continue;
    }

    const nineBuffer = await extractNormalizedBox(imageBuffer, imageWidth, imageHeight, half.box);
    const nineMeta = await sharp(nineBuffer).metadata();
    const nineWidth = nineMeta.width;
    const nineHeight = nineMeta.height;

    for (let j = 0; j < 9; j++) {
      const hole = half.startHole + j;

      // Physically split the located 9-hole grid into nine equal-width cells.
      const x0 = Math.floor(j * nineWidth / 9);
      const x1 = Math.floor((j + 1) * nineWidth / 9);
      const rawW = Math.max(1, x1 - x0);

      // Trim a small amount from the four edges to reduce printed grid lines.
      const trimX = Math.max(1, Math.floor(rawW * 0.07));
      const trimY = Math.max(1, Math.floor(nineHeight * 0.08));

      const left = Math.min(nineWidth - 1, x0 + trimX);
      const top = Math.min(nineHeight - 1, trimY);
      const cellW = Math.max(1, Math.min(nineWidth - left, rawW - trimX * 2));
      const cellH = Math.max(1, Math.min(nineHeight - top, nineHeight - trimY * 2));

      const cellBuffer = await sharp(nineBuffer)
        .extract({ left, top, width: cellW, height: cellH })
        .resize({ width: 220, height: 220, fit: 'contain', background: '#ffffff' })
        .sharpen()
        .jpeg({ quality: 94 })
        .toBuffer();

      const read = await readSingleCell(apiKey, cellBuffer, hole);
      scores[hole - 1] = read.digit;
      if (read.uncertain || read.digit == null) uncertainHoles.push(hole);

      cells.push({
        hole,
        half: half.label,
        digit: read.digit,
        uncertain: read.uncertain,
        imageDataUrl: `data:image/jpeg;base64,${cellBuffer.toString('base64')}`
      });
    }
  }

  return { scores, uncertainHoles: [...new Set(uncertainHoles)].sort((a,b)=>a-b), cells };
}

async function readSingleCell(apiKey, cellBuffer, hole) {
  const cellDataUrl = `data:image/jpeg;base64,${cellBuffer.toString('base64')}`;

  const prompt = `
This image contains exactly ONE golf score box for Hole ${hole}.

Read the single HANDWRITTEN score digit inside this box.
Return one of 1,2,3,4,5,6,7 or null.

Rules:
- Ignore the printed border/grid line.
- A circle may surround a birdie. Ignore the circle and read only the digit inside.
- Do not infer from par, neighboring holes, totals, or golf logic; none are available to you.
- If no handwritten digit is clearly visible, return null and uncertain=true.
- If the digit could reasonably be confused with another digit, uncertain=true.

Return JSON only:
{"digit":null,"uncertain":true}`;

  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: cellDataUrl, detail: 'high' }
  ], 160);

  const parsed = parseJson(extractOutputText(raw));
  const digit = Number(parsed?.digit);
  const valid = Number.isInteger(digit) && digit >= 1 && digit <= 7;

  return {
    digit: valid ? digit : null,
    uncertain: Boolean(parsed?.uncertain) || !valid || digit === 1
  };
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
  if (right - left < 30 || bottom - top < 10) return null;

  return { left, top, right, bottom };
}

function dataUrlToBuffer(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Invalid image data.');
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}

function ordinalWord(n) {
  return ['first', 'second', 'third', 'fourth', 'fifth'][n - 1] || `${n}th`;
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
    throw new Error('The scorecard reader returned an unreadable response.');
  }
}

function friendlyError(error) {
  const message = String(error?.message || error || 'Unknown error');
  if (/429|rate limit|quota/i.test(message)) return 'The scorecard reader is temporarily rate-limited. Please wait a moment and try again.';
  if (/401|invalid.*key|api key/i.test(message)) return 'The OpenAI API key is missing or invalid in Netlify.';
  if (/payload|too large|request entity/i.test(message)) return 'The photo is too large. Please retake it a little closer and try again.';
  return message;
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
