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
    const sourceBuffer = dataUrlToBuffer(imageDataUrl);
    const source = sharp(sourceBuffer, { failOn: 'none' }).rotate();
    const metadata = await source.metadata();
    if (!metadata.width || !metadata.height) throw new Error('Could not determine the scorecard image size.');

    // Pass 1: use the full card only to locate the physical score grids and read names.
    // No score values are accepted from this pass.
    const layoutPrompt = `You are locating handwritten score cells on one Colonial Golf scorecard.

There are exactly ${playerCount} player rows. Return the players from TOP to BOTTOM. Read each player's handwritten name, then locate TWO rectangular regions for that player:
- frontBox: ONLY the nine handwritten score boxes for holes 1 through 9, from the left edge of hole 1's score box to the right edge of hole 9's score box.
- backBox: ONLY the nine handwritten score boxes for holes 10 through 18, from the left edge of hole 10's score box to the right edge of hole 18's score box.

Do NOT include the player-name area, OUT/IN/TOTAL cells, printed yardages, par rows, handicap rows, betting rows, or another player's row.

Coordinates must be integers normalized from 0 to 1000 relative to the image: [x1,y1,x2,y2]. The boxes should tightly contain the handwritten digits while keeping the full height of the score cells. It is better to make a box slightly taller than to clip handwriting, but do not include the row above or below.

Return ONLY JSON:
{"players":[{"name":"Paul","frontBox":[100,300,540,350],"backBox":[545,300,985,350]}]}

Rules:
- Exactly ${playerCount} player objects.
- Each box must have x1 < x2 and y1 < y2.
- frontBox and backBox must each contain exactly nine adjacent hole score cells.
- Do NOT return any hole scores. This pass is layout only.
- No commentary or markdown.`;

    const layoutRaw = await callVision(apiKey, [{ type: 'input_text', text: layoutPrompt }, { type: 'input_image', image_url: imageDataUrl, detail: 'high' }], 1800);
    const layout = normalizeLayout(parseJson(extractOutputText(layoutRaw)), playerCount, metadata.width, metadata.height);

    const players = [];
    for (let playerIndex = 0; playerIndex < playerCount; playerIndex++) {
      const item = layout.players[playerIndex];
      const frontCells = await makeNineCellImages(sourceBuffer, item.frontBox, metadata.width, metadata.height);
      const backCells = await makeNineCellImages(sourceBuffer, item.backBox, metadata.width, metadata.height);

      const front = await readNineCells(apiKey, frontCells, 1);
      const back = await readNineCells(apiKey, backCells, 10);

      const scores = [...front.scores, ...back.scores];
      const uncertainHoles = [...new Set([...front.uncertainHoles, ...back.uncertainHoles])].sort((a, b) => a - b);
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

    return reply(200, { players, ocrMode: 'fixed-cell-v1' });
  } catch (error) {
    console.error(error);
    return reply(500, { error: error.message || 'Unable to read this scorecard.' });
  }
};

async function makeNineCellImages(sourceBuffer, box, imageWidth, imageHeight) {
  const px = boxToPixels(box, imageWidth, imageHeight);
  const rowWidth = px.right - px.left;
  const rowHeight = px.bottom - px.top;
  if (rowWidth < 90 || rowHeight < 12) throw new Error('The score grid was located too narrowly. Try a straighter photo.');

  const images = [];
  for (let cell = 0; cell < 9; cell++) {
    const rawLeft = px.left + (rowWidth * cell / 9);
    const rawRight = px.left + (rowWidth * (cell + 1) / 9);
    const cellWidth = rawRight - rawLeft;

    // Pull each crop slightly inward from the vertical grid lines so a neighboring
    // handwritten digit cannot be mistaken for this hole. Keep generous vertical
    // room because handwritten numbers can touch horizontal rules.
    const insetX = Math.max(1, Math.round(cellWidth * 0.07));
    const left = clamp(Math.round(rawLeft) + insetX, 0, imageWidth - 2);
    const right = clamp(Math.round(rawRight) - insetX, left + 2, imageWidth);
    const topPad = Math.round(rowHeight * 0.10);
    const bottomPad = Math.round(rowHeight * 0.10);
    const top = clamp(px.top - topPad, 0, imageHeight - 2);
    const bottom = clamp(px.bottom + bottomPad, top + 2, imageHeight);

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
    text: `Read nine SEPARATE handwritten golf-score cell images. Each image is one physical hole box, already cropped so scores cannot shift left or right. The images are supplied in order for holes ${firstHole} through ${firstHole + 8}.

For EACH image independently, read only the single handwritten player score in that cell. Ignore printed grid lines or tiny printed text. Valid individual scores for this group are 1 through 7.

Return ONLY JSON in this exact shape:
{"scores":[6,5,6,4,5,4,5,4,5],"uncertain":[4]}

Rules:
- scores must have exactly 9 entries, one per supplied image in the same order.
- Each entry must be an integer 1-7, or null if the cell cannot be read confidently.
- Do not infer a pattern from neighboring cells. A sequence 6,5,6 must remain 6,5,6.
- Never borrow a digit from another image.
- A 1 is possible but extremely rare; include its position (1-9) in uncertain.
- Put any null or genuinely hard-to-read cell position in uncertain.
- No markdown or commentary.`
  }];

  cellImages.forEach((image, index) => {
    content.push({ type: 'input_text', text: `Cell ${index + 1} — Hole ${firstHole + index}` });
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

function normalizeLayout(data, expectedPlayers, imageWidth, imageHeight) {
  if (!data || !Array.isArray(data.players) || data.players.length !== expectedPlayers) {
    throw new Error(`Expected ${expectedPlayers} player rows, but the score grid could not be located reliably.`);
  }

  const players = data.players.map((player, index) => ({
    name: String(player.name || '').trim() || `Player ${index + 1}`,
    frontBox: validateBox(player.frontBox, `front nine for player ${index + 1}`),
    backBox: validateBox(player.backBox, `back nine for player ${index + 1}`)
  }));

  // Reject obviously overlapping player bands instead of silently reading the wrong row.
  for (let i = 1; i < players.length; i++) {
    const previous = players[i - 1];
    const current = players[i];
    if (current.frontBox[1] < previous.frontBox[1] || current.backBox[1] < previous.backBox[1]) {
      throw new Error('Player rows could not be locked top-to-bottom. Try a straighter scorecard photo.');
    }
  }

  // Convert once here only as a sanity check against tiny boxes.
  players.forEach((player, index) => {
    [player.frontBox, player.backBox].forEach((box, boxIndex) => {
      const px = boxToPixels(box, imageWidth, imageHeight);
      if ((px.right - px.left) < imageWidth * 0.20 || (px.bottom - px.top) < 8) {
        throw new Error(`The ${boxIndex === 0 ? 'front' : 'back'} score row for player ${index + 1} was not located reliably.`);
      }
    });
  });

  return { players };
}

function validateBox(value, label) {
  if (!Array.isArray(value) || value.length !== 4) throw new Error(`Could not locate the ${label}.`);
  const nums = value.map(Number);
  if (nums.some(n => !Number.isFinite(n))) throw new Error(`Could not locate the ${label}.`);
  const [x1, y1, x2, y2] = nums;
  if (x1 < 0 || y1 < 0 || x2 > BOX_SCALE || y2 > BOX_SCALE || x2 <= x1 || y2 <= y1) {
    throw new Error(`The ${label} grid coordinates were invalid.`);
  }
  return nums;
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
