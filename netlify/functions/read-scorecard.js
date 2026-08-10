const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini';
const BOX_SCALE = 1000;
const TEMPLATE_PATH = path.join(__dirname, 'assets', 'colonial-template-card.jpg');

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
    const templateBuffer = fs.readFileSync(TEMPLATE_PATH);
    const templateDataUrl = `data:image/jpeg;base64,${templateBuffer.toString('base64')}`;
    const originalBuffer = dataUrlToBuffer(imageDataUrl);

    // 1) Normalize EXIF orientation, then ask the model only which quarter-turn makes
    // the photographed Colonial card read in the same direction as the known template.
    const orientedBuffer = await orientLikeTemplate(apiKey, imageDataUrl, templateDataUrl, originalBuffer);
    const orientedDataUrl = await bufferToDataUrl(orientedBuffer);

    // 2) Find the physical card using the template as the reference. If this pass is
    // uncertain, keep the whole image rather than aborting.
    const cardBuffer = await cropCardUsingTemplate(apiKey, orientedDataUrl, templateDataUrl, orientedBuffer);
    const cardDataUrl = await bufferToDataUrl(cardBuffer);
    const cardMeta = await sharp(cardBuffer, { failOn: 'none' }).metadata();
    if (!cardMeta.width || !cardMeta.height) throw new Error('Could not prepare the scorecard image.');

    // 3) Locate only the stable template features needed for cell extraction.
    let layout;
    try {
      layout = await locateTemplateGrid(apiKey, cardDataUrl, templateDataUrl, playerCount);
      layout = normalizeGridLayout(layout, playerCount);
    } catch (layoutError) {
      console.warn('Template grid lock failed; using review-first fallback:', layoutError.message);
      const fallback = await readWholeCardFallback(apiKey, cardDataUrl, playerCount);
      return reply(200, {
        players: fallback.players,
        ocrMode: 'template-fallback-review',
        warning: 'The Colonial template could not be aligned tightly enough. Please review the highlighted scores.'
      });
    }

    const players = [];
    for (let playerIndex = 0; playerIndex < playerCount; playerIndex++) {
      const item = layout.players[playerIndex];
      const frontBox = rowGridBox(layout.frontGrid, item.row);
      const backBox = rowGridBox(layout.backGrid, item.row);

      let front;
      let back;
      try {
        const frontCells = await makeNineCellImages(cardBuffer, frontBox, cardMeta.width, cardMeta.height);
        const backCells = await makeNineCellImages(cardBuffer, backBox, cardMeta.width, cardMeta.height);
        front = await readNineCells(apiKey, frontCells, 1);
        back = await readNineCells(apiKey, backCells, 10);
      } catch (cellError) {
        console.warn(`Player ${playerIndex + 1} fixed-cell read failed:`, cellError.message);
        const fallback = await readWholeCardFallback(apiKey, cardDataUrl, playerCount);
        return reply(200, {
          players: fallback.players,
          ocrMode: 'template-fallback-review',
          warning: 'One score row could not be split cleanly into nine boxes. Please review the highlighted scores.'
        });
      }

      const scores = [...front.scores, ...back.scores];
      const uncertainHoles = [...new Set([...front.uncertainHoles, ...back.uncertainHoles])];
      scores.forEach((score, index) => {
        if (score === 1 && !uncertainHoles.includes(index + 1)) uncertainHoles.push(index + 1);
      });
      uncertainHoles.sort((a, b) => a - b);

      players.push({ name: item.name, scores, uncertainHoles });
    }

    return reply(200, { players, ocrMode: 'colonial-template-v1.2' });
  } catch (error) {
    console.error(error);
    return reply(500, { error: friendlyError(error) });
  }
};

