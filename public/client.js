// =============================================
// WebSocket + Opus(WASM) 语音客户端
// 极致轻量 · 最低延迟 · 资源受限环境最优解
// =============================================

const VOICE_APP = (() => {
    'use strict';

    // =============================================
    // 配置
    // =============================================
    const CONFIG = {
        serverUrl: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`,
        roomId: 'default',
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
    let roomPeers = new Map();  // peerId -> { firstSeq, lastPacketTime }
    let seqCounter = 0;

    // 解码后音频输出缓冲
    let outputDestination = null;
    let gainNode = null;

    // 丢包统计
    let stats = {
        packetsSent: 0,
        packetsRecv: 0,
        packetsLost: 0,
        bytesSent: 0,
        bytesRecv: 0,
        lastSeqReceived: new Map()  // peerId -> lastSeq
    };

    // 正在初始化的标志
    let isInitializing = false;
    let isJoined = false;

    // UI 元素
    let statusEl, peersListEl, debugInfoEl, myPeerIdEl;

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
        // 二进制数据 = Opus 编码的音频帧
        if (event.data instanceof ArrayBuffer) {
            handleAudioPacket(new Uint8Array(event.data));
            return;
        }

        // JSON 信令
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

                setStatus(`🎙️ 已加入会议室 (${msg.roomId})`, '#4caf50');

                // 添加已有 peer
                if (msg.peers && msg.peers.length > 0) {
                    msg.peers.forEach(pid => addPeer(pid));
                }

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
                // 可选的 RTT 测量
                break;

            case 'error':
                console.error('[Server]', msg.message);
                setStatus(`⚠️ ${msg.message}`, '#ffa500');
                break;
        }
    }

    // =============================================
    // Opus 音频包处理
    // =============================================
    function handleAudioPacket(data) {
        if (!decoder) return;

        // 二进制包格式：
        // [0-1] 采样率 (Uint16)
        // [2-3] 帧序号 (Uint16)
        // [4-7] 时间戳 (Uint32, ms)
        // [8..] Opus 编码数据

        if (data.length < 8) return;

        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const sampleRate = view.getUint16(0, true);
        const packetSeq = view.getUint16(2, true);
        const timestamp = view.getUint32(4, true);
        const opusData = data.slice(8);

        stats.packetsRecv++;

        // ---- 丢包检测（基于全局序号） ----
        // 由于所有 peer 共享同一个序号空间，我们只做简单的乱序处理
        // 实际的丢包隐藏由解码器的 PLC 处理

        // 解码 Opus → PCM
        const frameSize = Math.floor(CONFIG.sampleRate * CONFIG.frameDuration);
        const pcm = decoder.decode(opusData, frameSize);

        if (pcm && workletNode) {
            workletNode.port.postMessage({
                type: 'pcm',
                data: pcm
            });
        }
    }

    // =============================================
    // 发送音频帧到服务器
    // =============================================
    function sendAudioPacket(opusData) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        // 构建二进制包
        const headerSize = 8;
        const packet = new ArrayBuffer(headerSize + opusData.length);
        const view = new DataView(packet);
        const seq = seqCounter++;

        view.setUint16(0, CONFIG.sampleRate, true);
        view.setUint16(2, seq, true);
        view.setUint32(4, Date.now(), true);

        if (opusData.length > 0) {
            const opusBytes = new Uint8Array(packet, headerSize, opusData.length);
            opusBytes.set(opusData);
        }

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

        roomPeers.set(peerId, {
            firstSeq: -1,
            lastPacketTime: 0
        });

        addPeerToList(peerId);
        console.log(`[PEER] ${peerId} joined`);
    }

    function removePeer(peerId) {
        roomPeers.delete(peerId);
        removePeerFromList(peerId);
        console.log(`[PEER] ${peerId} left`);
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

        // 监听 Worklet 消息（编码前的 PCM）
        workletNode.port.onmessage = async (event) => {
            const data = event.data;

            if (data.type === 'pcm') {
                // 收到麦克风捕获的 PCM 帧 → 编码 → 发送
                if (!encoder) return;

                const opusData = encoder.encode(data.data);
                if (opusData) {
                    sendAudioPacket(opusData);
                }
                // 静音帧跳过不发送（节省带宽）
            }

            if (data.type === 'underrun') {
                // 播放端欠载 - 解码器需要补帧
                if (decoder) {
                    const frameSize = Math.floor(CONFIG.sampleRate * CONFIG.frameDuration);
                    const plcPcm = decoder.decodePLC(frameSize);
                    if (workletNode) {
                        workletNode.port.postMessage({
                            type: 'pcm',
                            data: plcPcm
                        });
                    }
                }
            }
        };

        // 创建输出目标
        outputDestination = audioCtx.createMediaStreamDestination();
        gainNode = audioCtx.createGain();
        gainNode.gain.value = 1.0;

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
    // Opus 编解码器初始化
    // =============================================
    async function initCodec() {
        // 编码器：48kHz 单声道，VOIP 模式，复杂度 3（低延迟优化）
        encoder = new OPUS_CODEC.OpusEncoder(
            CONFIG.sampleRate,
            1,
            OPUS_CODEC.APPLICATION_VOIP,
            3
        );
        await encoder.init();

        // 解码器
        decoder = new OPUS_CODEC.OpusDecoder(CONFIG.sampleRate, 1);
        await decoder.init();

        console.log('[Codec] Encoder + Decoder ready');
    }

    // =============================================
    // 加入房间
    // =============================================
    async function joinRoom() {
        if (isInitializing) return;
        isInitializing = true;

        try {
            setStatus('🔄 加载 Opus WASM 编解码器...', '#888');

            // 1. 加载 Opus WASM
            await initCodec();

            setStatus('🔄 初始化音频系统...', '#888');

            // 2. 初始化音频上下文 + Worklet
            await initAudio();

            setStatus('🔄 启动麦克风...', '#888');

            // 3. 启动麦克风（必须先启动音频上下文）
            await startMicrophone();

            setStatus('🔄 连接信令服务器...', '#888');

            // 4. 连接 WebSocket
            await connectWebSocket();

            setStatus('🔄 加入会议室...', '#888');

            // 5. 发送加入请求
            ws.send(JSON.stringify({
                type: 'join',
                roomId: CONFIG.roomId,
                peerId: null // 服务器自动分配
            }));

            // 6. 更新 UI
            document.getElementById('joinBtn').disabled = true;
            document.getElementById('joinBtn').textContent = '✅ 已加入';

            // 定期更新状态
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

        setStatus('⚡ 已离开房间', '#d4d4d4');
        document.getElementById('joinBtn').disabled = false;
        document.getElementById('joinBtn').textContent = '📞 加入语音会议室';

        roomPeers.clear();
        document.getElementById('peersList').innerHTML = '<span style="color:#666; font-size:13px;">暂无其他成员</span>';
    }

    // =============================================
    // 断线重连
    // =============================================
    async function reconnect() {
        if (isInitializing) return;

        try {
            isJoined = false;

            // 重新连接 WebSocket
            ws = null;
            await connectWebSocket();

            // 重新加入房间
            ws.send(JSON.stringify({
                type: 'join',
                roomId: CONFIG.roomId,
                peerId: myPeerId // 尝试恢复原来的 ID
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
            encoder.destroy();
            encoder = null;
        }

        if (decoder) {
            decoder.destroy();
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
            ws.onclose = null; // 防止触发重连
            ws.close();
            ws = null;
        }

        stats = {
            packetsSent: 0,
            packetsRecv: 0,
            packetsLost: 0,
            bytesSent: 0,
            bytesRecv: 0,
            lastSeqReceived: new Map()
        };
    }

    // =============================================
    // UI 辅助函数
    // =============================================
    function setStatus(text, color) {
        if (statusEl) {
            statusEl.textContent = text;
            statusEl.style.color = color || '#d4d4d4';
        }
    }

    function addPeerToList(peerId) {
        const list = document.getElementById('peersList');
        // 清除 "暂无其他成员" 占位
        const placeholder = list.querySelector('span');
        if (placeholder && roomPeers.size === 0) {
            list.innerHTML = '';
        }

        const div = document.createElement('div');
        div.className = 'peer-item';
        div.id = `peer-${peerId}`;
        div.innerHTML = `🎤 ${peerId}`;
        list.appendChild(div);
    }

    function removePeerFromList(peerId) {
        const el = document.getElementById(`peer-${peerId}`);
        if (el) el.remove();
        // 如果没人了，显示占位
        if (document.getElementById('peersList').children.length === 0) {
            document.getElementById('peersList').innerHTML = '<span style="color:#666; font-size:13px;">暂无其他成员</span>';
        }
    }

    function startStatsUpdater() {
        setInterval(() => {
            updateDebugInfo();
        }, 2000);
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

        document.getElementById('joinBtn').onclick = joinRoom;
        document.getElementById('leaveBtn').onclick = leaveRoom;

        console.log('[VoiceApp] Ready - WebSocket + Opus WASM');
        setStatus('⚡ 点击下方按钮加入语音会议室', '#d4d4d4');
    }

    // =============================================
    // 公共 API（供 HTML 调用）
    // =============================================
    return { init, joinRoom, leaveRoom };
})();

// 页面加载后初始化
window.onload = () => VOICE_APP.init();
