const V22_CELL_RULES = "\nV2.2 TRUE CELL-CROP OCR:\n- The server physically crops each visible player's 18 hole cells before digit recognition.\n- Each digit read receives ONLY one hole-cell image.\n- Return exactly one of: 1,2,3,4,5,6,7 or null.\n- Ignore circles around birdies; read only the digit inside.\n- Do not use neighboring holes, totals, printed par, handicaps, yardages, names, or prior images to infer a value.\n- If the cell does not clearly contain a handwritten score, return null.\n";
const sharp = require('sharp');
const V21_SINGLE_CELL_RULES = "\nV2.1 SINGLE-CELL DIGIT TEST:\n- First identify only the visible player rows in the current image.\n- For each visible player, preserve the 18 hole positions exactly.\n- Do not invent or pad missing players.\n- For digit recognition, treat each hole as an independent one-digit classification task.\n- Valid handwritten player scores are normally 2,3,4,5,6,7. A 1 is allowed only if it is clearly written; a circle around a digit is a birdie mark and must be ignored when reading the digit.\n- Never infer a score from neighboring holes, totals, par, handicap, or score patterns.\n- If a digit is not clear enough, return null for that hole rather than guessing.\n- Do not reorder, shift, smooth, or fill holes.\n";
const V20_CLEAN_PLAYER_RULES = "\nV2.0 CLEAN PLAYER PIPELINE:\n- Return ONLY players whose names or handwritten score rows are visibly present in this image.\n- Never pad the result to 4 or 5 players.\n- Never reuse names or scores from prior requests, examples, defaults, or previous images.\n- If the image shows only one player row, return exactly one player object.\n- If a visible named player row has no scores, return that player's name with 18 null scores only if the row itself is visibly present.\n- Never fabricate a player to satisfy an expected foursome/fivesome count.\n";
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

    // v1.5 deliberately separates "who are the players?" from "what are this
    // player's 18 scores?". The full image is supplied to every request, but
    // each scoring request is constrained to one handwritten row only. This is
    // meant to prevent vertical drift into the next player's row.
    const nameResult = await locatePlayerNames(apiKey, imageDataUrl, playerCount);
    const visibleNames = nameResult.names;
    const players = [];
    const rawRows = [];

    for (let playerIndex = 0; playerIndex < visibleNames.length; playerIndex++) {
      const name = visibleNames[playerIndex];
      const rowResult = await readOnePlayerRow(apiKey, imageDataUrl, playerIndex, name, visibleNames.length);
      rawRows.push(rowResult.__rawText || '');
      players.push(normalizePlayerRow(rowResult, name));
    }

    return reply(200, {
      players,
      debug: {
        visibleNameCount: visibleNames.length,
        rawNamesResponse: nameResult.rawText,
        rawPlayerRowResponses: rawRows
      },
      ocrMode: 'true-cell-crop-v2.2',
      warning: players.some(p => p.uncertainHoles.length)
        ? 'Raw diagnostic mode. No prior-card examples are embedded in the prompts.'
        : undefined
    });
  } catch (error) {
    console.error('v1.9 scorecard read failed:', error);
    return reply(500, { error: friendlyError(error) });
  }
};

async function locatePlayerNames(apiKey, imageDataUrl, playerCount) {
  const prompt = `
This is a literal transcription task on ONE photographed golf scorecard image.

Identify only handwritten PLAYER NAMES that are visibly present in the score-entry area.
Do not infer, remember, autocomplete, or invent names.
Do not use names from any previous request.
Do not use printed course labels as player names.
If only one handwritten player name is visible, return only that one name.
If no handwritten player names are visible, return an empty array.

Return ONLY JSON with this shape:
{
  "names": []
}
The names array may contain from 0 through ${playerCount} visible handwritten names. No placeholders.`;

  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
  ], 400);

  const rawText = extractOutputText(raw);
  const parsed = parseJson(rawText);
  const source = Array.isArray(parsed?.names) ? parsed.names.slice(0, playerCount) : [];
  return {
    names: source.map(name => String(name || '').trim()).filter(Boolean),
    rawText
  };
}

