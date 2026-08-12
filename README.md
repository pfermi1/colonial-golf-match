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
