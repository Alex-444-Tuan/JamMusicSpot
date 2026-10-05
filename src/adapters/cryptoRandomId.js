import { randomInt } from 'node:crypto';

// Cryptographically random string of `length` characters drawn uniformly
// from `alphabet` (randomInt avoids modulo bias). Used for jam ids and
// host tokens.
export function cryptoRandomId(length, alphabet){
    let out = '';
    for(let i = 0; i < length; i++){
        out += alphabet[randomInt(alphabet.length)];
    }
    return out;
}
