// Where Share creates rooms, when neither the plugin's `server` option nor the
// SHARED_SESSION_SERVER environment variable says: the public server this
// project runs (README, "Privacy and the public server"), so sharing works
// right after install. A team that runs its own sets the option, or bakes it
// in with `node scripts/set-server.mjs <url>` in its own fork.
//
// Joining never reads this: a share link carries its own server.
export const SERVER_URL = 'https://claude-share.proud-limit-da0a.workers.dev'
