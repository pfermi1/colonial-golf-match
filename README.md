# Colonial Golf Match — v1.0

Version 1.0 changes the scorecard reader from row-sequence OCR to **fixed-cell OCR**.

## Why v1.0

Earlier versions could occasionally shift a handwritten sequence left or right—for example, reading `6 5 6` as `5 6 5`, then inventing the final score in the row. Version 1.0 is designed specifically to prevent that failure mode.

## Fixed-cell OCR workflow

1. The full scorecard image is used only to locate each player's front-nine and back-nine score grids and read the player names.
2. The server crops each player's front and back score row.
3. Each nine-hole row is split into **nine separate physical cell images**.
4. OpenAI reads those nine images independently, one score per image.
5. A score is never borrowed from a neighboring hole. If a cell cannot be read confidently, it is returned blank and highlighted for review instead of shifting the row.

## Score review

- Individual scores are currently 1–7 for the Colonial group.
- A score of 1 is always flagged for confirmation.
- Tap a score to select/replace it without backspacing.
- Yellow cells need review.
- Front, back, and total recalculate after edits.

## Calculated cards

After confirming a scorecard:

- 4-player cards calculate **1 Ball / 2 Ball**.
- 5-player cards calculate **1 Ball / 2+3 Ball**.
- The first player's first name is used as the visible team/card identifier.
- From the calculated card, tap any hole to audit the player scores used.
- Use **Review original scores** to correct a player score and automatically recalculate the ball card and matches.

## Deployment

The project is intended for GitHub-connected Netlify deployment. Netlify needs the secret environment variable:

`OPENAI_API_KEY`

The server-side scorecard reader is in `netlify/functions/read-scorecard.js`.
