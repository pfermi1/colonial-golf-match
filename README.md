# Colonial Golf Match v0.2

This first working milestone reads a photographed handwritten scorecard and places each player's 18 scores into an editable review screen.

## Card naming

There is no permanent team name. The first player listed on the scorecard becomes the card label for that round, displayed as `Team <first player>`.

## Current features

- Four-player or five-player scorecard
- Photo resizing before upload
- Netlify Function keeps the OpenAI API key private
- Reads names and 18 handwritten scores
- Flags uncertain holes in yellow
- Editable review screen
- Automatic first nine, second nine, and total

## Netlify setup

Add an environment variable named `OPENAI_API_KEY` and make sure its scope includes Functions. After changing an environment variable, trigger a new deployment.

Optional: set `OPENAI_VISION_MODEL`. If omitted, the function uses `gpt-4.1-mini`.

## Deploy

Upload the contents of this folder to the root of the GitHub repository. Do not upload the ZIP itself. Netlify will deploy automatically after the GitHub commit.
