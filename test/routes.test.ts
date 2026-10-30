// The order a room's routes are looked at is a security rule (docs/rules/server.md):
// a change to it fails here, and has to say so.
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { MEMBER_ROUTES, OPEN_ROUTES } from '../server/core/routes.ts'
import { Room, roomRequest } from '../server/core/index.ts'

test('a room looks at its open routes, then its members, in this order', () => {
  assert.deepEqual(
    OPEN_ROUTES.map(route => route.name),
    ['page', 'info', 'join', 'admin-end', 'end by sign-in', 'leave by sign-in'],
  )
  assert.deepEqual(
    MEMBER_ROUTES.map(route => route.name),
    ['files', 'previews', 'need', 'peer', 'cloud', 'read events', 'post events', 'leave', 'end', 'invite', 'team'],
  )
})

const ask = (room: Room, rest: string, headers: Record<string, string> = {}, method = 'POST') =>
  roomRequest(room, new Request(`https://share.test/api/rooms/${room.id}/${rest}`, { method, headers }), rest, Date.now(), 'https://share.test')

test("a seat its person left from elsewhere is told so before anything else of a member's", async () => {
  const room = Room.create({ id: 'r'.repeat(16), name: 'Host', title: 't', now: Date.now(), fromNow: false, version: null, team: null, account: null })
  const { token: seat } = room.join('Guest', Date.now(), null, null)
  room.leftElsewhere.set(seat, Date.now())
  const left = await ask(room, 'events', { authorization: `Bearer ${seat}` }, 'GET')
  assert.equal(left.response.status, 410)
})

test('no token, no sign-in: a member route is refused, and an unknown path a member asks for is not found', async () => {
  const room = Room.create({ id: 's'.repeat(16), name: 'Host', title: 't', now: Date.now(), fromNow: false, version: null, team: null, account: null })
  assert.equal((await ask(room, 'end')).response.status, 401)
  assert.equal((await ask(room, 'nope', { authorization: `Bearer ${room.host.token}` })).response.status, 404)
})

test('the host ends the room with its token; a guest can not', async () => {
  const room = Room.create({ id: 't'.repeat(16), name: 'Host', title: 't', now: Date.now(), fromNow: false, version: null, team: null, account: null })
  const { token: seat } = room.join('Guest', Date.now(), null, null)
  assert.equal((await ask(room, 'end', { authorization: `Bearer ${seat}` })).response.status, 403)
  assert.equal(room.endedAt, null)
  assert.equal((await ask(room, 'end', { authorization: `Bearer ${room.host.token}` })).response.status, 200)
  assert.ok(room.endedAt)
})
