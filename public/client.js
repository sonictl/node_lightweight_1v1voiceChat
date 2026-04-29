// 配置参数
const CONFIG = {
    sampleRate: 48000,          // 使用浏览器原生采样率（opus-recorder 内部会重采样）
    frameDuration: 20,          // 20ms 帧长（减小包大小）
    bitrate: 6000,              // 6kbps（降低比特率）
    jitterBufferSize: 6,        // 环形缓冲区大小（帧数）
    initialBufferMs: 100,       // 初始缓冲 100ms (5帧)
    maxBufferMs: 200,           // 最大缓冲 200ms
    plcEnabled: true            // 丢包补偿
};

// 全局变量
let ws = null;
let clientId = null;
let targetId = null;
let audioContext = null;
let mediaStream = null;
let encoder = null;              // Opus 编码器 (Recorder 实例)
let decoderWorker = null;        // Opus 解码器 (Web Worker)
let isCalling = false;
let sequenceNumber = 0;
let jitterBuffer = null;
let playbackInterval = null;
let decoderReady = false;

// 调试统计
let debugStats = {
    encoderStarted: false,
    decoderStarted: false,
    sentPackets: 0,
    receivedPackets: 0,
    playedFrames: 0,
    lostPackets: 0,
    lastSentTime: 0,
    lastRecvTime: 0,
    encoderCallbacks: 0,
    decoderCallbacks: 0
};
let debugInterval = null;

// Jitter Buffer (环形缓冲区)
class JitterBuffer {
    constructor(size) {
        this.size = size;
        this.buffer = new Array(size);
        this.expectedSeq = -1;
        this.ready = false;
        this.lastPopTime = Date.now();
        this.stats = { pushed: 0, popped: 0, lost: 0, late: 0 };
    }
    
    push(seq, data) {
        const index = seq % this.size;
        
        // 清除同位置的旧包
        if (this.buffer[index] && this.buffer[index].seq === seq) {
            return; // 重复包，丢弃
        }
        
        this.buffer[index] = { seq, data, timestamp: Date.now() };
        this.stats.pushed++;
        
        // 等待初始缓冲
        if (!this.ready && this.getFilledCount() >= Math.floor(CONFIG.initialBufferMs / CONFIG.frameDuration)) {
            this.ready = true;
            this.expectedSeq = this.getOldestSeq();
            console.log(`[Jitter] Buffer ready (${this.getFilledCount()} frames), starting playback`);
        }
    }
    
    pop() {
        if (!this.ready) return null;
        
        // 检查超时（如果缓冲区没准备好但等待太久，强制播放）
        if (Date.now() - this.lastPopTime > CONFIG.frameDuration * 5) {
            console.warn('[Jitter] Playback stuck, resetting buffer');
            this.ready = false;
            return null;
        }
        
        const packet = this.buffer[this.expectedSeq % this.size];
        if (packet && packet.seq === this.expectedSeq) {
            this.buffer[this.expectedSeq % this.size] = null;
            this.expectedSeq = (this.expectedSeq + 1) % 256;  // 序列号 0-255
            this.lastPopTime = Date.now();
            this.stats.popped++;
            return packet.data;
        }
        
        // 丢包：检查超时后跳过
        const nextSeq = (this.expectedSeq + 1) % 256;
        const nextPacket = this.buffer[nextSeq % this.size];
        if (nextPacket && Date.now() - nextPacket.timestamp > CONFIG.frameDuration * 2) {
            console.warn(`[Jitter] Packet loss at seq ${this.expectedSeq}, skipping to ${nextSeq}`);
            this.expectedSeq = nextSeq;
            this.lastPopTime = Date.now();
            this.stats.lost++;
            debugStats.lostPackets++;
            return null; // PLC handled by caller
        }
        
        return null;
    }
    
    getFilledCount() {
        return this.buffer.filter(p => p !== null).length;
    }
    
    getOldestSeq() {
        const valid = this.buffer.filter(p => p !== null);
        if (valid.length === 0) return 0;
        return Math.min(...valid.map(p => p.seq));
    }
    
    clear() {
        this.buffer.fill(null);
        this.ready = false;
        this.expectedSeq = -1;
        this.lastPopTime = Date.now();
    }
}

