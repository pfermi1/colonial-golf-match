# Colonial Golf Match — v1.1

Version 1.1 is a robustness update for fixed-cell OCR. It addresses failures such as **“back nine for player 1 grid coordinates were invalid.”**

## What changed

1. The server first tries to isolate the physical scorecard from the surrounding photo.
2. The layout pass now finds only two shared horizontal score grids (front and back) plus one vertical row band per player. This is simpler and more stable than asking AI for a separate front/back rectangle for every player.
3. Coordinates are clamped safely to the image boundaries instead of failing because a returned value is slightly outside 0–1000.
4. Player row heights are lightly regularized when one detected row is abnormally tall or narrow.
5. If the fixed grid still cannot be locked, the app falls back to a review-first whole-card read instead of stopping with an error. Every fallback score is highlighted so the user knows to verify it.
6. Fixed-cell reads still split each nine into nine individual hole images, so neighboring scores cannot intentionally shift left or right.

## Review and calculations

- Individual Colonial scores are currently 1–7.
- A 1 is always flagged for confirmation.
- Tap a score to replace it without backspacing.
- Front, back, and total update after edits.
- 4-player cards calculate 1 Ball / 2 Ball.
- 5-player cards calculate 1 Ball / 2+3 Ball.
- Use **Review original scores** from a calculated card to correct a source score and automatically recalculate matches.

## Deployment

This project is intended for GitHub-connected Netlify deployment and requires the secret environment variable `OPENAI_API_KEY`.
