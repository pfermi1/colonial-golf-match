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

    // v1.4 intentionally sends the COMPLETE scorecard image to vision. We do
    // not crop or infer grid coordinates in code. The model is instructed to
    // use the printed Colonial hole columns as anchors and return null when a
    // value is uncertain rather than shifting neighboring scores.
    const primary = await readWholeCard(apiKey, imageDataUrl, playerCount);
    const normalized = normalizePrimary(primary, playerCount);

    // Only holes the first pass itself marked uncertain/blank/invalid are sent
    // through a second verification pass. A verified value is filled only when
    // the second pass is explicit; otherwise the cell remains blank/highlighted.
    const uncertainRefs = collectUncertainRefs(normalized.players);
    if (uncertainRefs.length) {
      const verified = await verifyUncertainCells(apiKey, imageDataUrl, normalized.players, uncertainRefs);
      applyVerifiedCells(normalized.players, verified);
    }

    // A score of 1 is always review-required for this group. Never hide it.
    normalized.players.forEach(player => {
      player.scores.forEach((score, i) => {
        if (score === 1 && !player.uncertainHoles.includes(i + 1)) player.uncertainHoles.push(i + 1);
        if (score == null && !player.uncertainHoles.includes(i + 1)) player.uncertainHoles.push(i + 1);
      });
      player.uncertainHoles = [...new Set(player.uncertainHoles)].sort((a, b) => a - b);
    });

    return reply(200, {
      players: normalized.players,
      ocrMode: 'whole-card-hole-anchored-v1.4',
      warning: normalized.players.some(p => p.uncertainHoles.length)
        ? 'Please review the yellow holes. Unclear values were left blank or flagged instead of shifting neighboring scores.'
        : undefined
    });
  } catch (error) {
    console.error('v1.4 scorecard read failed:', error);
    return reply(500, { error: friendlyError(error) });
  }
};

async function readWholeCard(apiKey, imageDataUrl, playerCount) {
  const prompt = `
You are reading ONE photographed Colonial Golf Club paper scorecard.

The printed scorecard has fixed hole columns 1 through 9 on the FRONT and 10 through 18 on the BACK. There may be yardages, handicaps, PAR, OUT, IN, TOT, HCP, NET, and other printed numbers. IGNORE all printed numbers except the printed hole numbers, which are only visual anchors.

Read exactly ${playerCount} handwritten PLAYER rows, top-to-bottom, from the score-entry area immediately above the printed PAR row. Read the handwritten player name at the left of each row and each handwritten hole score from its physical printed hole column.

CRITICAL ALIGNMENT RULES:
- Treat every hole as a named physical column: Hole 1, Hole 2, ... Hole 18.
- NEVER read a row as a loose sequence and NEVER shift values left or right.
- A score visible under Hole 6 belongs ONLY to Hole 6.
- If a cell is blank, obscured, ambiguous, between columns, or you are not confident which digit belongs in that exact cell, return null for THAT hole.
- NEVER borrow a score from an adjacent hole.
- NEVER invent a final score to make 18 entries.
- Individual handwritten player scores for this test group are normally integers 1 through 7. If the image appears to show anything outside 1-7, return null and mark that hole uncertain.
- A 1 is possible but rare: return 1 if clearly written, and also mark that hole uncertain for human confirmation.
- Do NOT read handwritten 1-ball, 2-ball, 2+3-ball, totals, or betting rows as player rows.
- Do NOT calculate front/back/total. Only transcribe player names and the 18 physical score cells.

Return ONLY JSON in this exact shape:
{
  "players": [
    {
      "name": "Paul",
      "scores": [5,4,3,4,3,4,5,5,4,4,4,4,5,4,5,5,4,4],
      "uncertainHoles": [7]
    }
  ]
}
There must be exactly ${playerCount} player objects and exactly 18 score entries per player. Use null for unreadable cells.`;

  const raw = await callVision(apiKey, [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
  ], 2400);

  return parseJson(extractOutputText(raw));
}

