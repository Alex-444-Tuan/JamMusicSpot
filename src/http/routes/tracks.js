import { Router } from "express";
import { sendError } from './errors.js';

export function createTracksHandlers(storage, catalog){
    const known = new Set(catalog.map((t) => t.trackId));
    return {
        // GET /api/tracks/:trackId/url → 200 {url} | 404 UNKNOWN_TRACK | 500 STORAGE
        // Only catalog tracks are presigned — never an arbitrary client-chosen key.
        async getUrl(req, res){
            const { trackId } = req.params;
            if(!known.has(trackId)){
                return sendError(res, 404, 'UNKNOWN_TRACK', 'That track is not in the catalog');
            }
            try{
                const url = await storage.getURL(`tracks/${trackId}.mp3`);
                res.json({url});
            } catch (err){
                console.error('[http] presign failed:', err);
                sendError(res, 500, 'STORAGE', 'Unable to access storage');
            }
        },
    };
}

export function createTracksRouter(storage, catalog){
    const router = Router();
    router.get('/:trackId/url', createTracksHandlers(storage, catalog).getUrl);
    return router;
}
