const V2_2_TRUE_CELL_CROP_DIAGNOSTIC = true;

function normalizeOcrPlayersOnly(payload) {
  const rawPlayers = Array.isArray(payload?.players) ? payload.players : [];
  return rawPlayers
    .filter((p) => p && (p.name || (Array.isArray(p.scores) && p.scores.some(v => v !== null && v !== undefined && v !== ''))))
    .map((p) => ({
      ...p,
      name: typeof p.name === 'string' ? p.name.trim() : '',
      scores: Array.isArray(p.scores)
        ? p.scores.slice(0, 18).map((v) => {
            if (v === null || v === undefined || v === '') return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
          })
        : Array(18).fill(null)
    }));
}

function clearAllPriorCardStateV20() {
  try {
    const keys = Object.keys(localStorage);
    for (const key of keys) {
      if (/card|player|score|ocr|review|match|round|calc/i.test(key)) {
        try { localStorage.removeItem(key); } catch (_) {}
      }
    }
  } catch (_) {}
  try {
    const keys = Object.keys(sessionStorage);
    for (const key of keys) {
      if (/card|player|score|ocr|review|match|round|calc/i.test(key)) {
        try { sessionStorage.removeItem(key); } catch (_) {}
      }
    }
  } catch (_) {}
}


function clearPreviousOcrState() {
  try {
    [
      'currentCard','currentCardPhoto','ocrResult','reviewData',
      'calculatedCard','matchResults','pendingScores','pendingPlayers'
    ].forEach((k) => {
      try { localStorage.removeItem(k); } catch (_) {}
      try { sessionStorage.removeItem(k); } catch (_) {}
    });
  } catch (_) {}

  [
    '#review','#reviewScreen','#review-screen','#results',
    '#calculatedCard','#calculated-card','#matchups','#match-results'
  ].forEach((sel) => {
    const el = document.querySelector(sel);
    if (el) el.innerHTML = '';
  });
}

const cameraInput = document.querySelector('#cameraFile');
const libraryInput = document.querySelector('#libraryFile');
const preview = document.querySelector('#preview');
const readButton = document.querySelector('#readButton');
const status = document.querySelector('#status');
const playerCount = document.querySelector('#playerCount');
const roundPanel = document.querySelector('#roundPanel');
const uploadPanel = document.querySelector('#uploadPanel');
const reviewPanel = document.querySelector('#reviewPanel');
const ballCardPanel = document.querySelector('#ballCardPanel');
const comparisonPanel = document.querySelector('#comparisonPanel');
const playersEl = document.querySelector('#players');
const cardTitle = document.querySelector('#cardTitle');
const startOverButton = document.querySelector('#startOverButton');
const confirmButton = document.querySelector('#confirmButton');
const confirmMessage = document.querySelector('#confirmMessage');
const photoDialog = document.querySelector('#photoDialog');
const dialogImage = document.querySelector('#dialogImage');
const enlargeButton = document.querySelector('#enlargeButton');
const closeDialog = document.querySelector('#closeDialog');
const savedCardsEl = document.querySelector('#savedCards');
const addCardButton = document.querySelector('#addCardButton');
const cancelUploadButton = document.querySelector('#cancelUploadButton');
const newRoundButton = document.querySelector('#newRoundButton');
const backToCardsButton = document.querySelector('#backToCardsButton');
const reviewOriginalButton = document.querySelector('#reviewOriginalButton');
const ballCardTitle = document.querySelector('#ballCardTitle');
const ballCardContent = document.querySelector('#ballCardContent');
const matchupsSection = document.querySelector('#matchupsSection');
const matchupsEl = document.querySelector('#matchups');
const comparisonTitle = document.querySelector('#comparisonTitle');
const comparisonContent = document.querySelector('#comparisonContent');
const backFromComparisonButton = document.querySelector('#backFromComparisonButton');
const holeDialog = document.querySelector('#holeDialog');
const holeDialogContent = document.querySelector('#holeDialogContent');
const closeHoleDialog = document.querySelector('#closeHoleDialog');
const geometryDiagnosticPanel = document.querySelector('#geometryDiagnosticPanel');
const geometryDiagnosticGrid = document.querySelector('#geometryDiagnosticGrid');
const geometryDiagnosticMeta = document.querySelector('#geometryDiagnosticMeta');
const backFromGeometryButton = document.querySelector('#backFromGeometryButton');

