const MODEL = 'gpt-5.6-sol';

exports.handler = async function(event) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return reply(500, { error: 'OPENAI_API_KEY is not configured in Netlify.' });
  }

  try {
    if (event.httpMethod === 'GET') {
      const responseId = String(event.queryStringParameters?.responseId || '').trim();
      if (!/^resp_[A-Za-z0-9_-]+$/.test(responseId)) {
        return reply(400, { error: 'A valid OpenAI responseId is required.' });
      }

      const response = await fetch(`https://api.openai.com/v1/responses/${encodeURIComponent(responseId)}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      const raw = await response.json();
      if (!response.ok) {
        return reply(response.status, {
          error: raw?.error?.message || `OpenAI polling failed (${response.status}).`,
          errorName: 'OpenAIPollError'
        });
      }

      return finishOrWait(raw);
    }

    if (event.httpMethod !== 'POST') {
      return reply(405, { error: 'Method not allowed.' });
    }

    const body = JSON.parse(event.body || '{}');
    const imageDataUrl = body.imageDataUrl;
    const expectedPlayers = Number(body.expectedPlayers);

    if (!imageDataUrl || !/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(imageDataUrl)) {
      return reply(400, { error: 'A scorecard image is required.' });
    }

    const playerHint = Number.isInteger(expectedPlayers) && expectedPlayers >= 1 && expectedPlayers <= 5
      ? `The user expects about ${expectedPlayers} handwritten player rows, but use the image itself as the source of truth.`
      : 'Identify all handwritten player score rows visible in the main scoring section.';

    const semanticPrompt = `
You are reading a photograph of a golf scorecard.

IMPORTANT: Work directly from the ENTIRE photograph exactly as supplied. The scorecard may be rotated, tilted, surrounded by table/background, or occupy only part of the image. Mentally orient the physical scorecard so the printed HOLE sequence runs 1 through 9, OUT, then 10 through 18.

${playerHint}

Your task:
- Find the MAIN handwritten player-score section of the scorecard.
- Read HANDWRITTEN scores only. Ignore printed yardages, printed handicaps, pars, tee ratings, totals, course labels and other printed numbers.
- Identify each handwritten player name in top-to-bottom order.
- For each player, follow that SAME handwritten row across the card.
- Read holes 1 through 9 in order, skip the OUT total cell, then read holes 10 through 18 in order.
- Each score should normally be a single handwritten integer from 1 through 7. If a handwritten score is truly unreadable, return null rather than borrowing a nearby printed number.
- Do not use printed OUT/IN/TOT values as hole scores.
- Do not invent a player from the PAR row or scorer/attest area.

Return JSON only in exactly this shape:
{
  "players": [
    {
      "name": "handwritten player name",
      "scores": [18 values, each an integer 1-7 or null],
      "uncertainHoles": [hole numbers that are genuinely unclear]
    }
  ]
}

Before returning, silently confirm that every player has exactly 18 hole entries and that every value came from handwriting in that player's row.
`;

    // v6.1.4 transport-only change: create the same GPT-5.6 read in OpenAI
    // background mode. Netlify can return immediately, and the browser polls
    // for completion in short requests instead of holding one long connection.
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        background: true,
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: semanticPrompt },
            { type: 'input_image', image_url: imageDataUrl, detail: 'original' }
          ]
        }],
        max_output_tokens: 2200
      })
    });

    const raw = await response.json();
    if (!response.ok) {
      return reply(response.status, {
        error: raw?.error?.message || `OpenAI request failed (${response.status}).`,
        errorName: 'OpenAIStartError'
      });
    }

    return finishOrWait(raw);
  } catch (error) {
    console.error('v6.1.4 GPT-5.6 background transport failure:', error);

    if (error?.name === 'VisionParseError') {
      return reply(200, {
        players: [],
        diagnosticFailure: true,
        debug: {
          semanticMode: true,
          directFullImage: true,
          transportMode: 'openai-background-polling',
          semanticModel: MODEL,
          semanticImageDetail: 'original',
          parseFailure: {
            stage: error.stage || 'direct full-image semantic score read',
            rawResponse: error.rawResponse || '',
            cleanedResponse: error.cleanedResponse || '',
            parserError: error.initialParseError || error.message || ''
          }
        },
        warning: 'GPT-5.6 returned a score response that could not be parsed.',
        ocrMode: 'gpt-5.6-sol-direct-full-image-background-v6.1.4'
      });
    }

    return reply(500, {
      error: error?.message || 'GPT-5.6 Sol background scorecard read failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'gpt-5.6-sol-direct-full-image-background-v6.1.4'
    });
  }
};

function finishOrWait(raw) {
  const status = String(raw?.status || '').toLowerCase();
  const responseId = String(raw?.id || '');

  if (status && status !== 'completed') {
    if (status === 'failed' || status === 'cancelled' || status === 'incomplete') {
      return reply(500, {
        error: raw?.error?.message || raw?.incomplete_details?.reason || `OpenAI response ended with status ${status}.`,
        errorName: 'OpenAIResponseError',
        responseId,
        openaiStatus: status
      });
    }
    return reply(202, {
      pending: true,
      responseId,
      openaiStatus: status || 'in_progress',
      ocrMode: 'gpt-5.6-sol-direct-full-image-background-v6.1.4'
    });
  }

  const semanticText = extractOutputText(raw);
  const parsed = parseJson(semanticText, 'direct full-image semantic score read');
  const rawPlayers = Array.isArray(parsed?.players) ? parsed.players : [];

  const players = rawPlayers.slice(0, 5).map((player, index) => {
    const scores = Array.isArray(player?.scores) ? player.scores.slice(0, 18) : [];
    while (scores.length < 18) scores.push(null);

    const cleanedScores = scores.map(value => {
      if (value === null || value === undefined || value === '') return null;
      const n = Number(value);
      return Number.isInteger(n) && n >= 1 && n <= 7 ? n : null;
    });

    const modelUncertain = Array.isArray(player?.uncertainHoles)
      ? player.uncertainHoles.map(Number).filter(h => Number.isInteger(h) && h >= 1 && h <= 18)
      : [];
    const nullHoles = cleanedScores.map((v, i) => v === null ? i + 1 : null).filter(Boolean);

    return {
      name: String(player?.name || `Player ${index + 1}`).trim(),
      scores: cleanedScores,
      uncertainHoles: [...new Set([...modelUncertain, ...nullHoles])].sort((a, b) => a - b)
    };
  });

  return reply(200, {
    players,
    debug: {
      semanticMode: true,
      directFullImage: true,
      preprocessingPassCount: 0,
      semanticPassCount: 1,
      semanticModel: MODEL,
      semanticImageDetail: 'original',
      transportMode: 'openai-background-polling',
      responseId,
      semanticRowRead: semanticText,
      semanticParsed: parsed
    },
    ocrMode: 'gpt-5.6-sol-direct-full-image-background-v6.1.4'
  });
}

function extractOutputText(r) {
  if (typeof r?.output_text === 'string') return r.output_text;
  const parts = [];
  for (const item of r?.output || []) {
    for (const c of item.content || []) {
      if (c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
}

function parseJson(text, stage = 'unknown stage') {
  const rawText = String(text || '');
  const c = rawText.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

  try {
    return JSON.parse(c);
  } catch (firstError) {
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < c.length; i++) {
      const ch = c[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}' && depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          const candidate = c.slice(start, i + 1);
          try { return JSON.parse(candidate); } catch (_) {}
          start = -1;
        }
      }
    }

    const error = new Error(`GPT-5.6 returned unreadable JSON during ${stage}.`);
    error.name = 'VisionParseError';
    error.stage = stage;
    error.rawResponse = rawText;
    error.cleanedResponse = c;
    error.initialParseError = firstError?.message || String(firstError);
    throw error;
  }
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
