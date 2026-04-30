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
    let configSectionEl, roomConfigInfoEl, roomConfigDetailsEl;
    let configSampleRateEl, configBitrateEl, configFrameDurationEl, configJitterEl;

    // =============================================
    // 房间状态管理
    // =============================================
    function updateRoomStatus() {
        if (!roomStatusEl) return;
        const peerCount = roomPeers.size + (isJoined ? 1 : 0);

        if (!isJoined) {
            roomStatusEl.innerHTML = '<span class="room-status waiting">☎️ 未加入通话...</span>';
        } else if (peerCount === 1) {
            roomStatusEl.innerHTML = '<span class="room-status waiting">⏳ 等待对方加入...</span>';
        } else if (peerCount === 2) {
            roomStatusEl.innerHTML = '<span class="room-status active">🟢 1v1通话中...</span>';
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

                // 应用服务端下发的编解码配置
                if (msg.codecConfig) {
                    applyRoomConfig(msg.codecConfig);
                }

                // 如果房间已有其他成员，说明配置已由先加入者决定，隐藏配置面板
                if (msg.peers && msg.peers.length > 0 && configSectionEl) {
                    configSectionEl.style.display = 'none';
                }

                if (msg.peers && msg.peers.length > 0) {
                    msg.peers.forEach(pid => addPeer(pid));
                }
                updateRoomStatus();
                updatePeerInfoSection();
                updateDebugInfo();
                break;

            case 'peer_joined':
                addPeer(msg.peerId);
                updateDebugInfo();
                break;

            case 'peer_left':
                removePeer(msg.peerId);
                stats.lastSeqReceived.delete(msg.peerId);
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
        updateRoomStatus();
        console.log(`[PEER] ${peerId} joined`);
    }

    function removePeer(peerId) {
        roomPeers.delete(peerId);
        removePeerFromList(peerId);
        updatePeerInfoSection();
        updateRoomStatus();
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

            // 读取用户选择的编解码配置，发送给服务端
            const userCodecConfig = getSelectedConfig();
            ws.send(JSON.stringify({
                type: 'join',
                roomId: CONFIG.roomId,
                peerId: null,
                codecConfig: userCodecConfig
            }));

            document.getElementById('joinBtn').disabled = true;
            document.getElementById('joinBtn').textContent = '✅ 已加入';
            document.getElementById('leaveBtn').disabled = false;

            // 锁定配置面板（通话中不可修改）
            enableConfigUI(false);

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
        const peersListEl2 = document.getElementById('peersList');
        if (peersListEl2) {
            peersListEl2.innerHTML = '<span style="color:#666; font-size:13px;">暂无其他成员</span>';
        }

        // 隐藏房间配置信息
        if (roomConfigInfoEl) roomConfigInfoEl.style.display = 'none';
        // 恢复配置面板显示（下次加入时可重新选择）
        if (configSectionEl) configSectionEl.style.display = 'block';
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

        // 清理后统一更新 UI 状态
        roomPeers.clear();
        updateRoomStatus();
        updatePeerInfoSection();

        // 恢复配置面板可编辑状态
        enableConfigUI(true);
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
            <span>📊 编码: Opus ${CONFIG.opusBitrate/1000}kbps | ${CONFIG.frameDuration * 1000}ms/帧 | ${CONFIG.sampleRate/1000}kHz</span>
        `;
    }

    // =============================================
    // 编解码配置预设
    // =============================================
    const PRESETS = {
        'low-latency': { sampleRate: 48000, bitrate: 64000, frameDuration: 0.02, jitter: 2 },
        'balanced':    { sampleRate: 48000, bitrate: 32000, frameDuration: 0.04, jitter: 4 },
        'high-quality':{ sampleRate: 48000, bitrate: 64000, frameDuration: 0.04, jitter: 2 },
        'weak-network':{ sampleRate: 16000, bitrate: 16000, frameDuration: 0.06, jitter: 8 }
    };

    function applyPreset(name) {
        const preset = PRESETS[name];
        if (!preset) return;

        configSampleRateEl.value = preset.sampleRate;
        configBitrateEl.value = preset.bitrate;
        configFrameDurationEl.value = preset.frameDuration;
        configJitterEl.value = preset.jitter;

        // 高亮当前预设按钮
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        document.querySelector(`.preset-btn[data-preset="${name}"]`)?.classList.add('active');

        console.log('[Config] Applied preset:', name, preset);
    }

    // =============================================
    // 获取当前UI配置
    // =============================================
    function getSelectedConfig() {
        return {
            sampleRate: parseInt(configSampleRateEl.value),
            opusBitrate: parseInt(configBitrateEl.value),
            frameDuration: parseFloat(configFrameDurationEl.value),
            jitterBufferFrames: parseInt(configJitterEl.value)
        };
    }

    // =============================================
    // 应用服务端下发的房间配置
    // =============================================
    function applyRoomConfig(codecConfig) {
        if (!codecConfig) return;

        // 更新 CONFIG
        if (codecConfig.sampleRate) CONFIG.sampleRate = codecConfig.sampleRate;
        if (codecConfig.opusBitrate) CONFIG.opusBitrate = codecConfig.opusBitrate;
        if (codecConfig.frameDuration) CONFIG.frameDuration = codecConfig.frameDuration;
        if (codecConfig.jitterBufferFrames) CONFIG.jitterBufferFrames = codecConfig.jitterBufferFrames;

        // 显示房间配置信息
        if (roomConfigInfoEl && roomConfigDetailsEl) {
            roomConfigInfoEl.style.display = 'block';
            roomConfigDetailsEl.innerHTML = `
                <div class="room-config-detail">
                    <span class="label">采样率</span>
                    <span class="value">${codecConfig.sampleRate / 1000} kHz</span>
                </div>
                <div class="room-config-detail">
                    <span class="label">比特率</span>
                    <span class="value">${codecConfig.opusBitrate / 1000} kbps</span>
                </div>
                <div class="room-config-detail">
                    <span class="label">帧长</span>
                    <span class="value">${(codecConfig.frameDuration * 1000).toFixed(0)} ms</span>
                </div>
                <div class="room-config-detail">
                    <span class="label">抖动缓冲</span>
                    <span class="value">${codecConfig.jitterBufferFrames} 帧 (${(codecConfig.jitterBufferFrames * codecConfig.frameDuration * 1000).toFixed(0)}ms)</span>
                </div>
            `;
        }

        console.log('[Config] Applied room config:', codecConfig);
    }

    // =============================================
    // 配置面板启用/禁用
    // =============================================
    function enableConfigUI(enabled) {
        const selects = [configSampleRateEl, configBitrateEl, configFrameDurationEl, configJitterEl];
        selects.forEach(el => { if (el) el.disabled = !enabled; });
        document.querySelectorAll('.preset-btn').forEach(b => { b.disabled = !enabled; });
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
        configSectionEl = document.getElementById('configSection');
        roomConfigInfoEl = document.getElementById('roomConfigInfo');
        roomConfigDetailsEl = document.getElementById('roomConfigDetails');
        configSampleRateEl = document.getElementById('configSampleRate');
        configBitrateEl = document.getElementById('configBitrate');
        configFrameDurationEl = document.getElementById('configFrameDuration');
        configJitterEl = document.getElementById('configJitter');

        document.getElementById('joinBtn').onclick = joinRoom;
        document.getElementById('leaveBtn').onclick = leaveRoom;

        // 预设模式按钮
        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
        });

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
