function bindPingHandler(socket, timeSource) {
    socket.on("clock:sync", (clientPayload, ack) => {
        ack({serverTime: timeSource.now()})
    })
}



export default bindPingHandler