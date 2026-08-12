const sharp = require('sharp');

const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1';

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
    const normalizedBuffer = await sharp(originalBuffer)
      .rotate()
      .resize({ width: 2200, height: 2200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 94 })
      .toBuffer();

    const meta = await sharp(normalizedBuffer).metadata();
    const width = meta.width;
    const height = meta.height;
    const normalizedDataUrl = `data:image/jpeg;base64,${normalizedBuffer.toString('base64')}`;

    // PASS 1: whole-card vision only LOCATES the handwritten player rows.
    // It is explicitly NOT asked to read score digits.
    const locatePrompt = `
Look at this ONE Colonial Golf Club scorecard.

Do NOT read or transcribe any score digits yet.

Your only job is to find the handwritten player rows in the main player-score area.

For each handwritten player row:
- read the handwritten player name;
- return one generous rectangle covering that player's entire handwritten row:
  name on the left, holes 1-9, handwritten OUT if present, holes 10-18,
  handwritten IN/TOTAL if present.
- The rectangle must include only that player's row, not the row above or below.

Ignore:
- printed PAR row
- printed HANDICAP rows
- tee yardages
- printed hole numbers
- scorer/attest/date rows
- any handwritten row below the main PAR row if it is not part of the main player block.

Coordinates are normalized 0-1000 relative to THIS uploaded image.
Return players top-to-bottom as they appear.

Return JSON only:
{
  "players": [
    {
      "name": "string",
      "rowBox": {"left":0,"top":0,"right":0,"bottom":0}
    }
  ]
}
`;

    const locateText = extractOutputText(await callVision(
      apiKey,
      locatePrompt,
      normalizedDataUrl,
      900
    ));
    const located = normalizeLocatedPlayers(parseJson(locateText)?.players);

    if (!located.length) {
      return reply(200, {
        players: [],
        debug: { locatorPass: locateText },
        ocrMode: 'player-row-read-v5.2',
        warning: 'No handwritten player rows were located.'
      });
    }

    // Crop each located player row with conservative padding, then stack the rows into
    // one clean composite image. This removes almost all distracting printed card content
    // while preserving the full handwritten row context.
    const rowImages = [];
    const rowDebug = [];

    for (let i = 0; i < located.length; i++) {
      const player = located[i];
      const crop = paddedBoxToPixels(player.rowBox, width, height);

      const rowBuffer = await sharp(normalizedBuffer)
        .extract(crop)
        .resize({
          width: 1800,
          height: 250,
          fit: 'contain',
          background: '#ffffff'
        })
        .jpeg({ quality: 95 })
        .toBuffer();

      rowImages.push(rowBuffer);
      rowDebug.push({ name: player.name, crop });
    }

    const composite = await stackRows(rowImages);
    const compositeDataUrl = `data:image/jpeg;base64,${composite.toString('base64')}`;

    // PASS 2: read only the isolated handwritten rows.
    const expectedNames = located.map(p => p.name);

    const readPrompt = `
This image contains ONLY cropped handwritten player rows from one Colonial Golf Club scorecard.
The rows are stacked top-to-bottom in the same order as the original card.

Expected handwritten names, top-to-bottom:
${JSON.stringify(expectedNames)}

For each row:
1) identify the player name;
2) read exactly 18 handwritten hole scores:
   holes 1-9 left-to-right, skip handwritten OUT subtotal, then holes 10-18;
3) read handwritten OUT / IN / TOTAL separately if visible.

Rules:
- Read only handwriting in these cropped rows.
- Do not infer values from golf expectations.
- Do not fill uncertain cells with 4s or other likely values.
- If a digit is genuinely unclear, return null and list that hole in uncertainHoles.
- A circled birdie means read the digit inside the circle.
- Scores are normally integers 1-7.
- A score of 1 is allowed but must be listed in uncertainHoles.
- Do not use OUT / IN / TOTAL as individual hole scores.
- Return one result for each visible cropped row, top-to-bottom.

Return JSON only:
{
  "players": [
    {
      "name": "string",
      "scores": [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null],
      "handwrittenOut": null,
      "handwrittenIn": null,
      "handwrittenTotal": null,
      "uncertainHoles": []
    }
  ]
}
`;

    const rowReadText = extractOutputText(await callVision(
      apiKey,
      readPrompt,
      compositeDataUrl,
      1800
    ));

    let players = normalizePlayers(parseJson(rowReadText)?.players);

    // Keep locator names/order if the row-reader misspells a name.
    players = located.map((loc, i) => {
      const read = players[i] || {
        name: loc.name,
        scores: Array(18).fill(null),
        handwrittenOut: null,
        handwrittenIn: null,
        handwrittenTotal: null,
        uncertainHoles: Array.from({ length: 18 }, (_, n) => n + 1)
      };

      return finalizePlayer({
        ...read,
        name: loc.name || read.name
      });
    });

    return reply(200, {
      players,
      debug: {
        locatorPass: locateText,
        locatedRows: rowDebug,
        isolatedRowReadPass: rowReadText,
        arithmetic: players.map(p => ({
          name: p.name,
          computedOut: sumNine(p.scores, 0),
          handwrittenOut: p.handwrittenOut,
          computedIn: sumNine(p.scores, 9),
          handwrittenIn: p.handwrittenIn,
          computedTotal: sumAll(p.scores),
          handwrittenTotal: p.handwrittenTotal
        }))
      },
      ocrMode: 'player-row-read-v5.2'
    });
  } catch (error) {
    console.error('v5.2 player-row read failure:', error);
    return reply(500, {
      error: error?.message || 'Player-row reading failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'player-row-read-v5.2'
    });
  }
};

