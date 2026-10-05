import { expect, test, vi } from 'vitest';
import { bindJamHandlers } from './socketGateway.js';
import { JamError } from '../services/errors.js';

function fakeSocket() {
  const handlers = {};
  const calls = [];
  const socket = {
    data: {},
    on: (event, fn) => { handlers[event] = fn; },
    emit: vi.fn(),
    join: vi.fn(async (room) => { calls.push(`join:${room}`); }),
    leave: vi.fn(async (room) => { calls.push(`leave:${room}`); }),
  };
  return { socket, handlers, calls };
}

const snapshot = { version: 3, queue: [], playback: { status: 'IDLE', currentTrackId: null, startedAt: null, pausedAt: null } };

function fakeService(calls = []) {
  return {
    joinJam: vi.fn(async ({ userId, name }) => {
      calls.push('joinJam');
      return { isHost: true, hostToken: 't', userId, name: name.trim(), host: { userId, name: name.trim() } };
    }),
    getSnapshot: vi.fn(async () => { calls.push('getSnapshot'); return snapshot; }),
    handleCommand: vi.fn(async () => ({ version: 7 })),
  };
}

test('jam:join validates, joins the room, then reads the snapshot, then acks', async () => {
  const { socket, handlers, calls } = fakeSocket();
  const service = fakeService(calls);
  bindJamHandlers(socket, service);
  const ack = vi.fn();

  await handlers['jam:join']({ jamId: 'AB12CD', userId: 'u1', name: ' Tuan ', hostToken: 't' }, ack);

  expect(calls).toStrictEqual(['joinJam', 'join:AB12CD,AB12CD:user:u1', 'getSnapshot']);
  expect(service.joinJam).toHaveBeenCalledWith({ jamId: 'AB12CD', userId: 'u1', name: ' Tuan ', hostToken: 't' });
  expect(ack).toHaveBeenCalledWith({
    ok: true, isHost: true, hostToken: 't', host: { userId: 'u1', name: 'Tuan' }, you: { userId: 'u1', name: 'Tuan' }, snapshot,
  });
  expect(socket.data).toStrictEqual({ jamId: 'AB12CD', userId: 'u1', name: 'Tuan', hostToken: 't' });
});

test('jam:join failure acks the JamError code and does not join the room', async () => {
  const { socket, handlers } = fakeSocket();
  const service = fakeService();
  service.joinJam.mockRejectedValue(new JamError('JAM_NOT_FOUND', 'No such jam'));
  bindJamHandlers(socket, service);
  const ack = vi.fn();

  await handlers['jam:join']({ jamId: 'ZZZZZZ', userId: 'u', name: 'n' }, ack);

  expect(ack).toHaveBeenCalledWith({ ok: false, error: { code: 'JAM_NOT_FOUND', message: 'No such jam' } });
  expect(socket.join).not.toHaveBeenCalled();
  expect(socket.data).toStrictEqual({});
});

test('re-joining a different jam on the same socket leaves the old room', async () => {
  const { socket, handlers, calls } = fakeSocket();
  bindJamHandlers(socket, fakeService());
  await handlers['jam:join']({ jamId: 'AAAAAA', userId: 'u', name: 'n' }, vi.fn());
  await handlers['jam:join']({ jamId: 'BBBBBB', userId: 'u', name: 'n' }, vi.fn());

  expect(calls).toStrictEqual(['join:AAAAAA,AAAAAA:user:u', 'leave:AAAAAA', 'leave:AAAAAA:user:u', 'join:BBBBBB,BBBBBB:user:u']);
  expect(socket.data.jamId).toBe('BBBBBB');
});

test('room:command before joining → NOT_JOINED, service not called', async () => {
  const { socket, handlers } = fakeSocket();
  const service = fakeService();
  bindJamHandlers(socket, service);
  const ack = vi.fn();

  await handlers['room:command']({ type: 'PLAY', payload: {} }, ack);

  expect(ack).toHaveBeenCalledWith({ ok: false, error: { code: 'NOT_JOINED', message: 'Join a jam first' } });
  expect(service.handleCommand).not.toHaveBeenCalled();
});