// 更新调试信息显示
function updateDebugInfo() {
    const panel = document.getElementById('debugPanel');
    const info = document.getElementById('debugInfo');
    
    if (!isCalling) {
        panel.style.display = 'none';
        return;
    }
    
    panel.style.display = 'block';
    
    const now = Date.now();
    const timeSinceLastSent = debugStats.lastSentTime ? now - debugStats.lastSentTime : 0;
    const timeSinceLastRecv = debugStats.lastRecvTime ? now - debugStats.lastRecvTime : 0;
    
    const jitterStats = jitterBuffer ? jitterBuffer.stats : { pushed: 0, popped: 0, lost: 0 };
    const bufferFilled = jitterBuffer ? jitterBuffer.getFilledCount() : 0;
    const bufferReady = jitterBuffer ? jitterBuffer.ready : false;
    
    info.innerHTML = `
<span style="color: ${debugStats.encoderStarted ? '#4caf50' : '#d16969'}">● 编码器:</span> ${debugStats.encoderStarted ? 'Running' : 'Stopped'} | 回调: ${debugStats.encoderCallbacks} | 发送: ${debugStats.sentPackets} 包 | 最后发送: ${timeSinceLastSent}ms 前
<span style="color: ${debugStats.decoderStarted ? '#4caf50' : '#d16969'}">● 解码器:</span> ${debugStats.decoderStarted ? 'Running' : 'Stopped'} | 回调: ${debugStats.decoderCallbacks} | 接收: ${debugStats.receivedPackets} 包 | 最后接收: ${timeSinceLastRecv}ms 前
<span style="color: ${bufferReady ? '#4caf50' : '#ffa500'}">● Jitter Buffer:</span> ${bufferReady ? 'Ready' : 'Buffering'} | 填充: ${bufferFilled}/${CONFIG.jitterBufferSize} | 推入: ${jitterStats.pushed} | 弹出: ${jitterStats.popped} | 丢失: ${jitterStats.lost}
<span style="color: #0e639c">● 播放:</span> 已播放: ${debugStats.playedFrames} 帧 | PCM队列: ${pcmQueue.length}
<span style="color: #888">● 序列号:</span> 当前: ${sequenceNumber} | 期望: ${jitterBuffer ? jitterBuffer.expectedSeq : -1}
    `.trim();
}

// 初始化 WebSocket
async function initWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);
    ws.binaryType = 'arraybuffer';
    
    ws.onopen = () => {
        console.log('[WS] Connected');
        // 注册客户端ID（4位数字，方便手动输入）
        clientId = localStorage.getItem('voice_client_id');
        if (!clientId) {
            clientId = String(Math.floor(Math.random() * 9000 + 1000));
            localStorage.setItem('voice_client_id', clientId);
        }
        ws.send(JSON.stringify({ type: 'register', clientId }));
    };
    
    ws.onmessage = async (event) => {
        if (typeof event.data === 'string') {
            // 文本信令
            const data = JSON.parse(event.data);
            handleSignaling(data);
        } else {
            // 二进制音频：送入 Jitter Buffer
            if (!isCalling || !decoderWorker) return;
            
            const buffer = event.data;
            if (buffer.byteLength < 5) return;  // 1(类型) + 1(序列号) + 2(目标ID) + 至少1字节负载
            
            const view = new DataView(buffer);
            const seq = view.getUint8(1);
            const packetTargetId = String(view.getUint16(2));
            
            // 只处理发送给自己的包
            if (packetTargetId !== clientId) return;
            
            // 提取 Ogg Opus 负载
            const oggData = buffer.slice(4);
            
            // 更新统计
            debugStats.receivedPackets++;
            debugStats.lastRecvTime = Date.now();
            
            // 送入 Jitter Buffer
            if (jitterBuffer) {
                jitterBuffer.push(seq, oggData);
            }
        }
    };
    
    ws.onerror = (err) => {
        console.error('[WS] Error:', err);
    };
    
    ws.onclose = () => {
        console.log('[WS] Closed, reconnecting in 3s...');
        // 如果通话中突然断线，清理状态
        if (isCalling) {
            hangup();
        }
        setTimeout(initWebSocket, 3000);
    };
}

