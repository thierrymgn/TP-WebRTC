class SignalingServer {
    constructor(io) {
        this.io = io;
        this.connectedUsers = new Map();
        this.activeRooms = new Map();
    }

    initialize() {
        this.io.on('connection', (socket) => {
            console.log(`[Signaling] New connection: ${socket.id}`);
            this.handleConnection(socket);
        });
    }

    handleConnection(socket) {
        socket.on('user-connect', (username) => {
            this.handleUserConnect(socket, username);
        });

        socket.on('call-request', (data) => {
            this.handleCallRequest(socket, data);
        });

        socket.on('call-accepted', (data) => {
            this.handleCallAccepted(socket, data);
        });

        socket.on('call-rejected', (data) => {
            this.handleCallRejected(socket, data);
        });

        socket.on('call-ended', (data) => {
            this.handleCallEnded(socket, data);
        });

        socket.on('webrtc-offer', (data) => {
            this.forwardWebRTCMessage(socket, 'webrtc-offer', data);
        });

        socket.on('webrtc-answer', (data) => {
            this.forwardWebRTCMessage(socket, 'webrtc-answer', data);
        });

        socket.on('webrtc-ice-candidate', (data) => {
            this.forwardWebRTCMessage(socket, 'webrtc-ice-candidate', data);
        });

        socket.on('disconnect', () => {
            this.handleDisconnection(socket);
        });
    }

    handleUserConnect(socket, username) {
        const existingUser = Array.from(this.connectedUsers.values())
            .find(user => user.username === username);
        
        if (existingUser) {
            socket.emit('connection-error', 'This username is already taken');
            return;
        }

        const userInfo = {
            id: socket.id,
            username: username,
            status: 'available',
            connectedAt: new Date()
        };
        
        this.connectedUsers.set(socket.id, userInfo);
        
        socket.emit('connection-success', {
            userId: socket.id,
            username: username
        });

        this.sendUsersList(socket);
        
        socket.broadcast.emit('user-joined', {
            id: socket.id,
            username: username,
            status: 'available'
        });

        console.log(`[Signaling] ${username} connected (${socket.id})`);
    }

    handleCallRequest(socket, data) {
        const { targetUserId } = data;
        const caller = this.connectedUsers.get(socket.id);
        const target = this.connectedUsers.get(targetUserId);

        if (!caller || !target) {
            socket.emit('call-error', 'User not found');
            return;
        }

        if (target.status !== 'available') {
            socket.emit('call-error', 'User is not available');
            return;
        }

        const roomId = this.generateRoomId(socket.id, targetUserId);
        
        caller.status = 'calling';
        target.status = 'receiving-call';
        
        this.activeRooms.set(roomId, {
            callerId: socket.id,
            targetId: targetUserId,
            status: 'pending',
            createdAt: new Date()
        });
        
        this.io.to(targetUserId).emit('incoming-call', {
            callerId: socket.id,
            callerName: caller.username,
            roomId: roomId
        });

        socket.emit('call-sent', {
            targetId: targetUserId,
            targetName: target.username,
            roomId: roomId
        });

        console.log(`[Signaling] ${caller.username} is calling ${target.username} (Room: ${roomId})`);
    }

    handleCallAccepted(socket, data) {
        const { callerId } = data;
        const accepter = this.connectedUsers.get(socket.id);
        const caller = this.connectedUsers.get(callerId);

        if (!accepter || !caller) {
            socket.emit('call-error', 'User not found');
            return;
        }

        const roomId = this.findRoomByUsers(callerId, socket.id);
        if (roomId) {
            const room = this.activeRooms.get(roomId);
            room.status = 'active';
            room.acceptedAt = new Date();
            
            this.io.sockets.sockets.get(callerId)?.join(roomId);
            this.io.sockets.sockets.get(socket.id)?.join(roomId);
        }

        accepter.status = 'busy';
        caller.status = 'busy';

        this.io.to(callerId).emit('call-accepted', {
            accepterId: socket.id,
            accepterName: accepter.username,
            roomId: roomId
        });

        console.log(`[Signaling] ${accepter.username} accepted call from ${caller.username}`);
    }

    handleCallRejected(socket, data) {
        const { callerId } = data;
        const rejecter = this.connectedUsers.get(socket.id);
        const caller = this.connectedUsers.get(callerId);

        if (!rejecter || !caller) return;

        const roomId = this.findRoomByUsers(callerId, socket.id);
        if (roomId) {
            this.activeRooms.delete(roomId);
        }

        rejecter.status = 'available';
        caller.status = 'available';

        this.io.to(callerId).emit('call-rejected', {
            rejecterId: socket.id,
            rejecterName: rejecter.username
        });

        console.log(`[Signaling] ${rejecter.username} rejected call from ${caller.username}`);
    }

    handleCallEnded(socket, data) {
        const { otherUserId } = data;
        const user = this.connectedUsers.get(socket.id);
        const otherUser = this.connectedUsers.get(otherUserId);

        const roomId = this.findRoomByUsers(socket.id, otherUserId);
        if (roomId) {
            this.io.sockets.sockets.get(socket.id)?.leave(roomId);
            this.io.sockets.sockets.get(otherUserId)?.leave(roomId);
            
            this.activeRooms.delete(roomId);
        }

        if (user) user.status = 'available';
        if (otherUser) otherUser.status = 'available';

        if (otherUserId) {
            this.io.to(otherUserId).emit('call-ended', {
                userId: socket.id
            });
        }

        console.log(`[Signaling] Call ended between ${user?.username} and ${otherUser?.username}`);
    }

    forwardWebRTCMessage(socket, eventType, data) {
        const { targetId, ...messageData } = data;
        
        const roomId = this.findRoomByUsers(socket.id, targetId);
        if (!roomId) {
            console.warn(`[Signaling] WebRTC message attempt without active room: ${socket.id} -> ${targetId}`);
            return;
        }

        this.io.to(targetId).emit(eventType, {
            senderId: socket.id,
            ...messageData
        });

        console.log(`[Signaling] ${eventType} forwarded: ${socket.id} -> ${targetId}`);
    }

    handleDisconnection(socket) {
        const user = this.connectedUsers.get(socket.id);
        
        if (user) {
            this.cleanupUserCalls(socket.id);
            
            this.connectedUsers.delete(socket.id);
            
            socket.broadcast.emit('user-left', {
                userId: socket.id,
                username: user.username
            });

            console.log(`[Signaling] ${user.username} disconnected (${socket.id})`);
        }
    }

    sendUsersList(socket) {
        const usersList = Array.from(this.connectedUsers.values())
            .map(user => ({
                id: user.id,
                username: user.username,
                status: user.status
            }));
        
        socket.emit('users-list', usersList);
    }

    generateRoomId(userId1, userId2) {
        const sortedIds = [userId1, userId2].sort();
        return `call_${sortedIds[0]}_${sortedIds[1]}_${Date.now()}`;
    }

    findRoomByUsers(userId1, userId2) {
        for (const [roomId, room] of this.activeRooms) {
            if ((room.callerId === userId1 && room.targetId === userId2) ||
                (room.callerId === userId2 && room.targetId === userId1)) {
                return roomId;
            }
        }
        return null;
    }

    cleanupUserCalls(userId) {
        const userRooms = [];
        for (const [roomId, room] of this.activeRooms) {
            if (room.callerId === userId || room.targetId === userId) {
                userRooms.push({ roomId, room });
            }
        }

        userRooms.forEach(({ roomId, room }) => {
            const otherUserId = room.callerId === userId ? room.targetId : room.callerId;
            const otherUser = this.connectedUsers.get(otherUserId);
            
            if (otherUser) {
                otherUser.status = 'available';
                
                this.io.to(otherUserId).emit('call-ended', {
                    userId: userId
                });
            }
            
            this.activeRooms.delete(roomId);
        });
    }

    getStats() {
        return {
            connectedUsers: this.connectedUsers.size,
            activeRooms: this.activeRooms.size,
            usersList: Array.from(this.connectedUsers.values()).map(user => ({
                username: user.username,
                status: user.status,
                connectedAt: user.connectedAt
            })),
            activeCallsList: Array.from(this.activeRooms.values()).map(room => ({
                status: room.status,
                createdAt: room.createdAt,
                acceptedAt: room.acceptedAt
            }))
        };
    }

    forceDisconnect(userId) {
        const socket = this.io.sockets.sockets.get(userId);
        if (socket) {
            socket.disconnect(true);
            return true;
        }
        return false;
    }

    broadcast(message, type = 'info') {
        this.io.emit('server-message', {
            message: message,
            type: type,
            timestamp: new Date()
        });
    }
}

module.exports = SignalingServer;