async function orientLikeTemplate(apiKey, uploadDataUrl, templateDataUrl, originalBuffer) {
  let autoOriented = await sharp(originalBuffer, { failOn: 'none' }).rotate().jpeg({ quality: 94 }).toBuffer();
  const autoUrl = `data:image/jpeg;base64,${autoOriented.toString('base64')}`;
  try {
    const raw = await callVision(apiKey, [
      {
        type: 'input_text',
        text: `Image 1 is the known Colonial scorecard reference. Image 2 is a new photo of the same scorecard design. Determine the clockwise quarter-turn needed for Image 2 so the printed HOLE row reads left-to-right like the reference and holes 1-9 are on the left, holes 10-18 on the right. Return ONLY JSON: {"rotate":0}. Allowed rotate values: 0, 90, 180, 270. Do not return any other text.`
      },
      { type: 'input_text', text: 'REFERENCE TEMPLATE' },
      { type: 'input_image', image_url: templateDataUrl, detail: 'high' },
      { type: 'input_text', text: 'NEW SCORECARD PHOTO' },
      { type: 'input_image', image_url: autoUrl, detail: 'high' }
    ], 300);
    const parsed = parseJson(extractOutputText(raw));
    const rotate = [0, 90, 180, 270].includes(Number(parsed.rotate)) ? Number(parsed.rotate) : 0;
    if (rotate) autoOriented = await sharp(autoOriented, { failOn: 'none' }).rotate(rotate).jpeg({ quality: 94 }).toBuffer();
  } catch (error) {
    console.warn('Quarter-turn orientation check skipped:', error.message);
  }
  return autoOriented;
}

async function cropCardUsingTemplate(apiKey, imageDataUrl, templateDataUrl, imageBuffer) {
  try {
    const raw = await callVision(apiKey, [
      {
        type: 'input_text',
        text: `Use Image 1 as the reference Colonial scorecard design. In Image 2, locate the OUTER BLUE-EDGED PHYSICAL SCORECARD rectangle, not the table or background. Return ONLY JSON with normalized 0-1000 coordinates relative to Image 2: {"cardBox":[x1,y1,x2,y2]}. Include all four card edges with a very small margin. No commentary.`
      },
      { type: 'input_text', text: 'REFERENCE TEMPLATE' },
      { type: 'input_image', image_url: templateDataUrl, detail: 'high' },
      { type: 'input_text', text: 'NEW PHOTO' },
      { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
    ], 350);
    const parsed = parseJson(extractOutputText(raw));
    const safeBox = sanitizeBox(parsed.cardBox, { minWidth: 380, minHeight: 240 });
    if (!safeBox) return normalizeCardBuffer(imageBuffer);

    const meta = await sharp(imageBuffer, { failOn: 'none' }).metadata();
    if (!meta.width || !meta.height) return normalizeCardBuffer(imageBuffer);
    const px = boxToPixels(expandBox(safeBox, 8), meta.width, meta.height);
    const width = px.right - px.left;
    const height = px.bottom - px.top;
    if (width < meta.width * 0.42 || height < meta.height * 0.28) return normalizeCardBuffer(imageBuffer);

    return await sharp(imageBuffer, { failOn: 'none' })
      .extract({ left: px.left, top: px.top, width, height })
      .resize({ width: 2600, withoutEnlargement: false })
      .sharpen()
      .jpeg({ quality: 95 })
      .toBuffer();
  } catch (error) {
    console.warn('Template card crop skipped:', error.message);
    return normalizeCardBuffer(imageBuffer);
  }
}

async function normalizeCardBuffer(buffer) {
  return sharp(buffer, { failOn: 'none' })
    .resize({ width: 2600, withoutEnlargement: false })
    .sharpen()
    .jpeg({ quality: 95 })
    .toBuffer();
}

async function locateTemplateGrid(apiKey, cardDataUrl, templateDataUrl, playerCount) {
  const prompt = `Image 1 is the known Colonial scorecard template. Image 2 is a cropped photo of that same scorecard design with handwritten scores.

Using the template geometry, locate ONLY these items in Image 2:
- frontGrid: [x1,x2], the horizontal span of the NINE player score cells for holes 1-9. Exclude the handwritten name area and exclude OUT.
- backGrid: [x1,x2], the horizontal span of the NINE player score cells for holes 10-18. Exclude IN, TOT, HCP, NET.
- exactly ${playerCount} player rows, top-to-bottom. For each return the handwritten player's name and row:[y1,y2] covering only that player's score-cell row.

Coordinates are normalized integers 0-1000 relative to Image 2.
Return ONLY JSON exactly like:
{"frontGrid":[150,480],"backGrid":[520,850],"players":[{"name":"Paul","row":[390,435]}]}

Important:
- Use the printed hole columns from the template as anchors; do not estimate equal thirds or shift columns based on handwriting.
- Each player row uses one shared y-range across front and back.
- Exactly ${playerCount} players.
- Rows must be in top-to-bottom order.
- Do not read any scores in this pass.
- No markdown or commentary.`;

  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_text', text: 'REFERENCE TEMPLATE' },
    { type: 'input_image', image_url: templateDataUrl, detail: 'high' },
    { type: 'input_text', text: 'CROPPED NEW SCORECARD' },
    { type: 'input_image', image_url: cardDataUrl, detail: 'high' }
  ], 1200);
  return parseJson(extractOutputText(raw));
}