async function readOnePlayerRow(apiKey, imageDataUrl, playerIndex, playerName, playerCount) {
  const ordinal = ordinalWord(playerIndex + 1);
  const prompt = `
You are transcribing ONE handwritten player row from a photographed Colonial Golf Club paper scorecard.

Read ONLY the ${ordinal} handwritten player row out of ${playerCount} player rows in the score-entry area immediately above the printed PAR row.
The player is labeled approximately ${JSON.stringify(playerName)}.

THIS IS A CONSERVATIVE TRANSCRIPTION TASK. ACCURACY IS MORE IMPORTANT THAN COMPLETENESS.

STRICT RULES:
- Make ONE transcription only. Do not revise a digit because a neighboring score "looks more likely".
- Ignore every handwritten score row above and below this player's row.
- If this named player's row is not visibly present in THIS image, return 18 nulls. Never synthesize a row.
- Anchor every value to the printed hole column directly above it: Holes 1-9, then Holes 10-18.
- Never shift a score left or right to fill a missing or uncertain cell.
- Never infer a pattern from neighboring scores. A sequence such as 5,4,3,4,3,4 must be copied exactly as written, not smoothed into repeated 4s.
- Distinguish handwritten 3, 4, 5, 6, and 7 by their visible strokes. If you cannot confidently distinguish the digit in its exact cell, return null for that hole.
- IMPORTANT BIRDIE CONVENTION: scorers often DRAW A CIRCLE AROUND A BIRDIE SCORE. The circle is only a mark around the score. Ignore the circle itself and transcribe the single handwritten digit INSIDE the circle. Do not read the surrounding circle as 0, 6, 8, 9, or as part of a two-digit number.
- Use the PRINTED PAR row for the same hole only as a visual sanity clue when interpreting a circled score: a circled birdie is normally one less than that printed par. Do NOT invent or force a birdie merely because a circle-like mark is present; the visible handwritten digit remains the primary evidence.
- For uncircled scores, do not change a visible digit just because another score would be more statistically likely.
- Do not borrow a digit from OUT, IN, TOT, PAR, HCP, NET, yardage, another player, or any 1 Ball / 2 Ball / 2+3 Ball row.
- Do not invent Hole 9 or Hole 18 merely to complete the row.
- For this current group, individual scores are integers 1 through 7. Values outside 1-7 must be null.
- A clearly written 1 may be returned as 1, but ALWAYS flag that hole as uncertain for human hole-in-one confirmation.
- It is acceptable to return several nulls. A blank/highlighted cell is preferable to a confident wrong score.

Before producing JSON, visually trace this one player's row from Hole 1 to Hole 18 and preserve the physical column position of every digit.

Return ONLY JSON in this exact shape:
{
  "name": ${JSON.stringify(playerName)},
  "scores": [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null],
  "uncertainHoles": []
}
There must be exactly 18 score entries. Replace each null only when a handwritten score is visibly present in that exact hole cell. Use null for any unreadable, ambiguous, or absent cell.`;

  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
  ], 950);

  const rawText = extractOutputText(raw);
  const parsed = parseJson(rawText);
  parsed.__rawText = rawText;
  return parsed;
}

function normalizePlayerRow(rawPlayer, fallbackName) {
  const rawScores = Array.isArray(rawPlayer?.scores) ? rawPlayer.scores : [];
  const uncertain = new Set(Array.isArray(rawPlayer?.uncertainHoles) ? rawPlayer.uncertainHoles.map(Number) : []);

  const scores = Array.from({ length: 18 }, (_, index) => {
    const value = rawScores[index];
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
    name: String(rawPlayer?.name || fallbackName || '').trim() || fallbackName,
    scores,
    uncertainHoles: [...uncertain]
      .filter(n => Number.isInteger(n) && n >= 1 && n <= 18)
      .sort((a, b) => a - b)
  };
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
    throw new Error('The scorecard reader returned an unreadable response. Please try the photo again.');
  }
}

function friendlyError(error) {
  const message = String(error?.message || error || 'Unknown error');
  if (/429|rate limit|quota/i.test(message)) return 'The scorecard reader is temporarily rate-limited. Please wait a moment and try again.';
  if (/401|invalid.*key|api key/i.test(message)) return 'The OpenAI API key is missing or invalid in Netlify.';
  if (/payload|too large|request entity/i.test(message)) return 'The photo is too large. Please retake it a little closer and try again.';
  return message;
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


async function readSingleDigitCell(openai, cellBuffer) {
  const b64 = cellBuffer.toString('base64');
  const response = await openai.responses.create({
    model: process.env.OPENAI_VISION_MODEL || 'gpt-4.1',
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text:
          'Read exactly ONE handwritten golf score from this single score box. ' +
          'Return JSON only: {"digit":N,"uncertain":true|false}. ' +
          'N must be 1,2,3,4,5,6,7 or null. ' +
          'Ignore any circle around a birdie; read only the digit. ' +
          'If the box is blank or unclear, use null. Do not infer from golf logic.'
        },
        { type: 'input_image', image_url: `data:image/jpeg;base64,${b64}` }
      ]
    }],
    text: { format: { type: 'json_object' } }
  });
  const text = response.output_text || '{}';
  try {
    const parsed = JSON.parse(text);
    const d = parsed.digit;
    return {
      digit: [1,2,3,4,5,6,7].includes(d) ? d : null,
      uncertain: !!parsed.uncertain || ![1,2,3,4,5,6,7].includes(d)
    };
  } catch {
    return { digit: null, uncertain: true };
  }
}

async function cropRowInto18Cells(rowBuffer) {
  const meta = await sharp(rowBuffer).metadata();
  const width = meta.width || 1800;
  const height = meta.height || 120;

  // The player-row crop should already span Hole 1 through Hole 18.
  // Split evenly into 18 cells. A small inner inset trims printed grid lines.
  const cells = [];
  for (let i = 0; i < 18; i++) {
    const x0 = Math.floor((i * width) / 18);
    const x1 = Math.floor(((i + 1) * width) / 18);
    const cellW = Math.max(1, x1 - x0);
    const insetX = Math.min(3, Math.floor(cellW * 0.08));
    const insetY = Math.min(3, Math.floor(height * 0.08));
    const left = Math.min(width - 1, x0 + insetX);
    const top = Math.min(height - 1, insetY);
    const w = Math.max(1, Math.min(width - left, cellW - insetX * 2));
    const h = Math.max(1, Math.min(height - top, height - insetY * 2));
    const buf = await sharp(rowBuffer)
      .extract({ left, top, width: w, height: h })
      .resize({ width: 180, height: 180, fit: 'contain', background: '#ffffff' })
      .jpeg({ quality: 92 })
      .toBuffer();
    cells.push(buf);
  }
  return cells;
}

async function read18Cells(openai, rowBuffer) {
  const cells = await cropRowInto18Cells(rowBuffer);
  const scores = [];
  const uncertainHoles = [];
  for (let i = 0; i < cells.length; i++) {
    const result = await readSingleDigitCell(openai, cells[i]);
    scores.push(result.digit);
    if (result.uncertain) uncertainHoles.push(i + 1);
  }
  return { scores, uncertainHoles };
}
