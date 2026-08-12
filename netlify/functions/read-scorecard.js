const sharp = require('sharp');

const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1';

// Colonial template ratios inside the detected physical card rectangle.
// Front nine and back nine are separated by the OUT column gap.
const HOLE_X_RATIOS = [
  0.155, 0.189, 0.223, 0.257, 0.291, 0.325, 0.359, 0.393, 0.427,
  0.515, 0.549, 0.583, 0.617, 0.651, 0.685, 0.719, 0.753, 0.787
];

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
      .jpeg({ quality: 95 })
      .toBuffer();

    const meta = await sharp(normalizedBuffer).metadata();
    const width = meta.width;
    const height = meta.height;
    const normalizedDataUrl = `data:image/jpeg;base64,${normalizedBuffer.toString('base64')}`;

    // PASS 1: geometry only. Locate physical card + each handwritten player row.
    const locatorPrompt = `
Look at this ONE Colonial Golf Club scorecard.

Do NOT read any score digits.

Find:
1) the outer physical scorecard rectangle;
2) every handwritten player row in the main player block above the printed PAR row.

For each handwritten player row:
- read the handwritten player name;
- return a tight rowBox spanning the player's row from the name area through Hole 18,
  but not the row above or below.

Ignore printed PAR, HANDICAP, yardage, scorer/attest/date rows and any handwritten row below PAR.

Coordinates are normalized integers 0-1000 relative to THIS image.

Return JSON only:
{
  "cardBox":{"left":0,"top":0,"right":0,"bottom":0},
  "players":[
    {"name":"string","rowBox":{"left":0,"top":0,"right":0,"bottom":0}}
  ]
}
`;

    const locatorText = extractOutputText(await callVision(
      apiKey, locatorPrompt, normalizedDataUrl, 1000
    ));
    const locator = parseJson(locatorText);

    const cardBox = normalizeBox(locator?.cardBox, 200, 150);
    const locatedPlayers = normalizeLocatedPlayers(locator?.players);

    if (!cardBox || !locatedPlayers.length) {
      return reply(200, {
        players: [],
        debug: { locatorPass: locatorText },
        warning: 'Could not confidently locate the card/player rows.',
        ocrMode: 'isolated-cell-diagnostic-v5.6'
      });
    }

    const cardPx = normBoxToPixels(cardBox, width, height);
    const cardWidth = cardPx.right - cardPx.left;

    // Build a labeled composite of large isolated cells for all players.
    // The whole original photo is also supplied to the reader as context.
    const playerPanels = [];
    const debugPlayers = [];

    for (let pIndex = 0; pIndex < locatedPlayers.length; pIndex++) {
      const loc = locatedPlayers[pIndex];
      const rowPx = normBoxToPixels(loc.rowBox, width, height);
      const rowCenterY = Math.round((rowPx.top + rowPx.bottom) / 2);
      const rowHeight = Math.max(24, rowPx.bottom - rowPx.top);

      // Crop size intentionally generous around the handwritten digit.
      const normalSpacing = 0.034 * cardWidth;
      const cropW = Math.max(28, Math.round(normalSpacing * 0.92));
      const cropH = Math.max(34, Math.round(rowHeight * 1.55));

      const cells = [];
      const cellDebug = [];

      for (let h = 0; h < 18; h++) {
        const cx = Math.round(cardPx.left + HOLE_X_RATIOS[h] * cardWidth);
        const left = clamp(Math.round(cx - cropW/2), 0, width - 1);
        const top = clamp(Math.round(rowCenterY - cropH/2), 0, height - 1);
        const right = clamp(left + cropW, left + 1, width);
        const bottom = clamp(top + cropH, top + 1, height);

        const cell = await sharp(normalizedBuffer)
          .extract({ left, top, width: right-left, height: bottom-top })
          .resize({ width: 180, height: 180, fit: 'contain', background: '#ffffff' })
          .jpeg({ quality: 96 })
          .toBuffer();

        cells.push(cell);
        cellDebug.push({
          hole: h+1,
          left, top, right, bottom,
          imageDataUrl: `data:image/jpeg;base64,${cell.toString('base64')}`
        });
      }

      const panel = await makePlayerPanel(loc.name, cells, pIndex);
      playerPanels.push(panel);
      debugPlayers.push({
        name: loc.name,
        rowBox: loc.rowBox,
        rowCenterY,
        cells: cellDebug
      });
    }

    const composite = await stackPlayerPanels(playerPanels);
    const compositeDataUrl = `data:image/jpeg;base64,${composite.toString('base64')}`;

    // PASS 2: read the isolated cells, while also seeing the original photo for context.
    const expectedNames = locatedPlayers.map(p => p.name);

    const readPrompt = `
You are reading isolated handwritten score cells from ONE Colonial Golf Club scorecard.

Image 1 is the ORIGINAL full scorecard photo for context.
Image 2 is a diagnostic composite built from the same photo:
- one panel per handwritten player;
- each panel contains 18 LARGE isolated score-cell crops;
- holes are labeled 1 through 18;
- panels are stacked top-to-bottom in this player order:
${JSON.stringify(expectedNames)}

Read the score from EACH isolated crop in Image 2.

Rules:
- Use Image 1 only as context to verify player/row identity.
- Use the enlarged isolated crop in Image 2 as the primary source for the digit.
- Do not read printed PAR/HANDICAP/yardage numbers.
- Do not infer missing values from golf expectations.
- Never default to 4.
- If a crop does not clearly show one handwritten digit, return null.
- Circled birdie: read the digit inside the circle.
- Scores are normally 1-7.
- A 1 must be uncertain.
- Return exactly 18 entries per player in hole order.

Return JSON only:
{
  "players": [
    {
      "name": "string",
      "scores": [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null],
      "uncertainHoles": []
    }
  ]
}
`;

    const readText = extractOutputText(await callVisionMulti(
      apiKey,
      readPrompt,
      [normalizedDataUrl, compositeDataUrl],
      2200
    ));

    let readPlayers = normalizePlayers(parseJson(readText)?.players);

    // Preserve locator names/order.
    const players = locatedPlayers.map((loc, i) => {
      const r = readPlayers[i] || {
        name: loc.name,
        scores: Array(18).fill(null),
        uncertainHoles: Array.from({length:18}, (_,n)=>n+1)
      };
      return {
        name: loc.name || r.name,
        scores: r.scores,
        uncertainHoles: r.uncertainHoles
      };
    });

    return reply(200, {
      players,
      debug: {
        locatorPass: locatorText,
        isolatedCellReadPass: readText,
        locatedPlayers: debugPlayers
      },
      ocrMode: 'isolated-cell-diagnostic-v5.6'
    });

  } catch (error) {
    console.error('v5.6 isolated-cell diagnostic failure:', error);
    return reply(500, {
      error: error?.message || 'Isolated-cell reading failed.',
      errorName: error?.name || 'Error',
      ocrMode: 'isolated-cell-diagnostic-v5.6'
    });
  }
};