test('room:command passes the server-side ctx (not client fields) and acks the version', async () => {
  const { socket, handlers } = fakeSocket();
  const service = fakeService();
  bindJamHandlers(socket, service);
  await handlers['jam:join']({ jamId: 'AB12CD', userId: 'u1', name: 'Tuan' }, vi.fn());
  const ack = vi.fn();
  const raw = { type: 'ADD_TRACK', payload: { trackId: 'x' }, jamId: 'OTHER1', isHost: true };

  await handlers['room:command'](raw, ack);

  expect(service.handleCommand).toHaveBeenCalledWith({ jamId: 'AB12CD', userId: 'u1', name: 'Tuan', hostToken: 't' }, raw);
  expect(ack).toHaveBeenCalledWith({ ok: true, version: 7 });
});

test('room:command maps JamError to its code and unknown errors to INTERNAL', async () => {
  const { socket, handlers } = fakeSocket();
  const service = fakeService();
  bindJamHandlers(socket, service);
  await handlers['jam:join']({ jamId: 'AB12CD', userId: 'u1', name: 'Tuan' }, vi.fn());

  service.handleCommand.mockRejectedValueOnce(new JamError('STALE_SKIP', 'stale'));
  const ack1 = vi.fn();
  await handlers['room:command']({ type: 'SKIP', payload: { expectedTrackId: 'a' } }, ack1);
  expect(ack1).toHaveBeenCalledWith({ ok: false, error: { code: 'STALE_SKIP', message: 'stale' } });

  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  service.handleCommand.mockRejectedValueOnce(new Error('redis exploded: secret detail'));
  const ack2 = vi.fn();
  await handlers['room:command']({ type: 'PLAY', payload: {} }, ack2);
  expect(ack2).toHaveBeenCalledWith({ ok: false, error: { code: 'INTERNAL', message: 'Something went wrong' } });
  expect(errSpy).toHaveBeenCalled();
  errSpy.mockRestore();
});

test('handlers without an ack function are ignored without throwing', async () => {
  const { socket, handlers } = fakeSocket();
  const service = fakeService();
  bindJamHandlers(socket, service);

  await expect(handlers['jam:join']({ jamId: 'AB12CD', userId: 'u', name: 'n' })).resolves.toBeUndefined();
  await expect(handlers['room:command']({ type: 'PLAY' }, 'not-a-function')).resolves.toBeUndefined();
  expect(service.joinJam).not.toHaveBeenCalled();
  expect(service.handleCommand).not.toHaveBeenCalled();
});

test('a null join payload acks an error envelope instead of throwing', async () => {
  const { socket, handlers } = fakeSocket();
  const service = fakeService();
  service.joinJam.mockRejectedValue(new JamError('JAM_NOT_FOUND', 'No such jam'));
  bindJamHandlers(socket, service);
  const ack = vi.fn();

  await handlers['jam:join'](null, ack);

  expect(ack).toHaveBeenCalledWith({ ok: false, error: { code: 'JAM_NOT_FOUND', message: 'No such jam' } });
});

test('a missing ack emits jam:error NO_ACK to this socket and skips the service', async () => {
  const { socket, handlers } = fakeSocket();
  const service = fakeService();
  bindJamHandlers(socket, service);

  await handlers['jam:join']({ jamId: 'AB12CD', userId: 'u', name: 'n' });
  await handlers['room:command']({ type: 'PLAY' }, 'not-a-function');

  expect(socket.emit).toHaveBeenCalledTimes(2);
  for (const [event, body] of socket.emit.mock.calls) {
    expect(event).toBe('jam:error');
    expect(body).toMatchObject({ code: 'NO_ACK', message: expect.any(String) });
  }
  expect(service.joinJam).not.toHaveBeenCalled();
  expect(service.handleCommand).not.toHaveBeenCalled();
});

// ---------- jam:resync ----------

test('jam:resync before joining → NOT_JOINED, no snapshot read', async () => {
  const { socket, handlers } = fakeSocket();
  const service = fakeService();
  bindJamHandlers(socket, service);
  const ack = vi.fn();

  await handlers['jam:resync']({}, ack);

  expect(ack).toHaveBeenCalledWith({ ok: false, error: { code: 'NOT_JOINED', message: 'Join a jam first' } });
  expect(service.getSnapshot).not.toHaveBeenCalled();
});

