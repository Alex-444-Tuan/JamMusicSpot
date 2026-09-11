import {beforeEach, expect, test, vi } from 'vitest'
import roomReducer from './roomReducer.js'
import { Vote, AddTrack } from './commands.js';


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