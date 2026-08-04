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

    const prompt = `You are reading one handwritten Colonial Golf scorecard. Extract exactly ${playerCount} player rows, in top-to-bottom order. The first extracted player will be used only as the card label (Team FirstName).

Read only handwritten player names and the 18 handwritten hole scores for each player. Ignore printed par, handicap, yardage, totals, notes, betting rows, 1-ball rows, 2-ball rows, circles, boxes, and marks below the final player row.

Return ONLY valid JSON in this exact shape:
{"players":[{"name":"Paul","scores":[4,5,4,3,5,4,4,5,4,4,4,5,3,5,4,4,5,4],"uncertainHoles":[6]}]}

Rules:
- players must contain exactly ${playerCount} entries.
- scores must contain exactly 18 integers per player.
- Valid golf scores are 1 through 15.
- uncertainHoles uses 1-based hole numbers and must list every score you are not highly confident about.
- If a name is uncertain, use your best reading; do not add commentary.
- Never calculate or copy OUT, IN, or TOTAL columns into the 18 scores.
- Do not include markdown fences or extra text.`;

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
        max_output_tokens: 2200
      })
    });

    const raw = await apiResponse.json();
    if (!apiResponse.ok) {
      const message = raw?.error?.message || `OpenAI request failed (${apiResponse.status}).`;
      return reply(apiResponse.status, { error: message });
    }

    const text = extractOutputText(raw);
    if (!text) return reply(502, { error: 'The reader returned no score data.' });
    const parsed = parseJson(text);
    validate(parsed, playerCount);
    return reply(200, parsed);
  } catch (error) {
    console.error(error);
    return reply(500, { error: error.message || 'Unable to read this scorecard.' });
  }
};

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
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The reader did not return valid JSON. Try a clearer photo.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function validate(data, expectedPlayers) {
  if (!data || !Array.isArray(data.players) || data.players.length !== expectedPlayers) {
    throw new Error(`Expected ${expectedPlayers} players, but the scorecard could not be read reliably.`);
  }
  data.players.forEach((player, index) => {
    if (!Array.isArray(player.scores) || player.scores.length !== 18) {
      throw new Error(`Player ${index + 1} does not have 18 readable scores.`);
    }
    player.scores = player.scores.map(value => {
      const score = Number(value);
      if (!Number.isInteger(score) || score < 1 || score > 15) throw new Error(`An invalid score was found for player ${index + 1}.`);
      return score;
    });
    player.name = String(player.name || '').trim();
    player.uncertainHoles = Array.isArray(player.uncertainHoles)
      ? player.uncertainHoles.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 18)
      : [];
  });
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
