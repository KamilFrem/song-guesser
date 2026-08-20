# Spin — guess the song from your own Spotify top tracks

A Wordle-style game built around **your** Spotify listening history. Pick a difficulty
(recent obsessions → all-time deep cuts), and guess the song from an increasingly
long snippet of real playback — you get more tries and shorter starting clips at
harder difficulties.

Everything runs **entirely in the browser** — there's no backend/server, so it can be
hosted anywhere that serves static files (GitHub Pages, Netlify, Vercel, or even your
own machine).

## Requirements

- A **Spotify Premium** account (the Web Playback SDK, which plays real audio in the
  page, only works for Premium accounts — Spotify's API no longer offers free 30-second
  previews to new apps).
- A **Spotify Developer app** that you control (free, takes ~2 minutes).
- HTTPS hosting for real use (Spotify's login and playback both require it — `localhost`
  is allowed for local testing without HTTPS).

## 1. Create your Spotify app

1. Go to <https://developer.spotify.com/dashboard> and log in.
2. Click **Create app**.
3. Fill in a name/description (anything you like).
4. Under **Redirect URIs**, add the *exact* URL where you'll host this page, e.g.:
   - `http://localhost:5500/index.html` (local testing)
   - `https://yourname.github.io/song-guesser/` (GitHub Pages)
5. Check the **Web Playback SDK** and **Web API** boxes under "Which API/SDKs are you
   planning to use?"
6. Save, then open the app and copy the **Client ID** shown on its settings page.

You do **not** need the Client Secret — this app uses the PKCE flow, which is safe to
run entirely client-side.

## 2. Configure the game

Open `config.js` and paste your Client ID:

```js
const CONFIG = {
  CLIENT_ID: "paste-your-client-id-here",
  ...
};
```

The redirect URI is computed automatically from the page's own URL, so it will match
whatever you registered in step 1 — just make sure you host the page at that exact
address (same path, same trailing slash or lack of one).

## 3. Run it

**Locally:** serve the folder with any static server, e.g.:

```bash
npx serve .
# or
python3 -m http.server 5500
```

Then visit the URL you registered as your redirect URI.

**Deployed:** push the folder to GitHub Pages, Netlify, or Vercel, and make sure the
live URL matches your registered redirect URI exactly.

## How it works

- **Login** uses Spotify's Authorization Code + PKCE flow (no server, no secret).
- **Song pool** comes from `GET /v1/me/top/tracks`, scoped by difficulty:
  - Easy → your top tracks from the last ~4 weeks (`short_term`)
  - Medium → last ~6 months (`medium_term`)
  - Hard → your all-time top 50 (`long_term`)
- **Playback** uses the Spotify Web Playback SDK to create a real playback device in
  the browser tab, then starts the track at `position_ms: 0` and pauses it after the
  snippet duration for that difficulty/guess number.
- **Guessing** autocompletes against the same pool that the answer was drawn from, so
  answers are always guessable.
- **Daily mode** seeds a deterministic pick (same song for everyone with the same
  listening pool + difficulty, on a given date) so you can build a daily streak;
  **Random mode** just picks anew each time.
- Streaks and play counts are stored in `localStorage` — nothing leaves your browser
  except calls to Spotify's own API.

## Notes & limitations

- Playback requires **Spotify Premium**; free accounts can log in but will get an
  "account error" from the Web Playback SDK when trying to play a snippet.
- If your account doesn't have enough listening history yet for a given difficulty
  (Spotify returns fewer tracks than the pool size), try Easy first — it needs the
  least history.
- Access tokens expire after an hour; the game silently refreshes them using the
  stored refresh token.
