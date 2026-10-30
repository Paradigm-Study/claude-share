// Room logic for the Cloudflare Durable Object (server/worker/), and all
// that server/worker/, teams.ts, traces and the tests import of it.
// Everything speaks the Fetch API: a Request in, a Response out, and the
// sockets, timers and storage stay in server/worker/.
//
// A room is one shared Claude Code session. The host's session posts what its
// transcript keeps (rows), live text (deltas) and turn state; guests post
// prompts and stop requests. Everyone holds one `stream?after=<seq>` open and
// is sent a line whenever the room changes, so a quiet room costs nothing;
// `events?after=<seq>` answers the same question once, for pollers.

export {
  HISTORY_LIMIT,
  HISTORY_BYTES,
  SEAT_TIMEOUT_MS,
  KEEPALIVE_MS,
  STREAM_MAX_MS,
  SEAT_STREAMS,
  SEAT_POLLS,
  EVENT_BYTES,
  FILE_UPLOADS,
  ROOM_FILES_COUNT,
  ROOM_SEATS_MAX,
  ROOM_PREVIEWS_MAX,
  PROXY_BODY_MAX,
  TCP_LIMITS,
  PUBLIC_LIMITS,
  JSON_BODY_MAX,
  LIMITS,
  ROOMS_PER_ADDRESS_DAY,
  ROOMS_PER_DAY,
  Windows,
  CLOUD_MAX_MS,
  CLOUD_BUNDLE_MAX,
  NEED_LIMIT,
  PEER_LIMIT,
  SERVE_LIMITS,
} from './limits.ts'
export {
  token,
  bearerOf,
  json,
  readBody,
  streamedRoomBody,
  bodyLimit,
  bodyTooLarge,
  leftResponse,
  publicOrigin,
  shareUrl,
  PLUGIN_LATEST,
  PLUGIN_MIN,
  UPDATE_COMMAND,
  compareVersions,
  outdatedClient,
  noteVersion,
  clientVersion,
  versionInfo,
  limitedResponse,
  busyResponse,
  closedResponse,
  limitOf,
  notFound,
  badRequest,
  statusOf,
} from './http.ts'
export { ROOM_ID, Room } from './room.ts'
export { createRoom, roomRequest, ended, PEER_HANDLE, PEER_STATUS, PEER_DROPS } from './routes.ts'
export { PLUGIN_SOURCE, cloudSummary, isApprover } from './cloud.ts'
export {
  previewLabel,
  previewKeyOf,
  roomOrigins,
  previewHostLabel,
  previewMissing,
  previewTooLarge,
  previewRoomOf,
  previewRequest,
  SOCKET_ID,
  previewSocketTarget,
  publicPairValid,
  announceSocket,
  hostSocketAllowed,
  relayRejectCode,
  rejectReason,
} from './previews.ts'
export {
  revokeMatches,
  hostHalfClose,
  tcpHalfClose,
  tcpAdmit,
  tcpSocketTarget,
  announceTCP,
  tcpState,
  tcpValid,
  tcpReserve,
  tcpRefund,
  tcpCounted,
  mergeTCPStats,
  serveReserve,
  serveLeft,
  tcpFailure,
  tcpFrame,
  tcpCheck,
  chargeControl,
  tcpStep,
  tcpRelay,
  sendableClose,
} from './tcp.ts'
export { homePage, brandPage, INSTALL_COMMAND, COPY_ICON, commandBox, COPY_SCRIPT, missingPage, landingPage, escapeHtml } from './pages.ts'
export type { LimitKind } from './limits.ts'
export type { Person } from './room.ts'
export type { SocketTarget } from './previews.ts'
export type { TCPFailure, TCPFrame, TCPHalf, TCPRelayed, TCPTarget } from './tcp.ts'
export type * from './types.ts'
