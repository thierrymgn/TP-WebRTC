let socket = null;
let webrtcHandler = null;
let currentUser = null;
let connectedUsers = [];
let currentCall = null;
let callStartTime = null;
let callTimer = null;

const AppState = {
    LOGIN: 'login',
    IDLE: 'idle',
    OUTGOING_CALL: 'outgoing-call',
    INCOMING_CALL: 'incoming-call',
    ACTIVE_CALL: 'active-call'
};

let currentState = AppState.LOGIN;

function checkScreenShareSupport() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        console.warn('Screen sharing not supported by this browser');
        
        const shareBtn = document.getElementById('share-screen-btn');
        if (shareBtn) {
            shareBtn.style.display = 'none';
        }
        return false;
    }
    
    console.log('Screen sharing is supported');
    return true;
}

document.addEventListener('DOMContentLoaded', () => {
    console.log('Call Center WebRTC initialized');
    setupEventListeners();
    checkMediaPermissions();
    checkScreenShareSupport();
    showPage('login-page');
});

function setupEventListeners() {
    const connectBtn = document.getElementById('connect-btn');
    const usernameInput = document.getElementById('username-input');

    connectBtn.addEventListener('click', handleConnect);
    usernameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleConnect();
    });

    const disconnectBtn = document.getElementById('disconnect-btn');
    disconnectBtn.addEventListener('click', handleDisconnect);

    const cancelCallBtn = document.getElementById('cancel-call-btn');
    const acceptCallBtn = document.getElementById('accept-call-btn');
    const rejectCallBtn = document.getElementById('reject-call-btn');
    const endCallBtn = document.getElementById('end-call-btn');

    cancelCallBtn.addEventListener('click', cancelCall);
    acceptCallBtn.addEventListener('click', acceptCall);
    rejectCallBtn.addEventListener('click', rejectCall);
    endCallBtn.addEventListener('click', endCall);

    const toggleAudioBtn = document.getElementById('toggle-audio-btn');
    const toggleVideoBtn = document.getElementById('toggle-video-btn');
    const shareScreenBtn = document.getElementById('share-screen-btn');
    const testMediaBtn = document.getElementById('test-media-btn');

    toggleAudioBtn.addEventListener('click', toggleAudio);
    toggleVideoBtn.addEventListener('click', toggleVideo);
    shareScreenBtn.addEventListener('click', toggleScreenShare);
    testMediaBtn.addEventListener('click', testMediaAccess);

    window.addEventListener('webrtc-connected', onWebRTCConnected);
    window.addEventListener('webrtc-ended', onWebRTCEnded);
}

async function handleConnect() {
    const usernameInput = document.getElementById('username-input');
    const username = usernameInput.value.trim();

    if (!username) {
        showError('Please enter a username');
        return;
    }

    if (username.length < 2) {
        showError('Username must contain at least 2 characters');
        return;
    }

    try {
        await connectToServer(username);
    } catch (error) {
        showError('Server connection error');
        console.error('Connection error:', error);
    }
}

function connectToServer(username) {
    return new Promise((resolve, reject) => {
        socket = io();

        webrtcHandler = new WebRTCHandler(socket);

        socket.on('connection-success', (data) => {
            currentUser = data;
            document.getElementById('current-username').textContent = username;
            showPage('main-page');
            setState(AppState.IDLE);
            showNotification('Connection successful!', 'success');
            resolve();
        });

        socket.on('connection-error', (message) => {
            showError(message);
            reject(new Error(message));
        });

        socket.on('users-list', updateUsersList);
        socket.on('user-joined', addUser);
        socket.on('user-left', removeUser);

        setupCallHandlers();

        socket.emit('user-connect', username);
    });
}

