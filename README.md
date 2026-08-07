# Colonial Golf Match v0.6

Phase 2 adds the first **hole winner engine**.

## Included

- Read and review 4-player or 5-player scorecards
- Fast one-digit score correction (1-7)
- First player labels the card as Team [Name]
- Front, back, and total for every player
- 1 Ball and 2 Ball calculations for 4-player cards
- 1 Ball and 2+3 Ball calculations for 5-player cards
- Multiple confirmed cards in one round
- Automatic pairings between all confirmed cards
- Hole-by-hole winner check for every pair of cards
- Separate Front 9 and Back 9 comparisons
- "Jacked" shown when a hole ties

## Not included yet

- Match-play running state
- Automatic press logic
- Bets won or money settlement

Those will be added after the hole winners are tested and confirmed.


## v0.6 changes
- Tied holes are labeled Tie, not Jacked.
- Each front/back nine is scored as match play.
- One automatic press starts after a side first reaches 2 up.
- Final nine result displays Team Name (1), Team Name (2), or Jacked.


## Version 0.8
- Adds a running match state after every hole.
- Tied holes leave the running state unchanged.
- Adds the Colonial automatic-press call sequence (2-0, 3-1, 2-0, 1-1, 0-2).
- Keeps one press maximum per ball per nine.


## v0.8 changes
- Uses the first name on each confirmed scorecard as the visible team name.
- Phone-first comparison table with the winning hole score highlighted.
- Each front/back result shows Team, Bets, and the final Colonial call (for example 5-3).
- Removes the extra automatic-press sentence below each nine.
- Adds an All Day net-bet line, or “Jacked All Day!” when the matchup is even.
