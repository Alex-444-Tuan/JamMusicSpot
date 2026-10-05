import { Router } from 'express';
import { sendServiceError } from './errors.js';

export function createJamsHandlers(service){
    return {
        // POST /api/jams → 201 {jamId, hostToken, inviteUrl}
        async create(req, res){
            try{
                res.status(201).json(await service.createJam());
            } catch (err){
                sendServiceError(res, err, 'POST /api/jams');
            }
        },
        // GET /api/jams/:jamId → 200 {jamId} | 404 JAM_NOT_FOUND
        async get(req, res){
            try{
                res.json(await service.getJam(req.params.jamId));
            } catch (err){
                sendServiceError(res, err, 'GET /api/jams/:jamId');
            }
        },
    };
}

export function createJamsRouter(service){
    const handlers = createJamsHandlers(service);
    const router = Router();
    router.post('/', handlers.create);
    router.get('/:jamId', handlers.get);
    return router;
}
