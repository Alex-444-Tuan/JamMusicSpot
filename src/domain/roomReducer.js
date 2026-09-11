// {
//   queue: [
//     {
//       trackId: 'abc123',
//       addedBy: 'userA',
//       addedAt: 1735689600000,   // ms epoch, comes from a command field, not Date.now()
//       upvotedBy: ['userA', 'userB'],  // tracking voter identity — see idempotency discussion
//     },
//   ],
//   nowPlaying: null,  // or a trackId
//   version: 0,        // bumped by the store layer, not the reducer itself
// }
import { ADD_TRACK, UPVOTE } from './commands.js'

export default function roomReducer(state, command){
    switch(command.type){
        case ADD_TRACK: {
            return [
                ...state,
                {
                    trackId: command.payload.trackId,
                    addedBy: command.payload.addedBy,
                    addedAt: command.payload.addedAt,
                    upvotedBy: []
                }
            ]
        }
        case UPVOTE: {
            // currently brute forcing on finding the right userId and right trackId by doing linear search
            // later i think we will have another variable unordered set will hold trackId and the index it in the current queue
            // the same thing for userId (need review from you)
            return state.map( track => {
                if(track.trackId !== command.payload.trackId){
                    return track;
                }
                if(track.upvotedBy.includes(command.payload.userId)){
                    return track;
                }

                return {
                    ...track,
                    upvotedBy: [
                        ...track.upvotedBy,
                        command.payload.userId
                    ]
                }
            })
        }
        default:
            return state
    }
}