async function makePlayerPanel(name, cells, playerIndex) {
  const cols = 9;
  const cellW = 180;
  const cellH = 180;
  const labelH = 54;
  const gap = 12;
  const headerH = 70;
  const panelW = cols * cellW + (cols-1)*gap;
  const panelH = headerH + 2*(cellH + labelH) + gap;

  const base = sharp({
    create: {
      width: panelW,
      height: panelH,
      channels: 3,
      background: '#ffffff'
    }
  });

  const overlays = [];

  const headerSvg = Buffer.from(
    `<svg width="${panelW}" height="${headerH}">
       <rect width="100%" height="100%" fill="white"/>
       <text x="20" y="45" font-family="Arial" font-size="38" font-weight="700" fill="black">
         Player ${playerIndex+1}: ${escapeXml(name)}
       </text>
     </svg>`
  );
  overlays.push({ input: headerSvg, left: 0, top: 0 });

  for (let i = 0; i < 18; i++) {
    const row = i < 9 ? 0 : 1;
    const col = i % 9;
    const x = col * (cellW + gap);
    const y = headerH + row * (cellH + labelH + gap);

    overlays.push({ input: cells[i], left: x, top: y });

    const labelSvg = Buffer.from(
      `<svg width="${cellW}" height="${labelH}">
         <rect width="100%" height="100%" fill="white"/>
         <text x="${cellW/2}" y="38" text-anchor="middle"
           font-family="Arial" font-size="30" font-weight="700" fill="black">
           Hole ${i+1}
         </text>
       </svg>`
    );
    overlays.push({ input: labelSvg, left: x, top: y + cellH });
  }

  return base.composite(overlays).jpeg({ quality: 96 }).toBuffer();
}