let pendingRawPayload = null;

const STORAGE_KEY = 'colonialGolfMatchCardsV04';
let imageDataUrl = '';
let currentData = null;
let editingCardId = null;
let activeBallCardId = null;
let savedCards = loadCards();

renderSavedCards();

addCardButton.addEventListener('click', () => showPanel(uploadPanel));
cancelUploadButton.addEventListener('click', () => {
  resetUpload();
  showPanel(roundPanel);
});
newRoundButton.addEventListener('click', () => {
  if (!savedCards.length || window.confirm('Clear all confirmed cards for this round?')) {
    savedCards = [];
    saveCards();
    renderSavedCards();
  }
});
backToCardsButton.addEventListener('click', () => showPanel(roundPanel));
reviewOriginalButton.addEventListener('click', () => {
  const card = savedCards.find(item => item.id === activeBallCardId);
  if (card) openCardForReview(card);
});
backFromComparisonButton.addEventListener('click', () => showPanel(roundPanel));

cameraInput.addEventListener('change', () => prepareSelectedPhoto(cameraInput));
libraryInput.addEventListener('change', () => prepareSelectedPhoto(libraryInput));


async function readErrorResponse(response) {
  const raw = await response.text();
  try {
    const data = JSON.parse(raw);
    return data?.error ? `${data.error}${data.errorName ? ` (${data.errorName})` : ''}` : raw;
  } catch {
    return raw || `Request failed with status ${response.status}`;
  }
}

async function prepareSelectedPhoto(input) {
  const file = input.files?.[0];
  if (!file) return;
  status.textContent = 'Preparing photo...';
  try {
    imageDataUrl = await resizeImage(file, 2400, 0.90);
    preview.src = imageDataUrl;
    preview.classList.remove('hidden');
    readButton.disabled = false;
    status.textContent = 'Photo ready.';
  } catch (error) {
    status.textContent = `Could not prepare photo: ${error.message}`;
  }
}

readButton.addEventListener('click', async () => {
  if (!imageDataUrl) return;
  readButton.disabled = true;
  status.textContent = 'Locating the physical card and first player name, then applying the v3.6 downward Y calibration while keeping the v3.2 X positions unchanged...';
  try {
    const response = await fetch('/.netlify/functions/read-scorecard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataUrl, expectedPlayers: Number(playerCount.value) })
    });
    if (!response.ok) throw new Error(await readErrorResponse(response));
      const payload = await response.json();
    renderGeometryDiagnostics(payload);
    showPanel(geometryDiagnosticPanel);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    status.textContent = error.message;
    readButton.disabled = false;
  }
});

startOverButton.addEventListener('click', () => {
  resetUpload();
  showPanel(uploadPanel);
});

confirmButton.addEventListener('click', () => {
  const data = collectReviewData();
  const incomplete = data.players.some(player => !player.name || player.scores.some(score => score === ''));
  if (incomplete) {
    confirmMessage.textContent = 'Please complete every player name and all 18 scores before confirming.';
    return;
  }
  const label = data.players[0].name.trim() || 'Unnamed';

  if (editingCardId) {
    const index = savedCards.findIndex(card => card.id === editingCardId);
    if (index >= 0) {
      savedCards[index] = {
        ...savedCards[index],
        label,
        playerCount: data.players.length,
        players: data.players,
        ballScores: calculateBallScores(data.players),
        photoDataUrl: imageDataUrl || savedCards[index].photoDataUrl || '',
        correctedAt: new Date().toISOString()
      };
      const updated = savedCards[index];
      saveCards();
      editingCardId = null;
      currentData = null;
      confirmButton.textContent = 'Confirm card';
      resetUpload({ keepEditing: true });
      renderSavedCards();
      renderBallCard(updated);
      return;
    }
  }

  const card = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    label,
    playerCount: data.players.length,
    players: data.players,
    ballScores: calculateBallScores(data.players),
    photoDataUrl: imageDataUrl,
    confirmedAt: new Date().toISOString()
  };
  savedCards.push(card);
  saveCards();
  currentData = null;
  resetUpload();
  renderSavedCards();
  showPanel(roundPanel);
});

enlargeButton.addEventListener('click', () => {
  if (!imageDataUrl) return;
  dialogImage.src = imageDataUrl;
  photoDialog.showModal();
});
closeDialog.addEventListener('click', () => photoDialog.close());
closeHoleDialog.addEventListener('click', () => holeDialog.close());

