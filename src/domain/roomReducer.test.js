import {beforeEach, expect, test, vi } from 'vitest'
import roomReducer from './roomReducer.js'
import { Vote, AddTrack, RemoveTrack } from './commands.js';


// create test case
function makeTrack(overrides = {}) {
    return     {
        trackId: 'abd123',
        addedBy: 'userB',
        addedAt: 1123123123214,
        upvotedBy: [],
        ...overrides,
    }
}
let initialState;
beforeEach(() => {
    initialState = [
        {
            trackId: 'abd123',
            addedBy: 'userB',
            addedAt: 1123123123214,
            upvotedBy: ['userA', 'userB'],
        },
    ]

}
)



const expected = [
    {
        trackId: 'abd123',
        addedBy: 'userB',
        addedAt: 1123123123214,
        upvotedBy: ['userA', 'userB'],
    },
    makeTrack({trackId: '1'})
]

test('add track', () => {
    expect(roomReducer( initialState, 
        AddTrack('1','userB',1123123123214)
    )).toStrictEqual(expected)
})


const expected2 = [
    {
        trackId: 'abd123',
        addedBy: 'userB',
        addedAt: 1123123123214,
        upvotedBy: ['userA', 'userB', 'userT'],
    },
]

test('upvote with none exist user', () => {
    expect(roomReducer( initialState, Vote('abd123','userT')
    )).toStrictEqual(expected2)
})

test('upvote with existed user', () => {
    expect(roomReducer( initialState, Vote('abd123','userA')
    )).toStrictEqual(initialState)
})

test('REMOVE_TRACK removes the track with that id', () => {
    expect(roomReducer(initialState, RemoveTrack('abd123'))).toStrictEqual([])
})

test('REMOVE_TRACK with an absent id is a no-op', () => {
    expect(roomReducer(initialState, RemoveTrack('nope'))).toStrictEqual(initialState)
})

test('REMOVE_TRACK preserves the order of the remaining tracks', () => {
    const state = [makeTrack({trackId: 'a'}), makeTrack({trackId: 'b'}), makeTrack({trackId: 'c'}), makeTrack({trackId: 'd'})]
    const result = roomReducer(state, RemoveTrack('b'))
    expect(result.map(t => t.trackId)).toEqual(['a', 'c', 'd'])
})