function normalizeLocatedPlayers(src) {
  if (!Array.isArray(src)) return [];
  const out = [];

  for (const item of src) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    const b = item.rowBox || {};
    const left = Number(b.left);
    const top = Number(b.top);
    const right = Number(b.right);
    const bottom = Number(b.bottom);

    if (!name) continue;
    if (![left, top, right, bottom].every(Number.isFinite)) continue;
    if (left < 0 || top < 0 || right > 1000 || bottom > 1000) continue;
    if (right - left < 100 || bottom - top < 8) continue;

    out.push({ name, rowBox: { left, top, right, bottom } });
  }

  return out.slice(0, 5);
}

function paddedBoxToPixels(box, width, height) {
  const padX = 12;
  const padY = 8;

  let left = Math.floor((box.left - padX) / 1000 * width);
  let top = Math.floor((box.top - padY) / 1000 * height);
  let right = Math.ceil((box.right + padX) / 1000 * width);
  let bottom = Math.ceil((box.bottom + padY) / 1000 * height);

  left = clamp(left, 0, width - 1);
  top = clamp(top, 0, height - 1);
  right = clamp(right, left + 1, width);
  bottom = clamp(bottom, top + 1, height);

  return { left, top, width: right - left, height: bottom - top };
}

async function stackRows(rowImages) {
  const gap = 32;
  const rowWidth = 1800;
  const rowHeight = 250;
  const totalHeight = rowImages.length * rowHeight + Math.max(0, rowImages.length - 1) * gap;

  const base = sharp({
    create: {
      width: rowWidth,
      height: totalHeight,
      channels: 3,
      background: '#ffffff'
    }
  });

  const overlays = rowImages.map((input, i) => ({
    input,
    left: 0,
    top: i * (rowHeight + gap)
  }));

  return base.composite(overlays).jpeg({ quality: 95 }).toBuffer();
}

function normalizePlayers(src) {
  if (!Array.isArray(src)) return [];

  return src.map(item => {
    const scores = Array.from({ length: 18 }, (_, i) => {
      const v = item?.scores?.[i];
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 7 ? n : null;
    });

    const uncertain = new Set(
      Array.isArray(item?.uncertainHoles)
        ? item.uncertainHoles.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 18)
        : []
    );

    scores.forEach((v, i) => {
      if (v == null || v === 1) uncertain.add(i + 1);
    });

    return {
      name: String(item?.name || '').trim(),
      scores,
      handwrittenOut: validTotal(item?.handwrittenOut),
      handwrittenIn: validTotal(item?.handwrittenIn),
      handwrittenTotal: validTotal(item?.handwrittenTotal),
      uncertainHoles: [...uncertain].sort((a, b) => a - b)
    };
  });
}

function finalizePlayer(player) {
  const uncertain = new Set(player.uncertainHoles || []);
  const out = sumNine(player.scores, 0);
  const inn = sumNine(player.scores, 9);
  const total = sumAll(player.scores);

  if (player.handwrittenOut != null && out != null && player.handwrittenOut !== out) {
    for (let h = 1; h <= 9; h++) uncertain.add(h);
  }

  if (player.handwrittenIn != null && inn != null && player.handwrittenIn !== inn) {
    for (let h = 10; h <= 18; h++) uncertain.add(h);
  }

  if (player.handwrittenTotal != null && total != null && player.handwrittenTotal !== total) {
    for (let h = 1; h <= 18; h++) uncertain.add(h);
  }

  return {
    ...player,
    uncertainHoles: [...uncertain].sort((a, b) => a - b)
  };
}

function validTotal(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 9 && n <= 150 ? n : null;
}

function sumNine(scores, start) {
  const a = scores.slice(start, start + 9);
  return a.some(v => v == null) ? null : a.reduce((x, y) => x + y, 0);
}

function sumAll(scores) {
  return scores.some(v => v == null) ? null : scores.reduce((x, y) => x + y, 0);
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
    throw new Error('The player-row reader returned an unreadable response.');
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
