const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini';

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

    // Pass 1 deliberately binds every handwritten value to a printed hole column.
    const firstPrompt = `You are reading one handwritten Colonial Golf scorecard. Extract exactly ${playerCount} player rows in top-to-bottom order.

IMPORTANT: This is a GRID-ALIGNMENT task. Do not read a row as a free-form sequence. For every player, identify each score by the printed HOLE COLUMN it physically occupies: hole 1, then hole 2, through hole 18. Never shift a handwritten score one box left or right to make a sequence look plausible.

Read only handwritten player names and handwritten individual hole scores. Ignore printed par, handicap, yardage, OUT, IN, TOTAL, notes, circles, boxes, betting rows, 1-ball rows, 2-ball rows, and anything below the final player row.

Return ONLY valid JSON in this exact shape:
{"players":[{"name":"Paul","holes":{"1":6,"2":5,"3":6,"4":4,"5":5,"6":4,"7":4,"8":5,"9":4,"10":4,"11":4,"12":5,"13":3,"14":5,"15":4,"16":4,"17":5,"18":4},"uncertainHoles":[6]}]}

Rules:
- players must contain exactly ${playerCount} entries.
- holes must contain keys "1" through "18" exactly once for every player.
- Individual player scores must be one digit from 1 through 7 for this group.
- A score of 1 is possible but extremely rare. Always include a hole read as 1 in uncertainHoles.
- If a score is hard to read or its column position is uncertain, make your best 1-7 reading AND include that hole number in uncertainHoles. Do not move neighboring scores to fill the uncertainty.
- Pay special attention to repeated patterns such as 6,5,6 or 5,6,5. Preserve the exact left-to-right boxes; do not normalize or alternate them.
- If a name is uncertain, use your best reading. Names are less important than score-to-hole alignment.
- Do not include markdown fences or extra text.`;

    const firstRaw = await callVision(apiKey, imageDataUrl, firstPrompt);
    const first = normalizeHolePlayers(parseJson(extractOutputText(firstRaw)), playerCount);

    // Pass 2 is an independent audit against the image and the first extraction.
    const verifyPrompt = `You are the verification pass for a handwritten Colonial Golf scorecard. The first pass produced the candidate JSON below.

CANDIDATE:
${JSON.stringify(toHoleShape(first))}

Re-read the ORIGINAL IMAGE independently, player by player and hole column by hole column. Verify every candidate value against the physical printed hole box. The main failure to catch is COLUMN SHIFTING (for example the image shows 6,5,6 in three adjacent boxes but the candidate says 5,6,5).

Return ONLY valid JSON in the same shape:
{"players":[{"name":"Paul","holes":{"1":6,"2":5,"3":6,"4":4,"5":5,"6":4,"7":4,"8":5,"9":4,"10":4,"11":4,"12":5,"13":3,"14":5,"15":4,"16":4,"17":5,"18":4},"uncertainHoles":[6]}]}

Rules:
- Exactly ${playerCount} players, top to bottom.
- Keys 1 through 18 exactly once per player.
- Scores 1 through 7 only.
- Correct the candidate whenever the image clearly shows a different value.
- If you cannot confidently decide a box, keep the best reading but include that specific hole in uncertainHoles.
- If your verified value differs from the candidate, include that hole in uncertainHoles even when you are confident in the correction, so the user notices it.
- Never shift a row left or right.
- Do not include commentary or markdown.`;

    const verifyRaw = await callVision(apiKey, imageDataUrl, verifyPrompt);
    const verified = normalizeHolePlayers(parseJson(extractOutputText(verifyRaw)), playerCount);

    // Mark every disagreement between passes for human review.
    verified.players.forEach((player, playerIndex) => {
      const firstPlayer = first.players[playerIndex];
      const uncertain = new Set(player.uncertainHoles || []);
      for (let i = 0; i < 18; i++) {
        if (player.scores[i] !== firstPlayer.scores[i]) uncertain.add(i + 1);
        if (player.scores[i] === 1) uncertain.add(i + 1);
      }
      player.uncertainHoles = [...uncertain].sort((a, b) => a - b);
    });

    return reply(200, verified);
  } catch (error) {
    console.error(error);
    return reply(500, { error: error.message || 'Unable to read this scorecard.' });
  }
};

async function callVision(apiKey, imageDataUrl, prompt) {
  const apiResponse = await fetch('https://api.openai.com/v1/responses', {
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
      max_output_tokens: 2600
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
  if (start < 0 || end < start) throw new Error('The reader did not return valid score data. Try a clearer photo.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeHolePlayers(data, expectedPlayers) {
  if (!data || !Array.isArray(data.players) || data.players.length !== expectedPlayers) {
    throw new Error(`Expected ${expectedPlayers} players, but the scorecard could not be read reliably.`);
  }

  return {
    players: data.players.map((player, index) => {
      const holes = player.holes || {};
      const scores = [];
      for (let hole = 1; hole <= 18; hole++) {
        const score = Number(holes[String(hole)] ?? holes[hole]);
        if (!Number.isInteger(score) || score < 1 || score > 7) {
          throw new Error(`Hole ${hole} for player ${index + 1} was not read as a valid 1-7 score.`);
        }
        scores.push(score);
      }
      const uncertain = Array.isArray(player.uncertainHoles)
        ? player.uncertainHoles.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 18)
        : [];
      scores.forEach((score, i) => { if (score === 1 && !uncertain.includes(i + 1)) uncertain.push(i + 1); });
      return {
        name: String(player.name || '').trim(),
        scores,
        uncertainHoles: [...new Set(uncertain)].sort((a, b) => a - b)
      };
    })
  };
}

function toHoleShape(data) {
  return {
    players: data.players.map(player => ({
      name: player.name,
      holes: Object.fromEntries(player.scores.map((score, index) => [String(index + 1), score])),
      uncertainHoles: player.uncertainHoles || []
    }))
  };
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