async function stackPlayerPanels(panels) {
  const gap = 30;
  const metas = await Promise.all(panels.map(p => sharp(p).metadata()));
  const width = Math.max(...metas.map(m => m.width));
  const totalHeight = metas.reduce((sum,m)=>sum+m.height,0) + gap*(panels.length-1);

  let top = 0;
  const overlays = [];
  for (let i=0;i<panels.length;i++) {
    overlays.push({ input: panels[i], left: 0, top });
    top += metas[i].height + gap;
  }

  return sharp({
    create: { width, height: totalHeight, channels: 3, background: '#f2f2f2' }
  }).composite(overlays).jpeg({ quality: 94 }).toBuffer();
}

function normalizeLocatedPlayers(src) {
  if (!Array.isArray(src)) return [];
  const out = [];
  for (const item of src) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    const rowBox = normalizeBox(item.rowBox, 150, 8);
    if (name && rowBox) out.push({ name, rowBox });
  }
  return out.slice(0,5);
}

function normalizePlayers(src) {
  if (!Array.isArray(src)) return [];
  return src.filter(Boolean).map(item => {
    const scores = Array.from({length:18}, (_,i) => {
      const v = item?.scores?.[i];
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 7 ? n : null;
    });

    const uncertain = new Set(
      Array.isArray(item?.uncertainHoles)
        ? item.uncertainHoles.map(Number).filter(n => Number.isInteger(n) && n>=1 && n<=18)
        : []
    );

    scores.forEach((v,i) => {
      if (v == null || v === 1) uncertain.add(i+1);
    });

    return {
      name: String(item?.name || '').trim(),
      scores,
      uncertainHoles: [...uncertain].sort((a,b)=>a-b)
    };
  });
}

function normalizeBox(box, minW, minH) {
  if (!box || typeof box !== 'object') return null;
  const left = Number(box.left), top = Number(box.top), right = Number(box.right), bottom = Number(box.bottom);
  if (![left,top,right,bottom].every(Number.isFinite)) return null;
  if (left < 0 || top < 0 || right > 1000 || bottom > 1000) return null;
  if (right-left < minW || bottom-top < minH) return null;
  return {left,top,right,bottom};
}

function normBoxToPixels(box, width, height) {
  const left = clamp(Math.floor(box.left/1000*width),0,width-1);
  const top = clamp(Math.floor(box.top/1000*height),0,height-1);
  const right = clamp(Math.ceil(box.right/1000*width),left+1,width);
  const bottom = clamp(Math.ceil(box.bottom/1000*height),top+1,height);
  return {left,top,right,bottom};
}

function dataUrlToBuffer(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Invalid image data.');
  return Buffer.from(dataUrl.slice(comma+1),'base64');
}

async function callVision(apiKey, prompt, imageDataUrl, max_output_tokens) {
  return callVisionMulti(apiKey, prompt, [imageDataUrl], max_output_tokens);
}

async function callVisionMulti(apiKey, prompt, imageUrls, max_output_tokens) {
  const content = [{type:'input_text', text:prompt}];
  for (const url of imageUrls) content.push({type:'input_image', image_url:url, detail:'high'});

  const r = await fetch('https://api.openai.com/v1/responses', {
    method:'POST',
    headers:{
      'Authorization':`Bearer ${apiKey}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify({
      model:MODEL,
      input:[{role:'user',content}],
      max_output_tokens
    })
  });

  const raw = await r.json();
  if (!r.ok) throw new Error(raw?.error?.message || `OpenAI request failed (${r.status}).`);
  return raw;
}

function extractOutputText(r) {
  if (typeof r.output_text === 'string') return r.output_text;
  const parts=[];
  for (const item of r.output || []) {
    for (const c of item.content || []) {
      if (c.type==='output_text' && typeof c.text==='string') parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
}

function parseJson(text) {
  const c=String(text||'').trim()
    .replace(/^```(?:json)?\s*/i,'')
    .replace(/\s*```$/i,'');
  try { return JSON.parse(c); } catch (_) {
    const a=c.indexOf('{'), b=c.lastIndexOf('}');
    if (a>=0 && b>a) return JSON.parse(c.slice(a,b+1));
    throw new Error('The isolated-cell reader returned an unreadable response.');
  }
}

function clamp(v,min,max) {
  return Math.max(min,Math.min(max,v));
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, ch => ({
    '<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'
  }[ch]));
}

function reply(statusCode, body) {
  return {
    statusCode,
    headers:{
      'Content-Type':'application/json',
      'Cache-Control':'no-store'
    },
    body:JSON.stringify(body)
  };
}
