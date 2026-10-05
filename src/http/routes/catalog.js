import { Router } from 'express';

export function createCatalogHandlers(catalog){
    // Shape is fixed by the wire contract; copy only the public fields.
    const body = { tracks: catalog.map(({ trackId, title, artist, durationMs, color }) => ({ trackId, title, artist, durationMs, color })) };
    return {
        // GET /api/catalog → 200 {tracks: [...]}
        list(req, res){
            res.json(body);
        },
    };
}

export function createCatalogRouter(catalog){
    const router = Router();
    router.get('/', createCatalogHandlers(catalog).list);
    return router;
}