function setupCallHandlers() {
    socket.on('incoming-call', (data) => {
        currentCall = data;
        document.getElementById('incoming-caller-name').textContent = data.callerName;
        setState(AppState.INCOMING_CALL);
        showNotification(`Incoming call from ${data.callerName}`, 'warning');
    });

    socket.on('call-sent', (data) => {
        currentCall = data;
        document.getElementById('outgoing-target-name').textContent = data.targetName;
        setState(AppState.OUTGOING_CALL);
    });

    socket.on('call-accepted', async (data) => {
        showNotification(`${data.accepterName} accepted your call`, 'success');

        try {
            await webrtcHandler.startCall(data.accepterId, true);
            startCallTimer();
            setState(AppState.ACTIVE_CALL);
            document.getElementById('active-call-name').textContent = data.accepterName;
        } catch (error) {
            showNotification('Error establishing call', 'error');
            endCall();
        }
    });

    socket.on('call-rejected', (data) => {
        showNotification(`${data.rejecterName} rejected your call`, 'error');
        setState(AppState.IDLE);
        currentCall = null;
    });

    socket.on('call-ended', () => {
        showNotification('Call has ended', 'warning');
        endCall();
    });

    socket.on('call-error', (message) => {
        showNotification(message, 'error');
        setState(AppState.IDLE);
        currentCall = null;
    });
}

function updateUsersList(users) {
    connectedUsers = users.filter(user => user.id !== currentUser?.id);
    renderUsersList();
}

function addUser(user) {
    if (user.id !== currentUser?.id) {
        connectedUsers.push(user);
        renderUsersList();
        showNotification(`${user.username} connected`, 'success');
    }
}

function removeUser(data) {
    connectedUsers = connectedUsers.filter(user => user.id !== data.userId);
    renderUsersList();
    showNotification(`${data.username} disconnected`, 'warning');
}

function renderUsersList() {
    const usersList = document.getElementById('users-list');
    const usersCount = document.getElementById('users-count');

    usersCount.textContent = connectedUsers.length;

    if (connectedUsers.length === 0) {
        usersList.innerHTML = '<p style="color: #666; text-align: center; padding: 2rem;">No other users connected</p>';
        return;
    }

    usersList.innerHTML = connectedUsers.map(user => `
        <div class="user-item ${user.status !== 'available' ? 'busy' : ''}" 
             onclick="initiateCall('${user.id}', '${user.username}')"
             data-user-id="${user.id}">
            <div class="status-indicator ${user.status}">
                <span class="status-dot"></span>
                ${getStatusText(user.status)}
            </div>
            <strong>${user.username}</strong>
        </div>
    `).join('');
}

function getStatusText(status) {
    switch (status) {
        case 'available': return 'Available';
        case 'busy': return 'Busy';
        case 'calling': return 'In call';
        default: return 'Unknown';
    }
}

function initiateCall(userId, username) {
    if (currentState !== AppState.IDLE) {
        showNotification('You cannot make a call right now', 'error');
        return;
    }

    const user = connectedUsers.find(u => u.id === userId);
    if (!user || user.status !== 'available') {
        showNotification('This user is not available', 'error');
        return;
    }

    socket.emit('call-request', { targetUserId: userId });
}

async function acceptCall() {
    if (!currentCall) {
        showNotification('No call to accept', 'error');
        return;
    }
    
    try {
        socket.emit('call-accepted', { callerId: currentCall.callerId });

        await webrtcHandler.startCall(currentCall.callerId, false);

        startCallTimer();
        setState(AppState.ACTIVE_CALL);
        document.getElementById('active-call-name').textContent = currentCall.callerName;
    } catch (error) {
        console.error('Error during call acceptance:', error);
        showNotification('Error during call acceptance: ' + error.message, 'error');

        setState(AppState.IDLE);
        currentCall = null;
    }
}

function rejectCall() {
    if (!currentCall) {
        showNotification('No call to reject', 'error');
        return;
    }
    
    socket.emit('call-rejected', { callerId: currentCall.callerId });
    setState(AppState.IDLE);
    currentCall = null;
}

function cancelCall() {
    if (currentCall) {
        socket.emit('call-ended', { otherUserId: currentCall.targetId });
    }
    setState(AppState.IDLE);
    currentCall = null;
}

