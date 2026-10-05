// A "collection" for the command log that survives Mongo outages.
//
// The plain driver Collection is tied to one MongoClient; once that
// client's topology closes (e.g. Mongo was down at boot), every later call
// fails with "Topology is closed" until the process restarts. This wrapper
// exposes the subset the user's commandLog.js uses — insertOne,
// insertMany, createIndex, find(q, o).toArray() — and delegates each call
// to a lazily built MongoClient. On a connectivity failure it closes that
// client and builds a fresh one on the next call; when a rebuilt client
// first succeeds it re-runs the onReconnect hook (ensureIndexes).
//
// commandLog.js still just receives "a collection".

import { MongoClient } from 'mongodb';

const CONNECTIVITY_ERRORS = new Set([
    'MongoTopologyClosedError',
    'MongoNotConnectedError',
    'MongoServerSelectionError',
    'MongoNetworkError',
    'MongoNetworkTimeoutError',
]);

function isConnectivityError(err){
    if(!err) return false;
    if(CONNECTIVITY_ERRORS.has(err.name)) return true;
    return /ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT/.test(String(err.message));
}

const defaultClientFactory = (url) => new MongoClient(url, { serverSelectionTimeoutMS: 5000 });

export function createResilientCollection({ url, dbName, collectionName, clientFactory = defaultClientFactory }){
    let client = null;
    let generation = 0;
    let pendingReconnectHook = false;
    let onReconnect = null;

    function current(){
        if(!client){
            client = clientFactory(url); // may throw (bad URL) — surfaces to the caller
            generation++;
            pendingReconnectHook = generation > 1;
        }
        return client;
    }

    function reset(failed){
        if(client !== failed) return; // another caller already rebuilt it
        client = null;
        Promise.resolve().then(() => failed.close()).catch(() => {});
    }

    async function withCollection(fn){
        let used;
        try{
            used = current();
        } catch (err){
            generation++; // the next successful client counts as a reconnect
            throw err;
        }
        try{
            const result = await fn(used.db(dbName).collection(collectionName));
            if(pendingReconnectHook && client === used){
                pendingReconnectHook = false;
                if(onReconnect){
                    Promise.resolve().then(onReconnect).catch((err) => {
                        console.warn('[mongo] onReconnect hook failed after reconnecting:', err && err.message);
                    });
                }
            }
            return result;
        } catch (err){
            if(isConnectivityError(err)) reset(used);
            throw err;
        }
    }

    return {
        insertOne: (doc, options) => withCollection((c) => (options === undefined ? c.insertOne(doc) : c.insertOne(doc, options))),
        insertMany: (docs, options) => withCollection((c) => (options === undefined ? c.insertMany(docs) : c.insertMany(docs, options))),
        createIndex: (spec, options) => withCollection((c) => (options === undefined ? c.createIndex(spec) : c.createIndex(spec, options))),
        find: (query, options) => ({
            toArray: () => withCollection((c) => c.find(query, options).toArray()),
        }),

        /** Hook run (not awaited) after a rebuilt client's first success — e.g. ensureIndexes. */
        setOnReconnect(fn){
            onReconnect = fn;
        },

        /** Close the current client (graceful shutdown). */
        async close(){
            const c = client;
            client = null;
            if(c) await c.close();
        },

        _withCollection: withCollection,
    };
}
