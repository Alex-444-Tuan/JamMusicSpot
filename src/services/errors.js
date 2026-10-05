// A domain-level failure that is safe to show to the client: `code` is
// part of the wire contract (e.g. NOT_HOST, STALE_SKIP), `message` is a
// human-readable explanation. Anything that is NOT a JamError is treated
// as an internal fault and reported to clients only as INTERNAL.
export class JamError extends Error {
    constructor(code, message = code){
        super(message);
        this.name = 'JamError';
        this.code = code;
    }
}