async function verifyUncertainCells(apiKey, imageDataUrl, players, refs) {
  const requestList = refs.map(ref => {
    const playerName = players[ref.playerIndex]?.name || `Player ${ref.playerIndex + 1}`;
    return `playerIndex=${ref.playerIndex}, playerName=${JSON.stringify(playerName)}, hole=${ref.hole}`;
  }).join('\n');

  const primaryContext = players.map((p, i) => ({
    playerIndex: i,
    name: p.name,
    scores: p.scores
  }));

  const prompt = `
This is a SECOND-PASS verification of a Colonial Golf Club scorecard. Do NOT reread or rewrite the entire card.

The first pass produced this context:
${JSON.stringify(primaryContext)}

Verify ONLY these exact physical player/hole cells against the photographed scorecard:
${requestList}

Use the printed hole-number columns as anchors. Never shift a digit from a neighboring hole. Valid individual scores are 1-7. If you cannot clearly verify the digit in the requested exact cell, return null.

Return ONLY JSON:
{
  "checks": [
    {"playerIndex":0,"hole":4,"score":5,"confident":true}
  ]
}
Include one check for every requested cell, in the same order. If uncertain, use score:null and confident:false.`;

  try {
    const raw = await callVision(apiKey, [
      { type: 'input_text', text: prompt },
      { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
    ], Math.max(700, refs.length * 90));
    const parsed = parseJson(extractOutputText(raw));
    return Array.isArray(parsed.checks) ? parsed.checks : [];
  } catch (error) {
    console.warn('Uncertain-cell verification skipped:', error.message);
    return [];
  }
}

function normalizePrimary(data, playerCount) {
  const source = Array.isArray(data?.players) ? data.players.slice(0, playerCount) : [];
  const players = [];

  for (let i = 0; i < playerCount; i++) {
    const rawPlayer = source[i] || {};
    const rawScores = Array.isArray(rawPlayer.scores) ? rawPlayer.scores : [];
    const uncertain = new Set(Array.isArray(rawPlayer.uncertainHoles) ? rawPlayer.uncertainHoles.map(Number) : []);
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

    players.push({
      name: String(rawPlayer.name || '').trim() || `Player ${i + 1}`,
      scores,
      uncertainHoles: [...uncertain].filter(n => Number.isInteger(n) && n >= 1 && n <= 18).sort((a, b) => a - b)
    });
  }

  return { players };
}

function collectUncertainRefs(players) {
  const refs = [];
  players.forEach((player, playerIndex) => {
    const holes = new Set(player.uncertainHoles || []);
    player.scores.forEach((score, i) => { if (score == null) holes.add(i + 1); });
    [...holes].sort((a, b) => a - b).forEach(hole => refs.push({ playerIndex, hole }));
  });
  // Prevent a pathological image from turning the verifier into another full
  // card read. If most cells are uncertain, human review is safer and faster.
  return refs.slice(0, 24);
}

function applyVerifiedCells(players, checks) {
  if (!Array.isArray(checks)) return;
  for (const check of checks) {
    const playerIndex = Number(check?.playerIndex);
    const hole = Number(check?.hole);
    const score = Number(check?.score);
    const confident = check?.confident === true;
    if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= players.length) continue;
    if (!Number.isInteger(hole) || hole < 1 || hole > 18) continue;
    if (!confident || !Number.isInteger(score) || score < 1 || score > 7) continue;

    players[playerIndex].scores[hole - 1] = score;
    // Keep a genuine-looking 1 highlighted for manual hole-in-one confirmation.
    if (score !== 1) {
      players[playerIndex].uncertainHoles = players[playerIndex].uncertainHoles.filter(h => h !== hole);
    }
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
  if (start < 0 || end < start) throw new Error('The AI response did not contain usable scorecard data.');
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (error) {
    throw new Error('The AI returned incomplete scorecard data. Please try the same photo once more.');
  }
}

function friendlyError(error) {
  const message = String(error?.message || 'Unable to read this scorecard.');
  if (/string did not match|expected pattern/i.test(message)) {
    return 'The image could not be sent to the reader in the expected format. Please refresh the app and choose the photo again.';
  }
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