// 信令处理
function handleSignaling(data) {
    switch (data.type) {
        case 'registered':
            console.log('[WS] Registered:', data.clientId);
            document.getElementById('clientId').textContent = data.clientId;
            break;
            
        case 'error':
            console.error('[WS] Error:', data.message);
            alert(data.message);
            break;
            
        case 'incoming_call':
            // 有人呼叫我们
            console.log('[Call] Incoming call from', data.callerId);
            if (isCalling) {
                return;
            }
            // 显示来电提示，等待用户点击接受
            showIncomingCallPrompt(data.callerId);
            break;
            
        case 'call_ringing':
            // 呼叫已送达对方
            console.log('[Call] Ringing', data.targetId);
            document.getElementById('status').textContent = `🔔 呼叫中 → ${data.targetId}...`;
            document.getElementById('status').style.color = '#ffa500';
            break;
            
        case 'call_connected':
            // 对方接受了呼叫，通话建立
            console.log('[Call] Connected with', data.peerId);
            document.getElementById('status').textContent = `🎙️ 通话中 → ${data.peerId}`;
            document.getElementById('status').style.color = '#4caf50';
            break;
            
        case 'call_error':
            // 呼叫失败
            console.error('[Call] Error:', data.message);
            alert(data.message);
            if (isCalling) {
                hangup();
            }
            break;
            
        case 'peer_hangup':
            // 对方挂断
            console.log('[Call] Peer hung up:', data.fromId);
            alert(`对方 ${data.fromId} 已挂断`);
            if (isCalling) {
                hangup();
            }
            break;
    }
}

// 初始化 Opus 编码器（使用 opus-recorder 的 Recorder 类）
function initEncoder() {
    return new Promise((resolve, reject) => {
        // 加载 recorder.min.js（非模块方式）
        const script = document.createElement('script');
        script.src = '/recorder.min.js';
        script.onload = () => {
            try {
                const Recorder = window.Recorder;
                if (!Recorder) {
                    reject(new Error('Recorder class not found'));
                    return;
                }
                
                encoder = new Recorder({
                    encoderPath: '/encoderWorker.min.js',
                    encoderWasmPath: '/encoderWorker.min.wasm',
                    encoderSampleRate: CONFIG.sampleRate,
                    bitRate: CONFIG.bitrate,
                    numberOfChannels: 1,
                    encoderFrameSize: CONFIG.frameDuration,
                    encoderApplication: 2048,  // VoIP mode (OPUS_APPLICATION_VOIP)
                    encoderComplexity: 0,       // 最低复杂度
                    monitorGain: 0,
                    recordingGain: 1,
                    streamPages: true,          // 实时流模式，每帧回调
                    mediaTrackConstraints: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        channelCount: 1
                    }
                });
                
                // 监听编码后的 Ogg Opus 数据
                encoder.ondataavailable = (data) => {
                    debugStats.encoderCallbacks++;
                    
                    if (!isCalling || !targetId || !ws || ws.readyState !== WebSocket.OPEN) return;
                    if (!data || data.length === 0) return;
                    
                    // 构造二进制包：4字节头 + Ogg Opus负载
                    const packet = new ArrayBuffer(4 + data.length);
                    const view = new DataView(packet);
                    view.setUint8(0, 0x01);                    // 类型：音频帧
                    view.setUint8(1, sequenceNumber++ % 256);   // 序列号
                    view.setUint16(2, parseInt(targetId));      // 目标ID
                    new Uint8Array(packet, 4).set(new Uint8Array(data));
                    
                    // 发送
                    ws.send(packet);
                    debugStats.sentPackets++;
                    debugStats.lastSentTime = Date.now();
                };
                
                encoder.onstart = () => {
                    console.log('[Encoder] Started');
                    debugStats.encoderStarted = true;
                    resolve();
                };
                
                encoder.onstop = () => {
                    console.log('[Encoder] Stopped');
                    debugStats.encoderStarted = false;
                };
                
                encoder.onerror = (err) => {
                    console.error('[Encoder] Error:', err);
                    reject(err);
                };
                
                console.log('[Encoder] Initialized');
                resolve();
            } catch (err) {
                reject(err);
            }
        };
        script.onerror = () => reject(new Error('Failed to load recorder.min.js'));
        document.head.appendChild(script);
    });
}

// 初始化解码器（使用 decoderWorker.min.js 作为 Web Worker）
function initDecoder() {
    return new Promise((resolve, reject) => {
        try {
            // 创建 Decoder Worker
            decoderWorker = new Worker('/decoderWorker.min.js');
            
            // 监听解码后的 PCM 数据
            decoderWorker.onmessage = (event) => {
                if (event.data === null) {
                    console.log('[Decoder] Flush complete');
                    return;
                }
                
                debugStats.decoderCallbacks++;
                
                if (event.data && event.data.length > 0) {
                    const pcmData = event.data[0]; // 单声道
                    if (pcmData && pcmData.length > 0) {
                        enqueuePCM(pcmData);
                    }
                }
            };
            
            decoderWorker.onerror = (err) => {
                console.error('[Decoder] Worker error:', err);
                reject(err);
            };
            
            // 初始化解码器（使用与编码器相同的采样率）
            decoderWorker.postMessage({
                command: 'init',
                decoderSampleRate: CONFIG.sampleRate,
                outputBufferSampleRate: CONFIG.sampleRate,
                bufferLength: CONFIG.sampleRate * CONFIG.frameDuration / 1000,
                numberOfChannels: 1,
                resampleQuality: 3
            });
            
            decoderReady = true;
            debugStats.decoderStarted = true;
            console.log('[Decoder] Worker initialized');
            resolve();
        } catch (err) {
            reject(err);
        }
    });
}

