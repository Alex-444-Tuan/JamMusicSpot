export const ADD_TRACK = 'ADD_TRACK';
export const UPVOTE = 'UPVOTE';
export const REMOVE_TRACK = 'REMOVE_TRACK';
export const PLAY = 'PLAY';
export const PAUSE = 'PAUSE';
export const SKIP = 'SKIP';

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

export function RemoveTrack(trackId){
    return {
        type: REMOVE_TRACK,
        payload: { trackId }
    }
}

// Playback commands. `at` is always a server timestamp (ms epoch) stamped
// by the service layer, never a client-supplied value.
export function Play(at){
    return {
        type: PLAY,
        payload: { at }
    }
}

export function Pause(at){
    return {
        type: PAUSE,
        payload: { at }
    }
}

// trackId === null means the queue is exhausted → playback goes IDLE.
export function Skip(trackId, at){
    return {
        type: SKIP,
        payload: { trackId, at }
    }
}
