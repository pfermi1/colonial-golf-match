const fileInput = document.querySelector('#scorecardFile');
const preview = document.querySelector('#preview');
const readButton = document.querySelector('#readButton');
const status = document.querySelector('#status');
const playerCount = document.querySelector('#playerCount');
const roundPanel = document.querySelector('#roundPanel');
const uploadPanel = document.querySelector('#uploadPanel');
const reviewPanel = document.querySelector('#reviewPanel');
const ballCardPanel = document.querySelector('#ballCardPanel');
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
const ballCardTitle = document.querySelector('#ballCardTitle');
const ballCardContent = document.querySelector('#ballCardContent');

const STORAGE_KEY = 'colonialGolfMatchCardsV04';
let imageDataUrl = '';
let currentData = null;
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

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  status.textContent = 'Preparing photo...';
  try {
    imageDataUrl = await resizeImage(file, 1800, 0.86);
    preview.src = imageDataUrl;
    preview.classList.remove('hidden');
    readButton.disabled = false;
    status.textContent = 'Photo ready.';
  } catch (error) {
    status.textContent = `Could not prepare photo: ${error.message}`;
  }
});

readButton.addEventListener('click', async () => {
  if (!imageDataUrl) return;
  readButton.disabled = true;
  status.textContent = 'Reading handwritten names and scores...';
  try {
    const response = await fetch('/.netlify/functions/read-scorecard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataUrl, expectedPlayers: Number(playerCount.value) })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Scorecard reader failed.');
    currentData = normalizeData(payload);
    renderReview(currentData);
    showPanel(reviewPanel);
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
  const card = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    label,
    playerCount: data.players.length,
    players: data.players,
    ballScores: calculateBallScores(data.players),
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
  dialogImage.src = imageDataUrl;
  photoDialog.showModal();
});
closeDialog.addEventListener('click', () => photoDialog.close());

function showPanel(panel) {
  [roundPanel, uploadPanel, reviewPanel, ballCardPanel].forEach(item => item.classList.add('hidden'));
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
    return;
  }
  savedCards.forEach(card => {
    const item = document.createElement('article');
    item.className = 'saved-card';
    const format = card.playerCount === 5 ? '1 Ball / 2+3 Ball' : '1 Ball / 2 Ball';
    item.innerHTML = `
      <div>
        <h3>Team ${escapeHtml(card.label)}</h3>
        <p>${card.playerCount} players · ${format}</p>
      </div>
      <div class="saved-card-actions">
        <button class="secondary view-card" type="button">View calculated card</button>
        <button class="danger remove-card" type="button" aria-label="Remove Team ${escapeHtml(card.label)}">Remove</button>
      </div>`;
    item.querySelector('.view-card').addEventListener('click', () => renderBallCard(card));
    item.querySelector('.remove-card').addEventListener('click', () => {
      if (window.confirm(`Remove Team ${card.label} from this round?`)) {
        savedCards = savedCards.filter(saved => saved.id !== card.id);
        saveCards();
        renderSavedCards();
      }
    });
    savedCardsEl.appendChild(item);
  });
}

function renderBallCard(card) {
  const secondLabel = card.playerCount === 5 ? '2+3 Ball' : '2 Ball';
  ballCardTitle.textContent = `Team ${card.label}`;
  ballCardContent.innerHTML = `
    ${makeBallSection('1 Ball', card.ballScores.oneBall)}
    ${makeBallSection(secondLabel, card.ballScores.secondGame)}
    <div class="player-summary">
      ${card.players.map(player => {
        const front = sumScores(player.scores.slice(0, 9));
        const back = sumScores(player.scores.slice(9, 18));
        return `<div><strong>${escapeHtml(player.name)}</strong><span>${front} · ${back} · ${front + back}</span></div>`;
      }).join('')}
    </div>`;
  showPanel(ballCardPanel);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function makeBallSection(label, scores) {
  const front = scores.slice(0, 9).reduce((sum, score) => sum + score, 0);
  const back = scores.slice(9, 18).reduce((sum, score) => sum + score, 0);
  return `<section class="ball-section">
    <h3>${label}</h3>
    <div class="ball-row">${scores.slice(0, 9).map(score => `<span>${score}</span>`).join('')}<strong>${front}</strong></div>
    <div class="ball-row">${scores.slice(9, 18).map(score => `<span>${score}</span>`).join('')}<strong>${back}</strong></div>
  </section>`;
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

function resetUpload() {
  currentData = null;
  imageDataUrl = '';
  fileInput.value = '';
  preview.src = '';
  preview.classList.add('hidden');
  readButton.disabled = true;
  status.textContent = '';
  confirmMessage.textContent = '';
  playersEl.innerHTML = '';
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(savedCards));
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
