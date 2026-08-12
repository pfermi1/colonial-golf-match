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
