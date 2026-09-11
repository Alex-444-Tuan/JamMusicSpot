export const ADD_TRACK = 'ADD_TRACK';
export const UPVOTE = 'UPVOTE';

export function AddTrack(trackId, addedBy, addedAt){
    return {
        type: ADD_TRACK,
        payload: {
            trackId, addedBy, addedAt
        }
    }
}

export function Vote(trackId, userId){
    return{ 
        type: UPVOTE,
        payload: {
            trackId, userId
        }
    }
}