function endCall() {
    if (currentCall) {
        socket.emit('call-ended', {
            otherUserId: currentCall.targetId || currentCall.callerId || currentCall.accepterId
        });
    }

    if (webrtcHandler) {
        webrtcHandler.endCall();
    }

    stopCallTimer();
    setState(AppState.IDLE);
    currentCall = null;
}

function toggleAudio() {
    if (!webrtcHandler) return;

    const isEnabled = webrtcHandler.toggleAudio();
    const btn = document.getElementById('toggle-audio-btn');

    btn.classList.toggle('active', isEnabled);
    btn.querySelector('.btn-icon').textContent = isEnabled ? '🎤' : '🔇';
    btn.title = isEnabled ? 'Mute microphone' : 'Enable microphone';
}

function toggleVideo() {
    if (!webrtcHandler) return;

    const isEnabled = webrtcHandler.toggleVideo();
    const btn = document.getElementById('toggle-video-btn');

    btn.classList.toggle('active', isEnabled);
    btn.querySelector('.btn-icon').textContent = isEnabled ? '📹' : '📵';
    btn.title = isEnabled ? 'Turn off camera' : 'Turn on camera';
}

async function toggleScreenShare() {
    if (!webrtcHandler) {
        console.warn('WebRTC handler not available');
        return;
    }
    
    const btn = document.getElementById('share-screen-btn');
    const isSharing = btn.classList.contains('active');
    
    console.log('Toggle screen share. Currently sharing:', isSharing);
    
    try {
        if (isSharing) {
            console.log('Stopping screen share...');
            await webrtcHandler.stopScreenShare();
            
            btn.classList.remove('active');
            btn.querySelector('.btn-icon').textContent = '🖥️';
            btn.title = 'Share screen';
            
            showNotification('Screen sharing stopped', 'info');
            
        } else {
            console.log('Starting screen share...');
            const success = await webrtcHandler.shareScreen();
            
            if (success) {
                btn.classList.add('active');
                btn.querySelector('.btn-icon').textContent = '🔳';
                btn.title = 'Stop sharing';
                
                showNotification('Screen sharing started', 'success');
            } else {
                showNotification('Failed to start screen sharing', 'error');
            }
        }
    } catch (error) {
        console.error('Screen sharing error:', error);
        showNotification('Screen sharing error: ' + error.message, 'error');
        
        btn.classList.remove('active');
        btn.querySelector('.btn-icon').textContent = '🖥️';
        btn.title = 'Share screen';
    }
}

function startCallTimer() {
    callStartTime = Date.now();
    callTimer = setInterval(updateCallDuration, 1000);
}

function stopCallTimer() {
    if (callTimer) {
        clearInterval(callTimer);
        callTimer = null;
    }
    callStartTime = null;

    const durationEl = document.getElementById('call-duration');
    if (durationEl) {
        durationEl.textContent = '00:00';
    }
}

function updateCallDuration() {
    if (!callStartTime) return;

    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;

    const durationEl = document.getElementById('call-duration');
    if (durationEl) {
        durationEl.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
}

function onWebRTCConnected() {
    showNotification('Video connection established', 'success');
}

function onWebRTCEnded() {
    setState(AppState.IDLE);
    currentCall = null;
}

function setState(newState) {
    currentState = newState;

    document.querySelectorAll('.call-state').forEach(state => {
        state.classList.remove('active');
    });

    switch (newState) {
        case AppState.IDLE:
            document.getElementById('idle-state').classList.add('active');
            break;
        case AppState.OUTGOING_CALL:
            document.getElementById('outgoing-call-state').classList.add('active');
            break;
        case AppState.INCOMING_CALL:
            document.getElementById('incoming-call-state').classList.add('active');
            break;
        case AppState.ACTIVE_CALL:
            document.getElementById('active-call-state').classList.add('active');
            break;
    }
}

function showPage(pageId) {
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });
    document.getElementById(pageId).classList.add('active');
}