// PCM 播放队列
let pcmQueue = [];
let isPlaying = false;
let playAudioContext = null;

function enqueuePCM(pcmData) {
    pcmQueue.push(pcmData);
}

// 播放循环（使用 setInterval + AudioBufferSourceNode）
function setupPlayback() {
    // 复用已激活的 audioContext，避免重复创建
    if (!playAudioContext || playAudioContext.state === 'closed') {
        playAudioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: CONFIG.sampleRate
        });
    }
    
    // 恢复 AudioContext（浏览器要求用户手势后才能播放音频）
    if (playAudioContext.state === 'suspended') {
        playAudioContext.resume();
    }
    
    const frameSize = CONFIG.sampleRate * CONFIG.frameDuration / 1000;
    
    playbackInterval = setInterval(() => {
        if (!isCalling) return;
        
        // 从 Jitter Buffer 取出 Ogg 数据
        const oggData = jitterBuffer ? jitterBuffer.pop() : null;
        
        if (oggData) {
            try {
                decoderWorker.postMessage({
                    command: 'decode',
                    pages: oggData.buffer || oggData
                }, [oggData.buffer || oggData]);
            } catch (e) {
                decoderWorker.postMessage({
                    command: 'decode',
                    pages: oggData.buffer || oggData
                });
            }
        } else if (CONFIG.plcEnabled) {
            playSilence(frameSize);
        }
        
        // 从 PCM 队列取数据播放
        if (pcmQueue.length > 0) {
            const pcmData = pcmQueue.shift();
            playPCM(pcmData, frameSize);
            debugStats.playedFrames++;
        }
    }, CONFIG.frameDuration);
}

// 播放 PCM 数据
function playPCM(pcmData, expectedLength) {
    if (!playAudioContext || !pcmData) return;
    
    try {
        const actualLength = pcmData.length;
        const buffer = playAudioContext.createBuffer(1, actualLength, CONFIG.sampleRate);
        const channelData = buffer.getChannelData(0);
        channelData.set(pcmData);
        
        const source = playAudioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(playAudioContext.destination);
        source.start();
    } catch (e) {
        console.warn('[Playback] Error:', e);
    }
}

// 播放静音（丢包补偿）
function playSilence(frameSize) {
    if (!playAudioContext) return;
    
    try {
        const buffer = playAudioContext.createBuffer(1, frameSize, CONFIG.sampleRate);
        const source = playAudioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(playAudioContext.destination);
        source.start();
    } catch (e) {}
}

// 启动通话引擎（双方共用）
async function startCallEngine(peerId, isAnswer) {
    isCalling = true;
    targetId = peerId;
    
    // 重置统计
    debugStats = {
        encoderStarted: false,
        decoderStarted: false,
        sentPackets: 0,
        receivedPackets: 0,
        playedFrames: 0,
        lostPackets: 0,
        lastSentTime: 0,
        lastRecvTime: 0,
        encoderCallbacks: 0,
        decoderCallbacks: 0
    };
    
    try {
        document.getElementById('status').textContent = '🔄 初始化语音引擎...';
        document.getElementById('status').style.color = '#ffa500';
        
        // 初始化解码器
        await initDecoder();
        
        // 初始化 Jitter Buffer（在编码器启动之前，这样启动瞬间到达的包不会丢失）
        jitterBuffer = new JitterBuffer(CONFIG.jitterBufferSize);
        
        // 初始化编码器（Recorder 内部会自己创建 AudioContext 和获取麦克风）
        await initEncoder();
        
        // 启动编码器（Recorder.start() 内部会调用 getUserMedia）
        await encoder.start();
        
        // 设置播放
        setupPlayback();
        
        // 启动调试信息更新
        debugInterval = setInterval(updateDebugInfo, 500);
        
        // 如果是被叫方，通知呼叫方已接受
        if (isAnswer) {
            ws.send(JSON.stringify({
                type: 'call_accept',
                accepterId: clientId,
                callerId: peerId
            }));
        }
        
        document.getElementById('status').textContent = `🎙️ 通话中 → ${peerId}`;
        document.getElementById('status').style.color = '#4caf50';
        document.getElementById('callBtn').disabled = true;
        document.getElementById('hangupBtn').disabled = false;
        
        console.log(`[Call] ${isAnswer ? 'Answered' : 'Started'} with`, peerId);
    } catch (err) {
        console.error('[Call] Engine failed:', err);
        alert('启动语音引擎失败: ' + err.message);
        hangup();
    }
}