test('jam:resync after joining acks a fresh snapshot of the joined jam', async () => {
  const { socket, handlers } = fakeSocket();
  const service = fakeService();
  bindJamHandlers(socket, service);
  await handlers['jam:join']({ jamId: 'AB12CD', userId: 'u1', name: 'Tuan' }, vi.fn());
  service.getSnapshot.mockClear();
  const ack = vi.fn();

  await handlers['jam:resync']({ jamId: 'OTHER1' }, ack); // client fields ignored

  expect(service.getSnapshot).toHaveBeenCalledWith('AB12CD');
  expect(ack).toHaveBeenCalledWith({ ok: true, snapshot });
});

test('jam:resync maps BUSY and unknown errors', async () => {
  const { socket, handlers } = fakeSocket();
  const service = fakeService();
  bindJamHandlers(socket, service);
  await handlers['jam:join']({ jamId: 'AB12CD', userId: 'u1', name: 'Tuan' }, vi.fn());

  service.getSnapshot.mockRejectedValueOnce(new JamError('BUSY', 'busy'));
  const ack1 = vi.fn();
  await handlers['jam:resync']({}, ack1);
  expect(ack1).toHaveBeenCalledWith({ ok: false, error: { code: 'BUSY', message: 'busy' } });

  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  service.getSnapshot.mockRejectedValueOnce(new Error('redis gone'));
  const ack2 = vi.fn();
  await handlers['jam:resync']({}, ack2);
  expect(ack2).toHaveBeenCalledWith({ ok: false, error: { code: 'INTERNAL', message: 'Something went wrong' } });
  errSpy.mockRestore();
});

test('jam:resync without an ack emits jam:error NO_ACK', async () => {
  const { socket, handlers } = fakeSocket();
  const service = fakeService();
  bindJamHandlers(socket, service);
  await handlers['jam:join']({ jamId: 'AB12CD', userId: 'u1', name: 'Tuan' }, vi.fn());
  service.getSnapshot.mockClear();

  await handlers['jam:resync']({});

  expect(socket.emit).toHaveBeenCalledWith('jam:error', expect.objectContaining({ code: 'NO_ACK' }));
  expect(service.getSnapshot).not.toHaveBeenCalled();
});

test('a guest join stores no host token; the gateway re-checks the host after joins and disconnects', async () => {
  const { socket, handlers } = fakeSocket();
  const service = fakeService();
  service.joinJam.mockResolvedValueOnce({ isHost: false, userId: 'g', name: 'G', host: { userId: 'h', name: 'H' } });
  service.reassessHost = vi.fn(async () => {});
  bindJamHandlers(socket, service);
  const ack = vi.fn();

  await handlers['jam:join']({ jamId: 'AB12CD', userId: 'g', name: 'G', hostToken: 'guessed' }, ack);
  expect(ack.mock.calls[0][0]).not.toHaveProperty('hostToken');
  expect(ack.mock.calls[0][0]).toMatchObject({ ok: true, isHost: false, host: { userId: 'h', name: 'H' } });
  expect(socket.data.hostToken).toBeNull();
  expect(service.reassessHost).toHaveBeenCalledWith('AB12CD');

  handlers.disconnect();
  expect(service.reassessHost).toHaveBeenCalledTimes(2);
});

test('jam:claimHost stores the token on the socket only if the service verifies it', async () => {
  const { socket, handlers } = fakeSocket();
  const service = fakeService();
  service.joinJam.mockResolvedValueOnce({ isHost: false, userId: 'g', name: 'G', host: { userId: null, name: null } });
  service.verifyHost = vi.fn(async (jamId, userId, token) => token === 'real');
  bindJamHandlers(socket, service);
  await handlers['jam:join']({ jamId: 'AB12CD', userId: 'g', name: 'G' }, vi.fn());

  const bad = vi.fn();
  await handlers['jam:claimHost']({ hostToken: 'forged' }, bad);
  expect(bad).toHaveBeenCalledWith({ ok: true, isHost: false });
  expect(socket.data.hostToken).toBeNull();

  const good = vi.fn();
  await handlers['jam:claimHost']({ hostToken: 'real' }, good);
  expect(service.verifyHost).toHaveBeenLastCalledWith('AB12CD', 'g', 'real');
  expect(good).toHaveBeenCalledWith({ ok: true, isHost: true });
  expect(socket.data.hostToken).toBe('real');
});