function showPanel(panel) {
  [roundPanel, uploadPanel, reviewPanel, ballCardPanel, comparisonPanel].forEach(item => item.classList.add('hidden'));
  panel.classList.remove('hidden');
}

function normalizeData(data) {
  const expected = Number(playerCount.value);
  const players = Array.isArray(data.players) ? data.players.slice(0, expected) : [];
  while (players.length < expected) players.push({ name: '', scores: Array(18).fill(''), uncertainHoles: [] });
  return {
    players: players.map(p => ({
      name: typeof p.name === 'string' ? p.name : '',
      scores: Array.from({ length: 18 }, (_, i) => validScore(p.scores?.[i])),
      uncertainHoles: [...new Set([
        ...(Array.isArray(p.uncertainHoles) ? p.uncertainHoles : []),
        ...Array.from({ length: 18 }, (_, i) => Number(p.scores?.[i]) === 1 ? i + 1 : null).filter(Boolean)
      ])]
    }))
  };
}

function validScore(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 7 ? n : '';
}

function renderReview(data) {
  const firstName = data.players[0]?.name?.trim() || 'Unnamed';
  cardTitle.textContent = `Team ${firstName}`;
  confirmMessage.textContent = '';
  playersEl.innerHTML = '';
  data.players.forEach((player, playerIndex) => {
    const section = document.createElement('section');
    section.className = 'player';
    const name = document.createElement('input');
    name.type = 'text';
    name.value = player.name;
    name.className = 'player-name';
    name.dataset.player = playerIndex;
    name.setAttribute('aria-label', `Player ${playerIndex + 1} name`);
    name.addEventListener('input', () => {
      if (playerIndex === 0) cardTitle.textContent = `Team ${name.value.trim() || 'Unnamed'}`;
    });
    section.appendChild(name);
    section.appendChild(makeScoreRow(player, playerIndex, 0));
    section.appendChild(makeScoreRow(player, playerIndex, 9));
    const total = document.createElement('div');
    total.className = 'total';
    total.id = `total-${playerIndex}`;
    total.textContent = `Total: ${sumScores(player.scores)}`;
    section.appendChild(total);
    playersEl.appendChild(section);
  });
}

function makeScoreRow(player, playerIndex, start) {
  const row = document.createElement('div');
  row.className = 'score-row';
  for (let i = start; i < start + 9; i++) {
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.pattern = '[1-7]';
    input.maxLength = 1;
    input.autocomplete = 'off';
    input.value = player.scores[i];
    input.className = 'score-input';
    input.dataset.player = playerIndex;
    input.dataset.hole = i;
    input.setAttribute('aria-label', `Player ${playerIndex + 1}, hole ${i + 1}`);
    if (player.uncertainHoles.includes(i + 1)) input.classList.add('uncertain');

    const selectCurrentScore = () => requestAnimationFrame(() => input.select());
    input.addEventListener('focus', selectCurrentScore);
    input.addEventListener('click', selectCurrentScore);
    input.addEventListener('input', () => {
      const digits = input.value.replace(/[^0-9]/g, '');
      const candidate = digits ? digits.at(-1) : '';
      input.value = /^[1-7]$/.test(candidate) ? candidate : '';
      if (input.value !== '1') input.classList.remove('uncertain');
      updateTotals(playerIndex);
    });
    input.addEventListener('change', () => {
      if (input.value === '1') {
        const confirmed = window.confirm('Confirm hole-in-one score of 1?');
        if (confirmed) input.classList.remove('uncertain');
        else {
          input.value = '';
          input.classList.add('uncertain');
          input.focus();
        }
        updateTotals(playerIndex);
      }
    });
    row.appendChild(input);
  }
  const nineTotal = document.createElement('div');
  nineTotal.className = 'nine-total';
  nineTotal.id = `nine-${playerIndex}-${start}`;
  nineTotal.textContent = sumScores(player.scores.slice(start, start + 9));
  row.appendChild(nineTotal);
  return row;
}

function collectReviewData() {
  const players = [...document.querySelectorAll('.player')].map(section => {
    const name = section.querySelector('.player-name').value.trim();
    const scores = [...section.querySelectorAll('.score-input')].map(input => validScore(input.value));
    return { name, scores, uncertainHoles: [] };
  });
  return { players };
}

