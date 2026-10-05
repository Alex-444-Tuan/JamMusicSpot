import { JamError } from '../../services/errors.js';

const STATUS = { JAM_NOT_FOUND: 404, UNKNOWN_TRACK: 404, BAD_REQUEST: 400 };

// Uniform JSON error envelope: {error: {code, message}}.
export function sendError(res, status, code, message){
    res.status(status).json({ error: { code, message } });
}

export function sendServiceError(res, err, context){
    if(err instanceof JamError && STATUS[err.code]){
        return sendError(res, STATUS[err.code], err.code, err.message);
    }
    console.error(`[http] ${context} failed:`, err);
    return sendError(res, 500, 'INTERNAL', 'Something went wrong');
}
