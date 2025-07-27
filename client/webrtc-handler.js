class WebRTCHandler {
    constructor(socket) {
        this.socket = socket;
        this.peerConnection = null;
        this.localStream = null;
        this.remoteStream = null;
        this.isInitiator = false;
        this.currentPeerId = null;

        this.pcConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        };

        this.mediaConstraints = {
            audio: true,
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: 'user'
            }
        };

        this.setupSocketHandlers();
    }

    setupSocketHandlers() {
        this.socket.on('webrtc-offer', async (data) => {
            console.log('WebRTC offer received from:', data.senderId);
            await this.handleOffer(data.senderId, data.offer);
        });

        this.socket.on('webrtc-answer', async (data) => {
            console.log('WebRTC answer received from:', data.senderId);
            await this.handleAnswer(data.answer);
        });

        this.socket.on('webrtc-ice-candidate', async (data) => {
            console.log('ICE candidate received from:', data.senderId);
            await this.handleIceCandidate(data.candidate);
        });
    }

    async startCall(peerId, isInitiator = false) {
        try {
            this.currentPeerId = peerId;
            this.isInitiator = isInitiator;

            console.log('Starting call with:', peerId, 'Initiator:', isInitiator);

            await this.getLocalMedia();

            await this.createPeerConnection();

            if (isInitiator) {
                await this.createAndSendOffer();
            }

            return true;
        } catch (error) {
            console.error('Error starting call:', error);
            await this.endCall();
            throw error;
        }
    }

    async getLocalMedia() {
        try {
            console.log('Attempting media access with full constraints...');
            this.localStream = await navigator.mediaDevices.getUserMedia(this.mediaConstraints);

        } catch (error) {
            console.warn('Failed with full constraints, trying simplified...', error);

            try {
                const simpleConstraints = {
                    audio: true,
                    video: true
                };
                this.localStream = await navigator.mediaDevices.getUserMedia(simpleConstraints);

            } catch (error2) {
                console.warn('Failed with video, trying audio only...', error2);

                try {
                    const audioOnlyConstraints = {
                        audio: true,
                        video: false
                    };
                    this.localStream = await navigator.mediaDevices.getUserMedia(audioOnlyConstraints);
                    console.log('Audio only mode enabled');

                } catch (error3) {
                    console.error('Unable to access media:', error3);

                    let errorMessage = 'Unable to access media. ';

                    switch (error3.name) {
                        case 'NotAllowedError':
                            errorMessage += 'Please allow access to camera and microphone.';
                            break;
                        case 'NotFoundError':
                            errorMessage += 'No camera or microphone found.';
                            break;
                        case 'NotReadableError':
                            errorMessage += 'Camera/microphone already in use by another application.';
                            break;
                        case 'OverconstrainedError':
                            errorMessage += 'Constraints not supported by your devices.';
                            break;
                        default:
                            errorMessage += 'Technical error: ' + error3.message;
                    }

                    throw new Error(errorMessage);
                }
            }
        }

        const localVideo = document.getElementById('local-video');
        if (localVideo && this.localStream) {
            localVideo.srcObject = this.localStream;

            const hasVideo = this.localStream.getVideoTracks().length > 0;
            if (!hasVideo) {
                localVideo.style.display = 'none';
                console.log('Audio only mode - local video hidden');
            }
        }

        console.log('Local media obtained successfully');
        console.log('Audio tracks:', this.localStream.getAudioTracks().length);
        console.log('Video tracks:', this.localStream.getVideoTracks().length);

        return this.localStream;
    }

    async createPeerConnection() {
        this.peerConnection = new RTCPeerConnection(this.pcConfig);

        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                this.peerConnection.addTrack(track, this.localStream);
            });
        }

        this.peerConnection.ontrack = (event) => {
            console.log('Remote track received:', event.track.kind);
            this.remoteStream = event.streams[0];

            const remoteVideo = document.getElementById('remote-video');
            if (remoteVideo) {
                remoteVideo.srcObject = this.remoteStream;
            }
        };

        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('Sending ICE candidate');
                this.socket.emit('webrtc-ice-candidate', {
                    targetId: this.currentPeerId,
                    candidate: event.candidate
                });
            }
        };

        this.peerConnection.onconnectionstatechange = () => {
            console.log('WebRTC connection state:', this.peerConnection.connectionState);

            if (this.peerConnection.connectionState === 'connected') {
                this.onCallConnected();
            } else if (this.peerConnection.connectionState === 'disconnected' ||
                this.peerConnection.connectionState === 'failed') {
                this.endCall();
            }
        };

        this.peerConnection.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', this.peerConnection.iceConnectionState);
        };
    }

    async createAndSendOffer() {
        try {
            const offer = await this.peerConnection.createOffer();
            await this.peerConnection.setLocalDescription(offer);

            console.log('Sending WebRTC offer to:', this.currentPeerId);
            this.socket.emit('webrtc-offer', {
                targetId: this.currentPeerId,
                offer: offer
            });
        } catch (error) {
            console.error('Error creating offer:', error);
            throw error;
        }
    }

    async handleOffer(senderId, offer) {
        try {
            this.currentPeerId = senderId;
            this.isInitiator = false;

            if (!this.localStream) {
                await this.getLocalMedia();
            }

            if (!this.peerConnection) {
                await this.createPeerConnection();
            }

            await this.peerConnection.setRemoteDescription(offer);

            const answer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(answer);

            console.log('Sending WebRTC answer');
            this.socket.emit('webrtc-answer', {
                targetId: senderId,
                answer: answer
            });
        } catch (error) {
            console.error('Error handling offer:', error);
            throw error;
        }
    }

    async handleAnswer(answer) {
        try {
            await this.peerConnection.setRemoteDescription(answer);
            console.log('WebRTC answer processed successfully');
        } catch (error) {
            console.error('Error handling answer:', error);
            throw error;
        }
    }

    async handleIceCandidate(candidate) {
        try {
            if (this.peerConnection && this.peerConnection.remoteDescription) {
                await this.peerConnection.addIceCandidate(candidate);
            }
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
        }
    }

    onCallConnected() {
        console.log('WebRTC call connected successfully');
        window.dispatchEvent(new CustomEvent('webrtc-connected'));
    }

    toggleAudio() {
        if (this.localStream) {
            const audioTrack = this.localStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !audioTrack.enabled;
                return audioTrack.enabled;
            }
        }
        return false;
    }

    toggleVideo() {
        if (this.localStream) {
            const videoTrack = this.localStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = !videoTrack.enabled;
                return videoTrack.enabled;
            }
        }
        return false;
    }

    async shareScreen() {
        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true
            });

            const videoTrack = screenStream.getVideoTracks()[0];
            const sender = this.peerConnection.getSenders().find(s =>
                s.track && s.track.kind === 'video'
            );

            if (sender) {
                await sender.replaceTrack(videoTrack);
            }

            videoTrack.onended = async () => {
                await this.stopScreenShare();
            };

            return true;
        } catch (error) {
            console.error('Error sharing screen:', error);
            return false;
        }
    }

    async stopScreenShare() {
        try {
            const newStream = await navigator.mediaDevices.getUserMedia(this.mediaConstraints);
            const videoTrack = newStream.getVideoTracks()[0];

            const sender = this.peerConnection.getSenders().find(s =>
                s.track && s.track.kind === 'video'
            );

            if (sender) {
                await sender.replaceTrack(videoTrack);
            }

            const oldVideoTrack = this.localStream.getVideoTracks()[0];
            if (oldVideoTrack) {
                oldVideoTrack.stop();
                this.localStream.removeTrack(oldVideoTrack);
                this.localStream.addTrack(videoTrack);
            }

            const localVideo = document.getElementById('local-video');
            if (localVideo) {
                localVideo.srcObject = this.localStream;
            }
        } catch (error) {
            console.error('Error stopping screen share:', error);
        }
    }

    async endCall() {
        console.log('Ending WebRTC call');

        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }

        this.remoteStream = null;
        this.currentPeerId = null;
        this.isInitiator = false;

        const localVideo = document.getElementById('local-video');
        const remoteVideo = document.getElementById('remote-video');

        if (localVideo) localVideo.srcObject = null;
        if (remoteVideo) remoteVideo.srcObject = null;

        window.dispatchEvent(new CustomEvent('webrtc-ended'));
    }

}

window.WebRTCHandler = WebRTCHandler;