function normalizeGridLayout(data, expectedPlayers) {
  if (!data || !Array.isArray(data.players) || data.players.length !== expectedPlayers) {
    throw new Error(`Could not identify all ${expectedPlayers} player rows on the Colonial template.`);
  }

  const frontGrid = sanitizeRange(data.frontGrid, 0.20, 'front-nine score grid');
  const backGrid = sanitizeRange(data.backGrid, 0.20, 'back-nine score grid');
  if (backGrid[0] <= frontGrid[1] - 20) throw new Error('The front and back score grids overlap unexpectedly.');

  const players = data.players.map((player, index) => ({
    name: String(player.name || '').trim() || `Player ${index + 1}`,
    row: sanitizeRange(player.row, 0.012, `player ${index + 1} score row`)
  }));

  const centers = players.map(p => (p.row[0] + p.row[1]) / 2);
  for (let i = 1; i < centers.length; i++) {
    if (centers[i] <= centers[i - 1]) throw new Error('Player rows were not found in top-to-bottom order.');
  }

  const heights = players.map(p => p.row[1] - p.row[0]).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 40;
  players.forEach(player => {
    const height = player.row[1] - player.row[0];
    if (height < medianHeight * 0.60 || height > medianHeight * 1.65) {
      const center = (player.row[0] + player.row[1]) / 2;
      player.row = [
        clamp(Math.round(center - medianHeight / 2), 0, 998),
        clamp(Math.round(center + medianHeight / 2), 2, 1000)
      ];
    }
  });

  return { frontGrid, backGrid, players };
}

function rowGridBox(xRange, yRange) {
  return [xRange[0], yRange[0], xRange[1], yRange[1]];
}