function calculateBallScores(players) {
  const oneBall = [];
  const secondGame = [];
  for (let hole = 0; hole < 18; hole++) {
    const sorted = players.map(player => Number(player.scores[hole])).sort((a, b) => a - b);
    oneBall.push(sorted[0]);
    secondGame.push(players.length === 5 ? sorted[1] + sorted[2] : sorted[1]);
  }
  return { oneBall, secondGame };
}

function renderSavedCards() {
  savedCardsEl.innerHTML = '';
  if (!savedCards.length) {
    savedCardsEl.innerHTML = '<p class="empty-state">No confirmed cards yet.</p>';
    renderMatchups();
    return;
  }
  savedCards.forEach(card => {
    const item = document.createElement('article');
    item.className = 'saved-card';
    const format = card.playerCount === 5 ? '1 Ball / 2+3 Ball' : '1 Ball / 2 Ball';
    item.innerHTML = `
      <div>
        <h3>Team ${escapeHtml(teamName(card.label))}</h3>
        <p>${card.playerCount} players · ${format}</p>
      </div>
      <div class="saved-card-actions">
        <button class="secondary view-card" type="button">View calculated card</button>
        <button class="danger remove-card" type="button" aria-label="Remove Team ${escapeHtml(teamName(card.label))}">Remove</button>
      </div>`;
    item.querySelector('.view-card').addEventListener('click', () => renderBallCard(card));
    item.querySelector('.remove-card').addEventListener('click', () => {
      if (window.confirm(`Remove Team ${teamName(card.label)} from this round?`)) {
        savedCards = savedCards.filter(saved => saved.id !== card.id);
        saveCards();
        renderSavedCards();
      }
    });
    savedCardsEl.appendChild(item);
  });
  renderMatchups();
}


function renderMatchups() {
  matchupsEl.innerHTML = '';
  if (savedCards.length < 2) {
    matchupsSection.classList.add('hidden');
    return;
  }

  matchupsSection.classList.remove('hidden');
  for (let i = 0; i < savedCards.length; i++) {
    for (let j = i + 1; j < savedCards.length; j++) {
      const cardA = savedCards[i];
      const cardB = savedCards[j];
      const item = document.createElement('article');
      item.className = 'matchup-card';
      item.innerHTML = `
        <div>
          <h3>Team ${escapeHtml(teamName(cardA.label))} vs Team ${escapeHtml(teamName(cardB.label))}</h3>
          <p>${cardA.playerCount === 5 ? '1 Ball / 2+3 Ball' : '1 Ball / 2 Ball'}</p>
        </div>
        <button class="secondary view-comparison" type="button">View match</button>`;
      item.querySelector('.view-comparison').addEventListener('click', () => renderComparison(cardA, cardB));
      matchupsEl.appendChild(item);
    }
  }
}