function showNotification(message, type = 'info') {
    const container = document.getElementById('notifications');
    const notification = document.createElement('div');

    notification.className = `notification ${type}`;
    notification.textContent = message;

    container.appendChild(notification);

    setTimeout(() => {
        if (notification.parentNode) {
            notification.remove();
        }
    }, 4000);
}

function showError(message) {
    const errorEl = document.getElementById('login-error');
    errorEl.textContent = message;
    errorEl.classList.add('show');

    setTimeout(() => {
        errorEl.classList.remove('show');
    }, 3000);
}

function handleDisconnect() {
    if (socket) {
        socket.disconnect();
    }

    if (webrtcHandler) {
        webrtcHandler.endCall();
    }

    currentUser = null;
    connectedUsers = [];
    currentCall = null;

    showPage('login-page');
    setState(AppState.LOGIN);

    document.getElementById('username-input').value = '';
    document.getElementById('login-error').classList.remove('show');
}

async function testMediaAccess() {
    const testBtn = document.getElementById('test-media-btn');
    const resultDiv = document.getElementById('media-test-result');
    
    testBtn.disabled = true;
    testBtn.textContent = '⏳ Testing...';
    resultDiv.textContent = '';
    resultDiv.className = 'test-result';
    
    console.log('Starting media access test...');
    
    try {
        const constraints = {
            audio: true,
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 }
            }
        };
        
        console.log('Requesting user media with constraints:', constraints);
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        const audioTracks = stream.getAudioTracks();
        const videoTracks = stream.getVideoTracks();
        
        console.log('Audio tracks found:', audioTracks.length);
        console.log('Video tracks found:', videoTracks.length);
        
        let message = '✅ ';
        if (audioTracks.length > 0 && videoTracks.length > 0) {
            message += 'Camera and microphone OK';
            resultDiv.className = 'test-result success';
        } else if (audioTracks.length > 0) {
            message += 'Microphone OK, no camera';
            resultDiv.className = 'test-result warning';
        } else if (videoTracks.length > 0) {
            message += 'Camera OK, no microphone';
            resultDiv.className = 'test-result warning';
        } else {
            message += 'No media available';
            resultDiv.className = 'test-result error';
        }
        
        resultDiv.textContent = message;
        
        stream.getTracks().forEach(track => {
            console.log('Stopping test track:', track.kind);
            track.stop();
        });
        
        showNotification('Media test completed', 'success');
        
    } catch (error) {
        console.error('Media test error:', error);
        
        let errorMessage = '❌ ';
        switch (error.name) {
            case 'NotAllowedError':
                errorMessage += 'Permissions denied. Please allow access in your browser.';
                break;
            case 'NotFoundError':
                errorMessage += 'No camera/microphone detected.';
                break;
            case 'NotReadableError':
                errorMessage += 'Media already in use by another application.';
                break;
            default:
                errorMessage += 'Error: ' + error.message;
        }
        
        resultDiv.textContent = errorMessage;
        resultDiv.className = 'test-result error';

        showNotification('Error during media test', 'error');
    } finally {
        testBtn.disabled = false;
        testBtn.textContent = '🎥 Test Camera/Microphone';
    }
}

async function checkMediaPermissions() {
    try {
        const permissions = await navigator.permissions.query({ name: 'camera' });
        console.log('Camera permission:', permissions.state);

        const audioPermissions = await navigator.permissions.query({ name: 'microphone' });
        console.log('Microphone permission:', audioPermissions.state);

        if (permissions.state === 'denied' || audioPermissions.state === 'denied') {
            showNotification('Media permissions denied. Click the lock icon in the address bar to allow them.', 'warning');
        }
    } catch (error) {
        console.log('Unable to check permissions:', error);
    }
}

window.addEventListener('error', (event) => {
    console.error('JavaScript error:', event.error);
    showNotification('An error occurred', 'error');
});

window.addEventListener('beforeunload', () => {
    if (socket) {
        socket.disconnect();
    }
});