async function makeNineCellImages(sourceBuffer, box, imageWidth, imageHeight) {
  const safeBox = sanitizeBox(box, { minWidth: 180, minHeight: 10 });
  if (!safeBox) throw new Error('A score row could not be cropped safely.');
  const px = boxToPixels(safeBox, imageWidth, imageHeight);
  const rowWidth = px.right - px.left;
  const rowHeight = px.bottom - px.top;
  if (rowWidth < 180 || rowHeight < 10) throw new Error('A score row was too narrow to split into nine holes.');

  const images = [];
  for (let cell = 0; cell < 9; cell++) {
    const rawLeft = px.left + (rowWidth * cell / 9);
    const rawRight = px.left + (rowWidth * (cell + 1) / 9);
    const cellWidth = rawRight - rawLeft;
    const insetX = Math.max(1, Math.round(cellWidth * 0.035));
    const left = clamp(Math.round(rawLeft) + insetX, 0, imageWidth - 2);
    const right = clamp(Math.round(rawRight) - insetX, left + 2, imageWidth);
    const verticalPad = Math.max(2, Math.round(rowHeight * 0.18));
    const top = clamp(px.top - verticalPad, 0, imageHeight - 2);
    const bottom = clamp(px.bottom + verticalPad, top + 2, imageHeight);

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

async function readNineCells(apiKey, cellImages, firstHole) {
  const content = [{
    type: 'input_text',
    text: `Read nine SEPARATE handwritten golf-score cell images. Each supplied image is exactly one physical hole box from a Colonial scorecard, in order for holes ${firstHole} through ${firstHole + 8}.

Read each image independently. Valid individual scores are 1 through 7.
Return ONLY JSON exactly like:
{"scores":[6,5,6,4,5,4,5,4,5],"uncertain":[4]}

Rules:
- Exactly 9 score entries in the same order as the images.
- Integer 1-7 or null if uncertain.
- Never shift a digit left or right.
- Never use neighboring cells to infer a missing value.
- Never invent a final-hole score to complete a pattern.
- A 1 is possible but rare; mark its 1-based cell position uncertain.
- Mark null or genuinely ambiguous cells uncertain.
- No commentary or markdown.`
  }];

  cellImages.forEach((image, index) => {
    content.push({ type: 'input_text', text: `Physical cell ${index + 1}; Hole ${firstHole + index}` });
    content.push({ type: 'input_image', image_url: image, detail: 'high' });
  });

  const raw = await callVision(apiKey, content, 850);
  const parsed = parseJson(extractOutputText(raw));
  if (!Array.isArray(parsed.scores) || parsed.scores.length !== 9) {
    throw new Error(`Holes ${firstHole}-${firstHole + 8} did not return nine independent values.`);
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
  const prompt = `This is the standard Colonial Golf scorecard layout. Read exactly ${playerCount} handwritten player rows, top-to-bottom. For every player, read holes 1 through 18 by the printed hole columns. Ignore names/values in yardage, handicap, PAR, OUT, IN, TOT, HCP, NET, and any betting/calculation rows.

Return ONLY JSON:
{"players":[{"name":"Paul","holes":{"1":5,"2":4,"3":3,"4":4,"5":3,"6":4,"7":5,"8":5,"9":4,"10":4,"11":4,"12":4,"13":5,"14":4,"15":5,"16":5,"17":4,"18":4},"uncertainHoles":[6]}]}

Rules:
- Exactly ${playerCount} players.
- Every hole key 1-18 appears.
- Valid individual scores are 1-7; use null if uncertain.
- Do not shift neighboring values to fill a gap.
- No markdown or commentary.`;

  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: cardDataUrl, detail: 'high' }
  ], 2200);
  const parsed = parseJson(extractOutputText(raw));
  if (!parsed || !Array.isArray(parsed.players) || parsed.players.length !== playerCount) {
    throw new Error('The scorecard could not be read reliably. Try a straighter landscape photo with all four card edges visible.');
  }

  const players = parsed.players.map((player, index) => {
    const scores = [];
    for (let hole = 1; hole <= 18; hole++) {
      const rawValue = player.holes?.[String(hole)] ?? player.holes?.[hole];
      const score = Number(rawValue);
      scores.push(Number.isInteger(score) && score >= 1 && score <= 7 ? score : null);
    }
    return {
      name: String(player.name || '').trim() || `Player ${index + 1}`,
      scores,
      uncertainHoles: Array.from({ length: 18 }, (_, i) => i + 1)
    };
  });
  return { players };
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

function expandBox(box, amount) {
  return [
    clamp(box[0] - amount, 0, 1000),
    clamp(box[1] - amount, 0, 1000),
    clamp(box[2] + amount, 0, 1000),
    clamp(box[3] + amount, 0, 1000)
  ];
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
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (error) {
    throw new Error('The AI response could not be parsed as scorecard data.');
  }
}

function friendlyError(error) {
  const message = String(error?.message || 'Unable to read this scorecard.');
  if (/expected pattern|string did not match|coordinates were invalid/i.test(message)) {
    return 'The Colonial template could not be aligned to this photo. Try a straight landscape photo with all four card edges visible.';
  }
  if (/JSON|parsed|score grid|row|crop/i.test(message)) {
    return 'The score grid could not be locked cleanly. Try a straight landscape photo with all four card edges visible.';
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
