// Where Share creates rooms, when neither the plugin's `server` option nor the
// SHARED_SESSION_SERVER environment variable says. Empty: bring your own
// (README, "Host a server"). A team that runs one can bake it in with
// `node scripts/set-server.mjs <url>` in its own fork.
//
// Joining never reads this: a share link carries its own server.
export const SERVER_URL = ''