function renderComparison(cardA, cardB) {
  if (cardA.playerCount !== cardB.playerCount) {
    window.alert('These cards have different player counts and cannot be compared in the same game format.');
    return;
  }

  const nameA = teamName(cardA.label);
  const nameB = teamName(cardB.label);
  const secondLabel = cardA.playerCount === 5 ? '2+3 Ball' : '2 Ball';
  const oneBall = makeComparisonSection('1 Ball', cardA, cardB, cardA.ballScores.oneBall, cardB.ballScores.oneBall);
  const secondBall = makeComparisonSection(secondLabel, cardA, cardB, cardA.ballScores.secondGame, cardB.ballScores.secondGame);
  const allResults = [...oneBall.results, ...secondBall.results];
  const betsA = allResults.reduce((sum, result) => sum + (result.winner === 'A' ? result.bets : 0), 0);
  const betsB = allResults.reduce((sum, result) => sum + (result.winner === 'B' ? result.bets : 0), 0);
  const net = betsA - betsB;

  comparisonTitle.textContent = `Team ${nameA} vs Team ${nameB}`;
  comparisonContent.innerHTML = `
    ${oneBall.html}
    ${secondBall.html}
    ${makeAllDaySummary(nameA, nameB, net)}
  `;
  showPanel(comparisonPanel);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function makeComparisonSection(label, cardA, cardB, scoresA, scoresB) {
  const front = makeNineComparison('Front 9', 0, cardA, cardB, scoresA, scoresB);
  const back = makeNineComparison('Back 9', 9, cardA, cardB, scoresA, scoresB);
  return {
    html: `<section class="comparison-section">
      <h3>${label}</h3>
      ${front.html}
      ${back.html}
    </section>`,
    results: [front.result, back.result]
  };
}

function makeNineComparison(nineLabel, start, cardA, cardB, scoresA, scoresB) {
  const nameA = teamName(cardA.label);
  const nameB = teamName(cardB.label);
  const rows = [];
  const holeResults = [];

  for (let i = start; i < start + 9; i++) {
    const a = Number(scoresA[i]);
    const b = Number(scoresB[i]);
    holeResults.push(a < b ? 1 : b < a ? -1 : 0);
  }

  const result = calculateNineMatch(holeResults, nameA, nameB);

  for (let offset = 0; offset < 9; offset++) {
    const i = start + offset;
    const a = Number(scoresA[i]);
    const b = Number(scoresB[i]);
    const delta = holeResults[offset];
    const aClass = delta > 0 ? 'score-win' : delta === 0 ? 'score-tie' : '';
    const bClass = delta < 0 ? 'score-win' : delta === 0 ? 'score-tie' : '';
    const state = result.states[offset];

    rows.push(`<tr>
      <td class="hole-number">${i + 1}</td>
      <td><span class="match-score ${aClass}">${a}</span></td>
      <td><span class="match-score ${bClass}">${b}</span></td>
      <td class="running-cell"><strong>${escapeHtml(state.display)}</strong>${state.pressJustStarted ? '<span class="press-badge">Press</span>' : ''}</td>
    </tr>`);
  }

  return {
    html: `<div class="nine-comparison">
      <h4>${nineLabel}</h4>
      <div class="comparison-table-wrap">
        <table class="comparison-table">
          <thead><tr><th>Hole</th><th>Team ${escapeHtml(nameA)}</th><th>Team ${escapeHtml(nameB)}</th><th>Running</th></tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>
      <div class="nine-result ${result.cssClass}">
        <span class="result-kicker">${nineLabel} result</span>
        <strong>${escapeHtml(result.summary)} <span class="final-state">${escapeHtml(result.finalDisplay)}</span></strong>
      </div>
    </div>`,
    result
  };
}

function calculateNineMatch(holeResults, labelA, labelB) {
  let prePressLead = 0;
  let pressStarted = false;
  let pressAfterHole = null;
  let pressStateIndex = 4; // 4 = 1-1, 5 = 2-0, 3 = 0-2
  let pressLeader = 0;
  let freshPress = false;
  const states = [];

  holeResults.forEach((delta, index) => {
    let pressJustStarted = false;

    if (!pressStarted) {
      prePressLead += delta;

      if (Math.abs(prePressLead) >= 2) {
        pressStarted = true;
        pressAfterHole = index + 1;
        pressLeader = Math.sign(prePressLead);
        pressStateIndex = pressLeader > 0 ? 5 : 3;
        freshPress = true;
        pressJustStarted = true;
      }
    } else if (delta !== 0) {
      // First loss after the press starts leaves the call at 2-0 (or 0-2).
      // After that, each won hole advances through the Colonial call sequence.
      if (freshPress && delta === -pressLeader) {
        freshPress = false;
      } else {
        pressStateIndex += delta;
        freshPress = false;
      }
    }

    states.push({
      display: pressStarted ? formatPressState(pressStateIndex) : formatSimpleLead(prePressLead),
      pressJustStarted
    });
  });

  const finalDisplay = states.at(-1)?.display || '0-0';
  const outcome = resultFromDisplay(finalDisplay, labelA, labelB);

  return {
    ...outcome,
    finalDisplay,
    pressStarted,
    pressAfterHole,
    states
  };
}

function formatSimpleLead(lead) {
  if (lead > 0) return `${lead}-0`;
  if (lead < 0) return `0-${Math.abs(lead)}`;
  return '0-0';
}

function formatPressState(index) {
  const distance = index - 4;
  if (distance === 0) return '1-1';
  if (distance > 0) return `${distance + 1}-${distance - 1}`;
  const magnitude = Math.abs(distance);
  return `${magnitude - 1}-${magnitude + 1}`;
}

function resultFromDisplay(display, labelA, labelB) {
  const [a, b] = display.split('-').map(Number);

  if (a === b) {
    return { summary: 'Jacked', cssClass: 'jacked', winner: null, bets: 0 };
  }

  if (a > b) {
    const bets = a >= 3 ? 2 : 1;
    return { summary: `Team ${labelA} (${bets} ${bets === 1 ? 'Bet' : 'Bets'})`, cssClass: 'winner-a', winner: 'A', bets };
  }

  const bets = b >= 3 ? 2 : 1;
  return { summary: `Team ${labelB} (${bets} ${bets === 1 ? 'Bet' : 'Bets'})`, cssClass: 'winner-b', winner: 'B', bets };
}

function makeAllDaySummary(nameA, nameB, net) {
  if (net === 0) {
    return `<section class="all-day-summary jacked">
      <span class="result-kicker">All day</span>
      <strong>Jacked All Day!</strong>
    </section>`;
  }

  const winner = net > 0 ? nameA : nameB;
  const bets = Math.abs(net);
  return `<section class="all-day-summary">
    <span class="result-kicker">All day</span>
    <strong>Team ${escapeHtml(winner)} wins ${bets} ${bets === 1 ? 'Bet' : 'Bets'}</strong>
  </section>`;
}

function renderBallCard(card) {
  activeBallCardId = card.id;
  const secondLabel = card.playerCount === 5 ? '2+3 Ball' : '2 Ball';
  ballCardTitle.textContent = `Team ${teamName(card.label)}`;
  ballCardContent.innerHTML = `
    <p class="help compact-help">Tap any calculated hole to see the player scores used. Use “Review original scores” to make a correction; the calculated card updates automatically.</p>
    ${makeBallSection('1 Ball', card.ballScores.oneBall, 'oneBall')}
    ${makeBallSection(secondLabel, card.ballScores.secondGame, 'secondGame')}
    <div class="player-summary">
      ${card.players.map(player => {
        const front = sumScores(player.scores.slice(0, 9));
        const back = sumScores(player.scores.slice(9, 18));
        return `<div><strong>${escapeHtml(player.name)}</strong><span>${front} · ${back} · ${front + back}</span></div>`;
      }).join('')}
    </div>`;
  ballCardContent.querySelectorAll('.ball-score-button').forEach(button => {
    button.addEventListener('click', () => showHoleAudit(card, Number(button.dataset.hole), button.dataset.game));
  });
  showPanel(ballCardPanel);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function makeBallSection(label, scores, gameKey) {
  const front = scores.slice(0, 9).reduce((sum, score) => sum + score, 0);
  const back = scores.slice(9, 18).reduce((sum, score) => sum + score, 0);
  const makeButtons = (subset, start) => subset.map((score, offset) => `<button class="ball-score-button" type="button" data-hole="${start + offset}" data-game="${gameKey}" aria-label="Review hole ${start + offset + 1}">${score}</button>`).join('');
  return `<section class="ball-section">
    <h3>${label}</h3>
    <div class="ball-row">${makeButtons(scores.slice(0, 9), 0)}<strong>${front}</strong></div>
    <div class="ball-row">${makeButtons(scores.slice(9, 18), 9)}<strong>${back}</strong></div>
  </section>`;
}

function showHoleAudit(card, holeIndex, gameKey) {
  const sorted = card.players
    .map(player => ({ name: player.name, score: Number(player.scores[holeIndex]) }))
    .sort((a, b) => a.score - b.score);
  const isFive = card.playerCount === 5;
  const gameLabel = gameKey === 'oneBall' ? '1 Ball' : (isFive ? '2+3 Ball' : '2 Ball');
  const calculation = gameKey === 'oneBall'
    ? `${sorted[0].score}`
    : isFive
      ? `${sorted[1].score} + ${sorted[2].score} = ${sorted[1].score + sorted[2].score}`
      : `${sorted[1].score}`;

  holeDialogContent.innerHTML = `
    <p class="eyebrow">Team ${escapeHtml(teamName(card.label))}</p>
    <h2>Hole ${holeIndex + 1} · ${gameLabel}</h2>
    <div class="hole-audit-list">
      ${card.players.map(player => `<div><span>${escapeHtml(player.name)}</span><strong>${player.scores[holeIndex]}</strong></div>`).join('')}
    </div>
    <div class="audit-result"><span>Calculated ${gameLabel}</span><strong>${calculation}</strong></div>
    <button id="auditEditButton" class="primary audit-edit" type="button">Review original scores</button>`;
  holeDialog.showModal();
  holeDialogContent.querySelector('#auditEditButton').addEventListener('click', () => {
    holeDialog.close();
    openCardForReview(card, holeIndex);
  });
}

function openCardForReview(card, focusHole = null) {
  editingCardId = card.id;
  activeBallCardId = card.id;
  imageDataUrl = card.photoDataUrl || '';
  currentData = {
    players: card.players.map(player => ({
      name: player.name,
      scores: [...player.scores],
      uncertainHoles: []
    }))
  };
  playerCount.value = String(card.playerCount);
  renderReview(currentData);
  confirmButton.textContent = 'Save corrections';
  enlargeButton.disabled = !imageDataUrl;
  enlargeButton.textContent = imageDataUrl ? 'View photo' : 'Photo unavailable';
  showPanel(reviewPanel);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (focusHole !== null) {
    requestAnimationFrame(() => {
      const target = document.querySelector(`.score-input[data-hole="${focusHole}"]`);
      if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.focus(); }
    });
  }
}


function updateTotals(playerIndex) {
  const section = playersEl.children[playerIndex];
  const scores = [...section.querySelectorAll('.score-input')].map(input => validScore(input.value));
  document.querySelector(`#nine-${playerIndex}-0`).textContent = sumScores(scores.slice(0, 9));
  document.querySelector(`#nine-${playerIndex}-9`).textContent = sumScores(scores.slice(9, 18));
  document.querySelector(`#total-${playerIndex}`).textContent = `Total: ${sumScores(scores)}`;
}

function sumScores(scores) {
  if (scores.some(score => score === '')) return '—';
  return scores.reduce((sum, score) => sum + Number(score), 0);
}

function resetUpload(options = {}) {
  currentData = null;
  imageDataUrl = '';
  if (!options.keepEditing) editingCardId = null;
  cameraInput.value = '';
  libraryInput.value = '';
  preview.src = '';
  preview.classList.add('hidden');
  readButton.disabled = true;
  status.textContent = '';
  confirmMessage.textContent = '';
  playersEl.innerHTML = '';
  confirmButton.textContent = 'Confirm card';
  enlargeButton.disabled = false;
  enlargeButton.textContent = 'View photo';
}

function loadCards() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCards() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedCards));
  } catch (error) {
    // Scorecard photos can exceed browser storage. Preserve scores/results even if photos cannot persist.
    const withoutPhotos = savedCards.map(card => ({ ...card, photoDataUrl: '' }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(withoutPhotos));
  }
}

