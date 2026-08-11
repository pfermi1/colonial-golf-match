# Colonial Golf Match v1.4

Version 1.4 returns to full-image vision reading instead of cropping the scorecard into fixed cells. The model reads each player as a structured Hole 1 through Hole 18 table using the printed hole columns as anchors.

Key OCR rules:

- Never shift a score left or right.
- Return a blank/null value if an exact hole cell is unclear.
- Never invent a final-hole score to complete a row.
- Individual test-group scores are validated as 1-7; a 1 remains highlighted for confirmation.
- Only cells marked uncertain by the first pass receive a second verification pass.
- The existing manual correction, calculated 1 Ball / 2 Ball / 2+3 Ball audit, running match, and matchup screens remain available.

The first player listed on each confirmed card remains the Team name for that round.
