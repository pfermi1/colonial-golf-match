# Colonial Golf Match v1.3

Version 1.3 removes the fragile model-generated grid-coordinate step. After the physical card is isolated, the app uses fixed Colonial scorecard geometry for the five player rows and the 18 hole cells.

## OCR behavior

- Normalizes the uploaded photo to landscape.
- Finds the large light physical scorecard without asking AI for coordinate strings.
- Uses a small AI check only for 180-degree orientation; failure here never blocks the scan.
- Uses fixed Colonial front-nine, back-nine, player-row and name-cell coordinates.
- Reads each nine as nine separate cell images.
- If a side cannot be read, those nine cells are left blank/highlighted instead of aborting the card or shifting values.
- Individual player scores remain limited to 1-7 for the current Colonial configuration; a 1 is highlighted for confirmation.
- Existing score review, calculated 1 Ball / 2 Ball / 2+3 Ball audit, match logic and correction flow remain in place.

The first handwritten player name remains the team/card name.