function teamName(label) {
  const first = String(label || '').trim().split(/\s+/)[0];
  return first || 'Unnamed';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function resizeImage(file, maxWidth, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Unable to read the image file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('The selected file is not a readable image.'));
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}


document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('input[type="file"]').forEach((input) => {
    if (input.dataset.v18CleanStateHook) return;
    input.dataset.v18CleanStateHook = '1';
    input.addEventListener('click', clearPreviousOcrState);
    input.addEventListener('change', clearPreviousOcrState);
  });
});

backFromRawButton?.addEventListener('click', () => showPanel(uploadPanel));
continueFromRawButton?.addEventListener('click', () => {
  if (!pendingRawPayload) return;
  currentData = normalizeData(pendingRawPayload);
  renderReview(currentData);
  showPanel(reviewPanel);
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('input[type="file"]').forEach((input) => {
    if (input.dataset.v20CleanPlayerPipeline) return;
    input.dataset.v20CleanPlayerPipeline = '1';
    input.addEventListener('click', clearAllPriorCardStateV20);
    input.addEventListener('change', clearAllPriorCardStateV20);
  });
});

document.addEventListener('DOMContentLoaded', () => {
  const addV21Banner = () => {
    const review = document.querySelector('#review, #reviewScreen, #review-screen');
    if (!review || review.querySelector('.v21-diagnostic-note')) return;
    const note = document.createElement('div');
    note.className = 'v21-diagnostic-note';
    note.textContent = 'v2.1 test: each hole is treated as an independent one-digit read. Unclear holes should stay blank instead of being guessed.';
    note.style.cssText = 'margin:12px 0;padding:10px 12px;border-radius:10px;background:#eef4f8;font-weight:600;font-size:14px;';
    review.prepend(note);
  };
  const observer = new MutationObserver(addV21Banner);
  observer.observe(document.body, {subtree:true, childList:true});
  addV21Banner();
});

