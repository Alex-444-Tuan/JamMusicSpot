import { Router } from 'express';

const PING_TIMEOUT_MS = 1000;

export function createHealthHandlers({ redis, logStatus }){
    function pingRedis(){
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('redis ping timed out')), PING_TIMEOUT_MS);
        });
        return Promise.race([redis.ping(), timeout]).finally(() => clearTimeout(timer));
    }

    return {
        // GET /healthz → 200 {status:'ok', redis:'ok', mongo} | 503 {status:'error', redis:'down', mongo}
        // Redis is required (queue, playback, locks); Mongo only backs the
        // best-effort command log, so it is reported but never fails the check.
        async check(req, res){
            const mongo = logStatus();
            try{
                await pingRedis();
                res.json({ status: 'ok', redis: 'ok', mongo });
            } catch {
                res.status(503).json({ status: 'error', redis: 'down', mongo });
            }
        },
    };
}

export function createHealthRouter(deps){
    const router = Router();
    router.get('/', createHealthHandlers(deps).check);
    return router;
}
