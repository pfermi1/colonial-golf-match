const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini';

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
    const names = await locatePlayerNames(apiKey, imageDataUrl, playerCount);
    const players = [];

    for (let playerIndex = 0; playerIndex < playerCount; playerIndex++) {
      const name = String(names[playerIndex] || '').trim() || `Player ${playerIndex + 1}`;
      const row = await readOnePlayerRow(apiKey, imageDataUrl, playerIndex, name, playerCount);
      players.push(normalizePlayerRow(row, name));
    }

    return reply(200, {
      players,
      ocrMode: 'independent-player-row-v1.5',
      warning: players.some(p => p.uncertainHoles.length)
        ? 'Please review the yellow holes. Each player row was read independently; unclear cells were left blank or flagged.'
        : undefined
    });
  } catch (error) {
    console.error('v1.5 scorecard read failed:', error);
    return reply(500, { error: friendlyError(error) });
  }
};

async function locatePlayerNames(apiKey, imageDataUrl, playerCount) {
  const prompt = `
You are looking at ONE photographed Colonial Golf Club paper scorecard.

Your only job in this first pass is to identify the ${playerCount} handwritten PLAYER NAMES in the score-entry area immediately above the printed PAR row.

Rules:
- Read the player names top-to-bottom.
- Do NOT read any hole scores in this pass.
- Ignore handwritten betting rows, 1 Ball, 2 Ball, 2+3 Ball, totals, scorer, attest, and printed course information.
- If a name is unclear, return a short best-effort label such as "Player 3" rather than using a score or printed word as the name.

Return ONLY JSON:
{
  "names": ["Paul", "Steve", "Dec", "Craig"]
}
There must be exactly ${playerCount} entries.`;

  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
  ], 500);

  const parsed = parseJson(extractOutputText(raw));
  const source = Array.isArray(parsed?.names) ? parsed.names.slice(0, playerCount) : [];
  while (source.length < playerCount) source.push(`Player ${source.length + 1}`);
  return source.map((name, i) => String(name || '').trim() || `Player ${i + 1}`);
}

async function readOnePlayerRow(apiKey, imageDataUrl, playerIndex, playerName, playerCount) {
  const ordinal = ordinalWord(playerIndex + 1);
  const prompt = `
You are reading ONE photographed Colonial Golf Club paper scorecard.

Read ONLY the ${ordinal} handwritten player row out of ${playerCount} player rows in the score-entry area immediately above the printed PAR row.
The player is labeled approximately ${JSON.stringify(playerName)}.

CRITICAL ROW-ISOLATION RULES:
- Ignore every handwritten score row above and below this one.
- Do NOT copy, borrow, average, infer, or continue a sequence from another player's row.
- Use the printed hole columns as fixed anchors: Hole 1 through Hole 9 on the front, then Hole 10 through Hole 18 on the back.
- Read exactly the score physically written in this player's row under each printed hole number.
- Do not treat the row as a loose string of digits. Hole 6 must come from the Hole 6 column, Hole 7 from Hole 7, etc.
- If one score is unclear or you are not certain the digit belongs to that exact hole, return null for that hole. Do not shift later scores left to fill the gap.
- Never invent Hole 18 simply to make 18 values.
- Ignore OUT, IN, TOT, HCP, NET, PAR, handicap, yardage, scorer, attest, and any handwritten 1 Ball / 2 Ball / 2+3 Ball row.
- Individual scores for this current group are normally integers 1 through 7. Anything else should be null and marked uncertain.
- A clearly written 1 may be returned as 1, but always include that hole in uncertainHoles for human hole-in-one confirmation.

Return ONLY JSON in this exact shape:
{
  "name": ${JSON.stringify(playerName)},
  "scores": [5,4,3,4,3,4,5,5,4,4,4,4,5,4,5,5,4,4],
  "uncertainHoles": [7]
}
There must be exactly 18 score entries. Use null for unreadable cells.`;

  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
  ], 950);

  return parseJson(extractOutputText(raw));
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
