// =============================================
// WebSocket + WebCodecs 语音客户端
// 浏览器原生编解码 · 零依赖 · 超低延迟
// =============================================

const VOICE_APP = (() => {
    'use strict';

    // =============================================
    // 配置
    // =============================================
    // 从 URL 路径获取房间 ID（由服务端注入到 window.__ROOM_ID__）
    const ROOM_ID = window.__ROOM_ID__ || 'default';
    const CONFIG = {
        serverUrl: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`,
        roomId: ROOM_ID,
        sampleRate: 48000,       // 48kHz 足够语音
        frameDuration: 0.04,     // 40ms 帧长
        opusBitrate: 32000,      // 32kbps 语音最优
        jitterBufferFrames: 4    // 4 帧抖动缓冲 (~160ms)
    };

    // =============================================
    // 状态
    // =============================================
    let ws = null;
    let audioCtx = null;
    let workletNode = null;
    let mediaStream = null;
    let micSource = null;

    let encoder = null;
    let decoder = null;

    let myPeerId = null;
    let roomPeers = new Map();
    let seqCounter = 0;

    let gainNode = null;

    // 丢包统计
    let stats = {
        packetsSent: 0,
        packetsRecv: 0,
        packetsLost: 0,
        bytesSent: 0,
        bytesRecv: 0,
        lastSeqReceived: new Map()
    };

    let isInitializing = false;
    let isJoined = false;

    // UI 元素
    let statusEl, peersListEl, debugInfoEl, myPeerIdEl, roomStatusEl, peerPeerIdEl, peerInfoSectionEl, roomIdDisplayEl;

    // =============================================
    // 房间状态管理
    // =============================================
    function updateRoomStatus() {
        if (!roomStatusEl) return;
        const peerCount = roomPeers.size + (isJoined ? 1 : 0);

        if (!isJoined) {
            roomStatusEl.innerHTML = '<span class="room-status waiting">⏳ 等待加入...</span>';
        } else if (peerCount === 1) {
            roomStatusEl.innerHTML = '<span class="room-status waiting">⏳ 等待对方加入...</span>';
        } else if (peerCount === 2) {
            roomStatusEl.innerHTML = '<span class="room-status active">🟢 通话中 (1v1)</span>';
        }
    }

    // =============================================
    // WebSocket 连接
    // =============================================
    function connectWebSocket() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            ws = new WebSocket(CONFIG.serverUrl);
            ws.binaryType = 'arraybuffer';

            ws.onopen = () => {
                console.log('[WS] Connected');
                setStatus('🟢 已连接', '#4caf50');
                resolve();
            };

            ws.onerror = (err) => {
                console.error('[WS] Error:', err);
                if (!isJoined) reject(new Error('WebSocket connection failed'));
            };

            ws.onclose = () => {
                console.log('[WS] Disconnected');
                if (isJoined) {
                    setStatus('🔴 连接断开，3秒后重连...', '#d16969');
                    setTimeout(() => reconnect(), 3000);
                } else {
                    setStatus('🔴 断开连接', '#d16969');
                }
            };

            ws.onmessage = handleMessage;
        });
    }

    // =============================================
    // 消息处理
    // =============================================
    function handleMessage(event) {
        if (event.data instanceof ArrayBuffer) {
            handleAudioPacket(new Uint8Array(event.data));
            return;
        }

        try {
            const msg = JSON.parse(event.data);
            handleSignal(msg);
        } catch (e) {
            console.warn('[WS] Invalid message:', e);
        }
    }

    function handleSignal(msg) {
        switch (msg.type) {
            case 'joined':
                myPeerId = msg.peerId;
                myPeerIdEl.textContent = myPeerId;
                isJoined = true;
                setStatus(`🎙️ 已加入1v1通话房间 (${msg.roomId})`, '#4caf50');
                if (msg.peers && msg.peers.length > 0) {
                    msg.peers.forEach(pid => addPeer(pid));
                }
                updateRoomStatus();
                updatePeerInfoSection();
                updateDebugInfo();
                break;

            case 'peer_joined':
                addPeer(msg.peerId);
                updateRoomStatus();
                updateDebugInfo();
                break;

            case 'peer_left':
                removePeer(msg.peerId);
                stats.lastSeqReceived.delete(msg.peerId);
                updateRoomStatus();
                updateDebugInfo();
                break;

            case 'pong':
                break;

            case 'error':
                console.error('[Server]', msg.message);
                setStatus(`⚠️ ${msg.message}`, '#ffa500');
                // 如果是房间已满错误，恢复按钮状态
                if (msg.message.includes('1v1通话房间已满')) {
                    document.getElementById('joinBtn').disabled = false;
                    document.getElementById('joinBtn').textContent = '📞 加入通话';
                    document.getElementById('leaveBtn').disabled = true;
                    cleanup();
                }
                break;
        }
    }

    // =============================================
    // 发送音频帧到服务器
    // =============================================
    function sendAudioPacket(opusData) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (!opusData || opusData.length === 0) return; // 不发送空包

        // 构建二进制包: [采样率2B][序号2B][时间戳4B][Opus数据]
        const headerSize = 8;
        const packet = new ArrayBuffer(headerSize + opusData.length);
        const view = new DataView(packet);
        const seq = seqCounter++;

        view.setUint16(0, CONFIG.sampleRate, true);
        view.setUint16(2, seq, true);
        view.setUint32(4, Date.now(), true);

        const opusBytes = new Uint8Array(packet, headerSize, opusData.length);
        opusBytes.set(opusData);

        ws.send(packet);
        stats.packetsSent++;
        stats.bytesSent += packet.byteLength;
    }

    // =============================================
    // Peer 管理
    // =============================================
    function addPeer(peerId) {
        if (peerId === myPeerId) return;
        if (roomPeers.has(peerId)) return;
        roomPeers.set(peerId, { firstSeq: -1, lastPacketTime: 0 });
        addPeerToList(peerId);
        updatePeerInfoSection();
        console.log(`[PEER] ${peerId} joined`);
    }

    function removePeer(peerId) {
        roomPeers.delete(peerId);
        removePeerFromList(peerId);
        updatePeerInfoSection();
        console.log(`[PEER] ${peerId} left`);
    }

    // =============================================
    // 通话对方信息显示
    // =============================================
    function updatePeerInfoSection() {
        if (!peerInfoSectionEl || !peerPeerIdEl) return;
        // 通话中：显示对方ID（排除自己后，取第一个peer）
        const peers = Array.from(roomPeers.keys()).filter(pid => pid !== myPeerId);
        if (peers.length > 0 && isJoined) {
            peerInfoSectionEl.style.display = 'flex';
            peerPeerIdEl.textContent = peers[0];
        } else {
            peerInfoSectionEl.style.display = 'none';
            peerPeerIdEl.textContent = '—';
        }
    }

    // =============================================
    // 音频初始化
    // =============================================
    async function initAudio() {
        if (audioCtx) return;

        audioCtx = new AudioContext({
            sampleRate: CONFIG.sampleRate,
            latencyHint: 'interactive'
        });

        // 加载 AudioWorklet
        await audioCtx.audioWorklet.addModule('/audio-worklet.js');

        // 创建 Worklet 节点
        workletNode = new AudioWorkletNode(audioCtx, 'voice-worklet');

        // 监听 Worklet 消息
        workletNode.port.onmessage = async (event) => {
            const data = event.data;

            if (data.type === 'pcm') {
                // 收到麦克风 PCM → 编码 → 发送
                if (!encoder || encoder.state !== 'configured') return;

                const audioData = new AudioData({
                    format: 'f32-planar',
                    sampleRate: CONFIG.sampleRate,
                    numberOfFrames: data.data.length,
                    numberOfChannels: 1,
                    timestamp: performance.now() * 1000,
                    data: data.data
                });

                encoder.encode(audioData);
                audioData.close();
            }

            if (data.type === 'underrun') {
                console.warn('[Playback] Buffer underrun');
            }
        };

        // 增益控制
        gainNode = audioCtx.createGain();
        gainNode.gain.value = 1.0;

        // 连接: Worklet → Gain → 扬声器
        workletNode.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        console.log(`[Audio] Initialized: ${CONFIG.sampleRate}Hz`);
    }

    // =============================================
    // 麦克风启动
    // =============================================
    async function startMicrophone() {
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 1,
                    sampleRate: { ideal: CONFIG.sampleRate }
                }
            });

            micSource = audioCtx.createMediaStreamSource(mediaStream);
            micSource.connect(workletNode);

            console.log('[Mic] Started');
            return true;
        } catch (err) {
            console.error('[Mic] Error:', err);
            setStatus('⚠️ 麦克风权限被拒绝', '#ffa500');
            throw err;
        }
    }

    // =============================================
    // WebCodecs 编解码器初始化
    // =============================================
    async function initCodec() {
        if (!window.AudioEncoder || !window.AudioDecoder) {
            throw new Error('浏览器不支持 WebCodecs API');
        }

        // 检查 Opus 编码支持
        const encSupported = await AudioEncoder.isConfigSupported({
            codec: 'opus',
            sampleRate: CONFIG.sampleRate,
            numberOfChannels: 1
        });
        if (!encSupported.supported) {
            throw new Error('浏览器不支持 Opus 编码');
        }
        console.log('[Codec] Opus encoding supported');

        // 检查 Opus 解码支持
        const decSupported = await AudioDecoder.isConfigSupported({
            codec: 'opus',
            sampleRate: CONFIG.sampleRate,
            numberOfChannels: 1
        });
        if (!decSupported.supported) {
            throw new Error('浏览器不支持 Opus 解码');
        }
        console.log('[Codec] Opus decoding supported');

        // ---- 编码器 ----
        encoder = new AudioEncoder({
            output: (chunk) => {
                // 编码完成 → 直接发送
                const opusData = new Uint8Array(chunk.byteLength);
                chunk.copyTo(opusData);
                console.log(`[Send] seq=${seqCounter}, opusLen=${opusData.length}, ts=${Date.now()}`);
                sendAudioPacket(opusData);
            },
            error: (e) => {
                console.error('[Encoder] Error:', e.message);
            }
        });

        encoder.configure({
            codec: 'opus',
            sampleRate: CONFIG.sampleRate,
            numberOfChannels: 1,
            bitrate: CONFIG.opusBitrate
        });

        console.log(`[Encoder] state=${encoder.state}`);

        // ---- 解码器 ----
        decoder = new AudioDecoder({
            output: (audioData) => {
                // 解码完成 → 发送 PCM 到 Worklet 播放
                if (workletNode) {
                    const pcmData = new Float32Array(audioData.numberOfFrames);
                    audioData.copyTo(pcmData, { planeIndex: 0 });
                    console.log(`[Decode] frames=${audioData.numberOfFrames}, sampleRate=${audioData.sampleRate}`);
                    workletNode.port.postMessage({
                        type: 'pcm',
                        data: pcmData
                    });
                }
                audioData.close();
            },
            error: (e) => {
                console.error('[Decoder] Error:', e.message);
            }
        });

        decoder.configure({
            codec: 'opus',
            sampleRate: CONFIG.sampleRate,
            numberOfChannels: 1
        });

        console.log(`[Decoder] state=${decoder.state}`);
        console.log('[Codec] WebCodecs Encoder + Decoder ready');
    }

    // =============================================
    // 加入房间
    // =============================================
    async function joinRoom() {
        if (isInitializing) return;
        isInitializing = true;

        try {
            setStatus('🔄 初始化 WebCodecs 编解码器...', '#888');
            await initCodec();

            setStatus('🔄 初始化音频系统...', '#888');
            await initAudio();

            setStatus('🔄 启动麦克风...', '#888');
            await startMicrophone();

            setStatus('🔄 连接信令服务器...', '#888');
            await connectWebSocket();

            setStatus('🔄 加入1v1通话房间...', '#888');
            ws.send(JSON.stringify({
                type: 'join',
                roomId: CONFIG.roomId,
                peerId: null
            }));

            document.getElementById('joinBtn').disabled = true;
            document.getElementById('joinBtn').textContent = '✅ 已加入';
            document.getElementById('leaveBtn').disabled = false;

            startStatsUpdater();

        } catch (err) {
            console.error('[Join] Error:', err);
            setStatus(`❌ 加入失败: ${err.message}`, '#d16969');
            cleanup();
        } finally {
            isInitializing = false;
        }
    }

    // =============================================
    // 离开房间
    // =============================================
    function leaveRoom() {
        if (ws && isJoined) {
            ws.send(JSON.stringify({ type: 'leave' }));
        }
        cleanup();
        setStatus('⚡ 当前状态：未加入1v1通话房间', '#d4d4d4');
        document.getElementById('joinBtn').disabled = false;
        document.getElementById('joinBtn').textContent = '📞 加入通话';
        document.getElementById('leaveBtn').disabled = true;
        roomPeers.clear();
        document.getElementById('peersList').innerHTML = '<span style="color:#666; font-size:13px;">暂无其他成员</span>';
        updatePeerInfoSection();
        updateRoomStatus();
    }

    // =============================================
    // 断线重连
    // =============================================
    async function reconnect() {
        if (isInitializing) return;
        try {
            isJoined = false;
            ws = null;
            await connectWebSocket();
            ws.send(JSON.stringify({
                type: 'join',
                roomId: CONFIG.roomId,
                peerId: myPeerId
            }));
            setStatus('🟢 已重连', '#4caf50');
        } catch (err) {
            console.error('[Reconnect] Failed:', err);
            setStatus('🔴 重连失败', '#d16969');
            setTimeout(() => reconnect(), 5000);
        }
    }

    // =============================================
    // 清理
    // =============================================
    function cleanup() {
        isJoined = false;

        if (encoder) {
            if (encoder.state !== 'closed') encoder.close();
            encoder = null;
        }
        if (decoder) {
            if (decoder.state !== 'closed') decoder.close();
            decoder = null;
        }
        if (workletNode) {
            workletNode.port.postMessage({ type: 'reset' });
            workletNode.disconnect();
            workletNode = null;
        }
        if (gainNode) {
            gainNode.disconnect();
            gainNode = null;
        }
        if (micSource) {
            micSource.disconnect();
            micSource = null;
        }
        if (mediaStream) {
            mediaStream.getTracks().forEach(t => t.stop());
            mediaStream = null;
        }
        if (audioCtx) {
            audioCtx.close().catch(() => {});
            audioCtx = null;
        }
        if (ws) {
            ws.onclose = null;
            ws.close();
            ws = null;
        }

        stats = {
            packetsSent: 0, packetsRecv: 0, packetsLost: 0,
            bytesSent: 0, bytesRecv: 0,
            lastSeqReceived: new Map()
        };
    }

    // =============================================
    // Opus 音频包处理
    // =============================================
    function handleAudioPacket(data) {
        if (!decoder || decoder.state !== 'configured') return;

        // 二进制包格式: [采样率2B][序号2B][时间戳4B][Opus数据]
        if (data.length <= 8) return; // 没有音频数据

        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const sampleRate = view.getUint16(0, true);
        const packetSeq = view.getUint16(2, true);
        const timestamp = view.getUint32(4, true);
        const opusData = data.subarray(8);

        stats.packetsRecv++;
        stats.bytesRecv += data.length;

        console.log(`[Recv] seq=${packetSeq}, opusLen=${opusData.length}, ts=${timestamp}`);

        // 创建 EncodedAudioChunk 解码
        const chunk = new EncodedAudioChunk({
            type: 'key',
            timestamp: timestamp * 1000,
            duration: CONFIG.frameDuration * 1_000_000,
            data: opusData
        });

        decoder.decode(chunk);
    }

    // =============================================
    // UI 辅助函数
    // =============================================
    function setStatus(text, color) {
        if (statusEl) {
            statusEl.textContent = text;
            statusEl.style.color = color;
        }
    }

    function addPeerToList(peerId) {
        if (!peersListEl) return;
        const emptyMsg = peersListEl.querySelector('span[style*="color:#666"]');
        if (emptyMsg) emptyMsg.remove();

        const peerDiv = document.createElement('div');
        peerDiv.id = `peer-${peerId}`;
        peerDiv.className = 'peer-item';
        peerDiv.innerHTML = `
            <span class="peer-id">👤 ${peerId}</span>
            <span class="peer-status">🟢 在线</span>
        `;
        peersListEl.appendChild(peerDiv);
    }

    function removePeerFromList(peerId) {
        if (!peersListEl) return;
        const peerDiv = document.getElementById(`peer-${peerId}`);
        if (peerDiv) peerDiv.remove();
        if (peersListEl.children.length === 0) {
            peersListEl.innerHTML = '<span style="color:#666; font-size:13px;">暂无其他成员</span>';
        }
    }

    function startStatsUpdater() {
        setInterval(() => {
            if (isJoined) updateDebugInfo();
        }, 1000);
    }

    function updateDebugInfo() {
        const panel = document.getElementById('debugPanel');
        const info = document.getElementById('debugInfo');
        if (!panel || !info) return;

        panel.style.display = 'block';

        const bitrateSend = stats.packetsSent > 0
            ? ((stats.bytesSent * 8) / (stats.packetsSent * CONFIG.frameDuration) / 1000).toFixed(1)
            : '0';

        info.innerHTML = `
            <span>🆔 ID: ${myPeerId || '—'}</span><br>
            <span>👥 房间: ${roomPeers.size + (myPeerId ? 1 : 0)} 人</span><br>
            <span>📤 发送: ${stats.packetsSent} 包 | ${bitrateSend}kbps</span><br>
            <span>📥 接收: ${stats.packetsRecv} 包</span><br>
            <span>📊 编码: Opus 32kbps | ${CONFIG.frameDuration * 1000}ms/帧</span>
        `;
    }

    // =============================================
    // 初始化
    // =============================================
    function init() {
        statusEl = document.getElementById('status');
        peersListEl = document.getElementById('peersList');
        myPeerIdEl = document.getElementById('myPeerId');
        roomStatusEl = document.getElementById('roomStatus');
        peerPeerIdEl = document.getElementById('peerPeerId');
        peerInfoSectionEl = document.getElementById('peerInfoSection');
        roomIdDisplayEl = document.getElementById('roomIdDisplay');

        document.getElementById('joinBtn').onclick = joinRoom;
        document.getElementById('leaveBtn').onclick = leaveRoom;

        // 显示当前房间ID
        if (roomIdDisplayEl) {
            roomIdDisplayEl.textContent = CONFIG.roomId;
        }

        updateRoomStatus();

        console.log(`[VoiceApp] Ready - Room: ${CONFIG.roomId}, WebSocket + WebCodecs`);
        setStatus('⚡ 点击下方按钮加入语音通话', '#d4d4d4');
    }

    return { init, joinRoom, leaveRoom };
})();

window.onload = () => VOICE_APP.init();
