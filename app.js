const fileInput = document.querySelector('#scorecardFile');
const preview = document.querySelector('#preview');
const readButton = document.querySelector('#readButton');
const status = document.querySelector('#status');
const playerCount = document.querySelector('#playerCount');
const uploadPanel = document.querySelector('#uploadPanel');
const reviewPanel = document.querySelector('#reviewPanel');
const playersEl = document.querySelector('#players');
const cardTitle = document.querySelector('#cardTitle');
const startOverButton = document.querySelector('#startOverButton');
const confirmButton = document.querySelector('#confirmButton');
const confirmMessage = document.querySelector('#confirmMessage');
const photoDialog = document.querySelector('#photoDialog');
const dialogImage = document.querySelector('#dialogImage');
const enlargeButton = document.querySelector('#enlargeButton');
const closeDialog = document.querySelector('#closeDialog');

let imageDataUrl = '';
let currentData = null;

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
    uploadPanel.classList.add('hidden');
    reviewPanel.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    status.textContent = error.message;
    readButton.disabled = false;
  }
});

startOverButton.addEventListener('click', resetApp);
confirmButton.addEventListener('click', () => {
  currentData = collectReviewData();
  const firstName = currentData.players[0]?.name?.trim() || 'Unnamed';
  confirmMessage.textContent = `Confirmed: Team ${firstName}. Scores are ready for game selection.`;
});

enlargeButton.addEventListener('click', () => {
  dialogImage.src = imageDataUrl;
  photoDialog.showModal();
});
closeDialog.addEventListener('click', () => photoDialog.close());

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

    const selectCurrentScore = () => {
      requestAnimationFrame(() => input.select());
    };
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
        if (confirmed) {
          input.classList.remove('uncertain');
        } else {
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
  const players = [...document.querySelectorAll('.player')].map((section, pIndex) => {
    const name = section.querySelector('.player-name').value.trim();
    const scores = [...section.querySelectorAll('.score-input')].map(input => validScore(input.value));
    return { name, scores, uncertainHoles: [] };
  });
  return { players };
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

function resetApp() {
  currentData = null;
  imageDataUrl = '';
  fileInput.value = '';
  preview.src = '';
  preview.classList.add('hidden');
  readButton.disabled = true;
  status.textContent = '';
  confirmMessage.textContent = '';
  playersEl.innerHTML = '';
  reviewPanel.classList.add('hidden');
  uploadPanel.classList.remove('hidden');
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
