# Colonial Golf Match — v1.2

Version 1.2 changes the OCR pipeline from free-form grid discovery to **template-guided alignment** using the Colonial scorecard image supplied during testing.

## What changed

1. A Colonial scorecard reference image is bundled with the Netlify Function.
2. The reader first determines the uploaded card's orientation relative to the known Colonial layout.
3. A template-guided layout pass locates the physical card, the front-nine score columns, the back-nine score columns, and each handwritten player row.
4. Each player's front and back nine are still split into nine separate cell images, so each hole is read independently.
5. If template alignment is not confident enough, the app falls back to a review-first whole-card read instead of throwing a coordinate-pattern error.
6. Errors are returned as golfer-friendly messages rather than raw coordinate/parser failures.

## Photo guidance

For best results, photograph the whole scorecard in landscape, directly overhead, with all four edges visible and minimal glare. The app can correct 90/180/270-degree orientation automatically.

## Review and calculations

- Individual Colonial scores are currently 1–7.
- A 1 is always flagged for confirmation.
- Tap a score to replace it without backspacing.
- Front, back, and total update after edits.
- 4-player cards calculate 1 Ball / 2 Ball.
- 5-player cards calculate 1 Ball / 2+3 Ball.
- Use **Review original scores** from a calculated card to correct a source score and automatically recalculate matches.

## Deployment

Deploy from GitHub to Netlify. Keep `OPENAI_API_KEY` configured as a secret environment variable. The bundled template lives at `netlify/functions/assets/colonial-template-card.jpg` and must be uploaded with the rest of the project.