document.addEventListener('DOMContentLoaded', () => {
  const addV22 = () => {
    const review = document.querySelector('#review, #reviewScreen, #review-screen');
    if (!review || review.querySelector('.v22-diagnostic-note')) return;
    const note = document.createElement('div');
    note.className = 'v22-diagnostic-note';
    note.textContent = 'v2.2 test: true per-hole image crops. Each hole should be read from its own isolated score box.';
    note.style.cssText = 'margin:12px 0;padding:10px 12px;border-radius:10px;background:#eef4f8;font-weight:600;font-size:14px;';
    review.prepend(note);
  };
  const observer = new MutationObserver(addV22);
  observer.observe(document.body, {subtree:true, childList:true});
  addV22();
});


function renderCellDiagnostics(payload) {
  cellDiagnosticGrid.innerHTML = '';
  const groups = payload?.debug?.cellDiagnostics || [];
  const first = groups[0];

  if (!first) {
    cellDiagnosticMeta.textContent = 'No player-row cell crops were returned.';
    return;
  }

  cellDiagnosticMeta.textContent =
    `${first.name || 'Player'} — ${first.cells?.length || 0} physical hole crops. ` +
    `Front box: ${JSON.stringify(first.frontBox)} · Back box: ${JSON.stringify(first.backBox)}`;

  for (const cell of first.cells || []) {
    const tile = document.createElement('div');
    tile.className = 'cell-diagnostic-tile';

    if (cell.imageDataUrl) {
      const img = document.createElement('img');
      img.src = cell.imageDataUrl;
      img.alt = `Hole ${cell.hole} OCR crop`;
      tile.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.style.cssText = 'aspect-ratio:1/1;display:grid;place-items:center;background:#f2f4f6;border-radius:8px;';
      placeholder.textContent = 'No crop';
      tile.appendChild(placeholder);
    }

    const hole = document.createElement('div');
    hole.className = 'cell-diagnostic-hole';
    hole.textContent = `Hole ${cell.hole}`;
    tile.appendChild(hole);

    const result = document.createElement('div');
    result.className = 'cell-diagnostic-result' + (cell.uncertain ? ' uncertain' : '');
    result.textContent = cell.digit == null ? '?' : String(cell.digit);
    tile.appendChild(result);

    cellDiagnosticGrid.appendChild(tile);
  }
}

