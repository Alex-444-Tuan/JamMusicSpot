// {
//   status: 'IDLE' | 'PLAYING' | 'PAUSED',
//   currentTrackId: null | string,
//   startedAt: null | number,   // server ms at which position 0 of the current track "happened"
//   pausedAt: null | number,    // server ms the track was paused at (PAUSED only)
// }
//
// Position derives from these timestamps, never from a stored offset:
//   PLAYING → position = serverNow − startedAt
//   PAUSED  → position = pausedAt − startedAt
//   IDLE    → all fields null
//
// Every command payload carries `at`: a server timestamp stamped by the
// service layer, not Date.now() and never a client value.
import { PLAY, PAUSE, SKIP } from './commands.js';

export default function playbackReducer(state, command){
    switch(command.type){
        case PLAY: {
            if(state.status !== 'PAUSED') return state;
            // Shift startedAt forward by however long we were paused, so the
            // position at resume equals the position at pause.
            return {
                status: 'PLAYING',
                currentTrackId: state.currentTrackId,
                startedAt: command.payload.at - (state.pausedAt - state.startedAt),
                pausedAt: null
            }
        }
        case PAUSE: {
            if(state.status !== 'PLAYING') return state;
            return {
                status: 'PAUSED',
                currentTrackId: state.currentTrackId,
                startedAt: state.startedAt,
                pausedAt: command.payload.at
            }
        }
        case SKIP: {
            if(command.payload.trackId === null){
                return {
                    status: 'IDLE',
                    currentTrackId: null,
                    startedAt: null,
                    pausedAt: null
                }
            }
            return {
                status: 'PLAYING',
                currentTrackId: command.payload.trackId,
                startedAt: command.payload.at,
                pausedAt: null
            }
        }
        default:{
            return state;
        }
    }
}
