# Colonial Golf Match v1.6

Version 1.6 is an OCR-focused release. No betting logic was changed.

## v1.6 Conservative OCR

- Uses one independent vision read per player row.
- Uses the higher-accuracy `gpt-4.1` model by default (override with `OPENAI_VISION_MODEL` in Netlify if desired).
- Does not run a second automatic correction pass.
- Explicitly forbids shifting scores left/right or smoothing repeated 3/4/5 patterns.
- Ambiguous cells should be returned as `null` and highlighted for one-tap correction instead of guessed.
- Keeps the existing score review, original photo, calculated 1 Ball / 2 Ball / 2+3 Ball audit, and match logic unchanged.

## Testing goal

Use the same real scorecard photos across releases and count the number of manual corrections needed. The target is fewer confident errors, even if the first read contains more highlighted blanks.