// 开始通话（主叫方）
async function startCall() {
    if (isCalling) {
        alert('Already in a call');
        return;
    }
    
    const targetInput = document.getElementById('targetInput');
    const target = targetInput.value.trim();
    if (!target || target === clientId) {
        alert('请输入有效的对方 Client ID（不能是自己）');
        targetInput.focus();
        return;
    }
    
    // 预先创建 AudioContext（激活浏览器音频权限，解决自动播放限制）
    if (!audioContext || audioContext.state === 'suspended') {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        audioContext.resume();
    }
    
    // 先发送呼叫信令
    ws.send(JSON.stringify({
        type: 'call',
        callerId: clientId,
        targetId: target
    }));
    
    // 启动语音引擎
    startCallEngine(target, false);
}

// 挂断
function hangup() {
    // 通知对方挂断
    if (ws && ws.readyState === WebSocket.OPEN && targetId) {
        ws.send(JSON.stringify({
            type: 'call_hangup',
            fromId: clientId,
            peerId: targetId
        }));
    }
    
    isCalling = false;
    
    if (debugInterval) {
        clearInterval(debugInterval);
        debugInterval = null;
    }
    
    if (playbackInterval) {
        clearInterval(playbackInterval);
        playbackInterval = null;
    }
    
    if (encoder) {
        try {
            encoder.stop();
        } catch (e) {}
        encoder = null;
    }
    
    if (decoderWorker) {
        try {
            decoderWorker.postMessage({ command: 'done' });
            setTimeout(() => {
                if (decoderWorker) {
                    decoderWorker.terminate();
                }
            }, 100);
        } catch (e) {}
        decoderWorker = null;
        decoderReady = false;
    }
    
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }
    
    if (playAudioContext && playAudioContext.state !== 'closed') {
        try {
            playAudioContext.close();
        } catch (e) {
            console.warn('[Cleanup] playAudioContext close error:', e);
        }
        playAudioContext = null;
    }
    
    if (audioContext && audioContext.state !== 'closed') {
        try {
            audioContext.close();
        } catch (e) {
            console.warn('[Cleanup] audioContext close error:', e);
        }
        audioContext = null;
    }
    
    if (jitterBuffer) {
        jitterBuffer.clear();
        jitterBuffer = null;
    }
    
    pcmQueue = [];
    isPlaying = false;
    sequenceNumber = 0;
    targetId = null;
    
    document.getElementById('status').textContent = '⚡ 空闲';
    document.getElementById('status').style.color = '#d4d4d4';
    document.getElementById('callBtn').disabled = false;
    document.getElementById('hangupBtn').disabled = true;
    document.getElementById('debugPanel').style.display = 'none';
    
    console.log('[Call] Ended');
}

// 显示来电提示
function showIncomingCallPrompt(callerId) {
    const message = `来电：${callerId}\n\n点击"确定"接听，点击"取消"拒绝`;
    if (confirm(message)) {
        // 用户点击接受，立即创建并激活 AudioContext（必须在用户交互回调中）
        if (!audioContext || audioContext.state === 'closed') {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === 'suspended') {
            audioContext.resume().then(() => {
                console.log('[AudioContext] Resumed after user interaction');
            });
        }
        
        targetId = callerId;
        document.getElementById('targetInput').value = callerId;
        startCallEngine(callerId, true);
    } else {
        // 用户拒绝来电
        ws.send(JSON.stringify({
            type: 'call_reject',
            rejecterId: clientId,
            callerId: callerId
        }));
    }
}

// 页面初始化
window.onload = () => {
    initWebSocket();
    
    document.getElementById('callBtn').onclick = startCall;
    document.getElementById('hangupBtn').onclick = hangup;
    document.getElementById('hangupBtn').disabled = true;
    
    console.log('[App] Ready');
};