backFromCellsButton?.addEventListener('click', () => showPanel(uploadPanel));

continueFromCellsButton?.addEventListener('click', () => {
  if (!pendingRawPayload) return;
  rawOcrOutput.textContent = JSON.stringify(pendingRawPayload, null, 2);
  showPanel(rawOcrPanel);
  window.scrollTo({ top: 0, behavior: 'smooth' });
});


function renderGeometryDiagnostics(payload) {
  geometryDiagnosticGrid.innerHTML = '';
  const cells = payload?.debug?.cells || [];
  const geometry = payload?.debug?.geometry || {};
  const playerName = payload?.playerName || 'First visible player';

  const cardBox = payload?.debug?.geometry?.cardBox || null;
  const nameBox = payload?.debug?.geometry?.nameBox || null;
  const nameCenterY = payload?.debug?.nameCenterY;
  const yOffset = payload?.debug?.yOffset;
  const rowCenterY = payload?.debug?.rowCenterY;
  const warpSize = payload?.debug?.warpSize || null;
  geometryDiagnosticMeta.textContent =
    `${playerName} — ${cells.length} crops. ` +
    `Card normalized to: ${JSON.stringify(warpSize)} · Name: ${JSON.stringify(nameBox)} · ` +
    `Name center Y: ${nameCenterY} · Y offset: ${yOffset} · Crop center Y: ${rowCenterY}`;

  if (!cells.length) {
    geometryDiagnosticGrid.innerHTML =
      '<div class="status">No cells were cropped. The row geometry was not confident enough.</div>';
    return;
  }

  for (const cell of cells) {
    const tile = document.createElement('div');
    tile.className = 'cell-diagnostic-tile';

    const img = document.createElement('img');
    img.src = cell.imageDataUrl;
    img.alt = `Hole ${cell.hole} geometry crop`;
    tile.appendChild(img);

    const hole = document.createElement('div');
    hole.className = 'cell-diagnostic-hole';
    hole.textContent = `Hole ${cell.hole}`;
    tile.appendChild(hole);

    geometryDiagnosticGrid.appendChild(tile);
  }
}

backFromGeometryButton?.addEventListener('click', () => showPanel(uploadPanel));
