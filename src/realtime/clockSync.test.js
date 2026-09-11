import { expect, test, vi } from 'vitest'
import bindPingHandler from './clockSync'

test('replies with time from the injected source', () => {
    const handlers = {};
    const fakeSocket = {on: (event, fn) => {handlers[event] = fn; }};
    const clockPort = {now: () => 42};
    const ack = vi.fn();

    bindPingHandler(fakeSocket, clockPort);
    handlers['clock:sync']({}, ack);

    expect(ack).toHaveBeenCalledWith({serverTime: 42});
})

test('replies with concurrent requests from different clients', () => {
    const handlers1 = {};
    const handlers2 = {};
    const fakeSocket1 = {on: (event, fn) => {handlers1[event] = fn;}};
    const fakeSocket2 = {on: (event, fn) => {handlers2[event] = fn;}};
    const clockPort1 = {now: () => 42};
    const clockPort2 = {now: () => 32};

    const ack2 = vi.fn();
    const ack1 = vi.fn();
    bindPingHandler(fakeSocket2, clockPort2);
    bindPingHandler(fakeSocket1, clockPort1);
    
    handlers1['clock:sync']({},ack1);
    handlers2['clock:sync']({},ack2);
    

    expect(ack1).toHaveBeenCalledWith({serverTime: 42});
    expect(ack2).toHaveBeenCalledWith({serverTime: 32});
    
})