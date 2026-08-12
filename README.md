# Colonial Golf Match v1.7

OCR-focused test build.

## What changed

- Separate **Take Photo** and **Choose Existing Photo** controls on iPhone.
- Keeps the v1.6 conservative one-pass-per-player OCR approach.
- Explicitly teaches the reader that a circle around a handwritten score is a birdie mark and must not be interpreted as part of the digit.
- Uses the printed PAR row only as a visual sanity clue for circled birdies; it does not force likely scores.
- Unclear scores remain blank/highlighted instead of being auto-corrected.
- Existing score review, calculated 1 Ball / 2 Ball / 2+3 Ball, and match logic are unchanged.

## Test recommendation

Use the same saved scorecard photos from earlier versions first. That makes it possible to compare OCR accuracy directly from version to version.


## v1.8 diagnostic focus
This build clears prior-card browser state whenever a new photo is selected and explicitly instructs the OCR request to use only information visible in the current image.

Diagnostic test: use the cropped photo containing only Paul's handwritten row. Expected: Paul is read; names/scores not visible in the image remain blank rather than being populated from a prior card.


## v1.9 raw diagnostic
This build displays the exact JSON returned by the OCR function before the normal review screen. It also removes hard-coded example player names and example score sequences from the OCR prompts, because those examples can bias a vision model toward inventing prior-looking names/scores. The cropped-Paul test should now reveal exactly what the server sees and returns.


## v2.0 focus
This build separates the display pipeline from prior-card state. The app now renders only the player objects actually returned by OCR, rather than padding or reusing players from an earlier card.

Primary diagnostic test:
1. Use the cropped Paul-only image.
2. Expected normal review: Paul only.
3. No Steve, Dec, Craig, Mike, or other player should appear unless visible in the current image.

OCR accuracy itself is intentionally not re-architected in this build; v2.0 first removes the phantom-player/display contamination bug so future OCR tuning can be measured cleanly.


## v2.1 focus
This build keeps the clean-player pipeline from v2.0 and changes only the digit-reading instructions.

The OCR is now told to treat each of the 18 hole positions as an independent one-digit classification task:
- do not use neighboring scores;
- do not shift or smooth values;
- ignore birdie circles and read only the digit inside;
- return null/blank when a digit is unclear;
- never invent missing players or scores.

Recommended test:
1. Use the same cropped Paul-only photo from v2.0.
2. Compare all 18 returned values against the known actual scores.
3. Record the number of exact matches.


## v2.2 focus
This build is the first true per-hole image-crop test.

The intended OCR path is:
1. identify the visible player row;
2. physically crop that row;
3. split the row image into 18 score-box images;
4. send each box to the vision model as a one-digit classification task;
5. reconstruct Holes 1–18 from those 18 independent reads.

A blank/unclear box should return null and be highlighted. No neighboring scores, totals, par, or golf-pattern logic should be used to guess the digit.

Recommended baseline test: use the same cropped Paul-only image used in v2.0/v2.1.


## v2.3 diagnostic
This build makes the cell-crop experiment visible.

Before normal review, the app shows the exact 18 hole images that were physically cropped and sent to OCR, together with the returned digit for each hole.

The server now:
1. normalizes photo orientation;
2. finds the visible player names;
3. locates separate front-nine and back-nine score-grid boxes for each player;
4. physically splits each nine into nine individual images;
5. OCRs each image independently;
6. returns those exact crop images in the debug payload.

For the current controlled test, use the same Paul-only cropped photo.

## v2.4 focus
Standard test orientation: landscape scorecard with Hole 1 at left, Hole 18 at right, and player names at left.

v2.4 adds a second geometry-verification pass before any per-hole crop is made. It explicitly rejects printed HANDICAP/PAR/yardage rows and background, requires front/back boxes to be on the same handwritten player row, and keeps the 18-image diagnostic screen.

Acceptance test: using the saved Paul-only test photo, every diagnostic tile must visibly contain Paul's corresponding handwritten score before OCR accuracy is evaluated.

## v2.4.1
Hotfix for the v2.4 pre-diagnostic failure. The geometry verification pass now fails soft and preserves the initial geometry if its response cannot be parsed. HTTP failures are surfaced with their server-provided message instead of collapsing into a generic browser string-pattern error.

## v2.5 Geometry Only Diagnostic
No score OCR is performed after row location.

Flow:
1. One vision call locates the first handwritten player row.
2. The front and back nine are cropped locally.
3. Each nine is divided into nine local images.
4. The app shows the 18 images for visual verification.

Acceptance criterion: each tile must show the correct handwritten score box for the same player, in Hole 1-18 order.

## v2.5.1
Hotfix only. Removes stale JavaScript references to diagnostic panels deleted in v2.5, including `rawOcrPanel`, so Add scorecard can open the upload screen again. The v2.5 geometry-only server diagnostic is otherwise unchanged.
