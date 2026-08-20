// ---------------------------------------------------------------
// Fill in your own Spotify app's Client ID (see README.md).
// The redirect URI is computed automatically from wherever this
// page is hosted — just make sure that exact URL is added to your
// Spotify app's "Redirect URIs" list in the dashboard.
// ---------------------------------------------------------------
const CONFIG = {
  CLIENT_ID: "df99a6bcaadd452ab1bd43994516bddb",
  REDIRECT_URI: window.location.origin + window.location.pathname,
  SCOPES: [
    "user-top-read",
    "streaming",
    "user-read-email",
    "user-read-private",
    "user-read-playback-state",
    "user-modify-playback-state",
  ].join(" "),
};
