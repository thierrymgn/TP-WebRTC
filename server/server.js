const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);


const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});

app.use(cors());
app.use(express.static(path.join(__dirname, '../client')));

const connectedUsers = new Map();

app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, '../client/index.html'));
});

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('user-connect', (username) => {

        const existingUser = Array.from(connectedUsers.values())
            .find(user => user.username === username);

        if (existingUser) {
            socket.emit('connection-error', 'Username already taken');
            return;
        }

        const userInfo = {
            id: socket.id,
            username: username,
            status: 'available',
        };

        connectedUsers.set(socket.id, userInfo);

        socket.emit('connection-success', {
            userId: socket.id,
            username: username,
        });

        const usersList = Array.from(connectedUsers.values())
            .map(user => ({
                id: user.id,
                username: user.username,
                status: user.status,
            }));

        socket.emit('users-list', usersList);

        socket.broadcast.emit('user-joined', {
            id: socket.id,
            username: username,
            status: 'available',
        });

        console.log(`${username} is connected (ID: ${socket.id})`);
    });

    socket.on('call-request', (data) => {
        const { targetUserId } = data;
        const caller = connectedUsers.get(socket.id);
        const target = connectedUsers.get(targetUserId);

        if (!caller || !target) {
            socket.emit('call-error', 'user not found');
            return;
        }

        if (target.status !== 'available') {
            socket.emit('call-error', 'user not available');
            return;
        }

        caller.status = 'calling';
        target.status = 'receiving-call';

        io.to(targetUserId).emit('incoming-call', {
            callerId: socket.id,
            callerName: caller.username,
        });

        socket.emit('call-sent', {
            targetId: targetUserId,
            targetName: target.username
        });

        console.log(`${caller.username} is calling ${target.username}`);
    });

    socket.on('call-accepted', (data) => {
        const { callerId } = data;
        const accepter = connectedUsers.get(socket.id);
        const caller = connectedUsers.get(callerId);

        if (!accepter || !caller) {
            return;
        }

        accepter.status = 'busy';
        caller.status = 'busy';

        io.to(callerId).emit('call-accepted', {
            accepterId: socket.id,
            accepterName: accepter.username
        });

        console.log(`${accepter.username} accepted the call from ${caller.username}`);
    });

    socket.on('call-rejected', (data) => {
        const { callerId } = data;
        const rejecter = connectedUsers.get(socket.id);
        const caller = connectedUsers.get(callerId);

        if (!rejecter || !caller) {
            return;
        }

        rejecter.status = 'available';
        caller.status = 'available';

        io.to(callerId).emit('call-rejected', {
            rejecterId: socket.id,
            rejecterName: rejecter.username
        });

        console.log(`${rejecter.username} rejected the call from ${caller.username}`);
    });

    socket.on('call-ended', (data) => {
        const { otherUserId } = data;
        const user = connectedUsers.get(socket.id);
        const otherUser = connectedUsers.get(otherUserId);

        if (user) user.status = 'available';
        if (otherUser) otherUser.status = 'available';

        if (otherUserId) {
            io.to(otherUserId).emit('call-ended', {
                userId: socket.id
            });
        }

        console.log(`call ended between ${user?.username} and ${otherUser?.username}`);
    });

    socket.on('webrtc-offer', (data) => {
        const { targetId, offer } = data;
        io.to(targetId).emit('webrtc-offer', {
            senderId: socket.id,
            offer: offer
        });
    });

    socket.on('webrtc-answer', (data) => {
        const { targetId, answer } = data;
        io.to(targetId).emit('webrtc-answer', {
            senderId: socket.id,
            answer: answer
        });
    });

    socket.on('webrtc-ice-candidate', (data) => {
        const { targetId, candidate } = data;
        io.to(targetId).emit('webrtc-ice-candidate', {
            senderId: socket.id,
            candidate: candidate
        });
    });

    socket.on('disconnect', () => {
        const user = connectedUsers.get(socket.id);

        if (user) {
            connectedUsers.delete(socket.id);

            socket.broadcast.emit('user-left', {
                userId: socket.id,
                username: user.username
            });

            console.log(`${user.username} disconnected (ID: ${socket.id})`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`server started on port ${PORT}`);
    console.log(`Client interface available at http://localhost:${PORT}`);
});


