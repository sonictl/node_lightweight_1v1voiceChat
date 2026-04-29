const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 配置
const PORT = 4001;
const BUFFER_POOL_SIZE = 4096;      // 每个连接的接收缓冲区大小
const MAX_CLIENTS = 50;              // 最大客户端数
const CONNECTION_TIMEOUT = 60000;    // 60秒无活动断开

// 内存存储
const clients = new Map();           // clientId -> WebSocket
const clientInfo = new Map();        // WebSocket -> {clientId, lastActive, pendingWrites}
const peerMap = new Map();           // clientId -> targetClientId

// MIME 类型映射
const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.wasm': 'application/wasm',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
};

// 创建 HTTP 服务器（提供静态文件）
const server = http.createServer((req, res) => {
    const url = req.url;
    
    // 特殊路由：提供 opus-recorder 的 Worker/WASM 文件
    if (url === '/encoderWorker.min.js') {
        serveFile(res, path.join(__dirname, 'node_modules', 'opus-recorder', 'dist', 'encoderWorker.min.js'), 'application/javascript');
        return;
    }
    if (url === '/encoderWorker.min.wasm') {
        serveFile(res, path.join(__dirname, 'node_modules', 'opus-recorder', 'dist', 'encoderWorker.min.wasm'), 'application/wasm');
        return;
    }
    if (url === '/decoderWorker.min.js') {
        serveFile(res, path.join(__dirname, 'node_modules', 'opus-recorder', 'dist', 'decoderWorker.min.js'), 'application/javascript');
        return;
    }
    if (url === '/decoderWorker.min.wasm') {
        serveFile(res, path.join(__dirname, 'node_modules', 'opus-recorder', 'dist', 'decoderWorker.min.wasm'), 'application/wasm');
        return;
    }
    if (url === '/waveWorker.min.js') {
        serveFile(res, path.join(__dirname, 'node_modules', 'opus-recorder', 'dist', 'waveWorker.min.js'), 'application/javascript');
        return;
    }
    if (url === '/recorder.min.js') {
        serveFile(res, path.join(__dirname, 'node_modules', 'opus-recorder', 'dist', 'recorder.min.js'), 'application/javascript');
        return;
    }
    
    // 普通静态文件
    const filePath = path.join(__dirname, 'public', url === '/' ? 'index.html' : url);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'text/plain';
    
    serveFile(res, filePath, contentType);
});

// 文件服务辅助函数
function serveFile(res, filePath, contentType) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('404 Not Found: ' + path.basename(filePath));
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

// WebSocket 服务器（禁用 permessage-deflate）
const wss = new WebSocket.Server({ 
    server,
    perMessageDeflate: false,  // 关键：禁用压缩，节省CPU
    maxPayload: 20 * 1024      // 20KB（安全边界，容纳音频帧）
});

// 监控统计
let stats = {
    totalPackets: 0,
    totalBytes: 0,
    lastReport: Date.now(),
    packetsPerSecond: 0
};

setInterval(() => {
    const now = Date.now();
    const elapsed = (now - stats.lastReport) / 1000;
    const pps = stats.packetsPerSecond / elapsed;
    const bps = (stats.totalBytes * 8) / elapsed;
    
    console.log(`[STATS] ${Math.round(pps)} pkts/s | ${Math.round(bps)} bps (${(bps/1024).toFixed(1)} kb/s) | Clients: ${clients.size}`);
    
    stats.packetsPerSecond = 0;
    stats.totalBytes = 0;
    stats.lastReport = now;
}, 5000);

// WebSocket 连接处理
wss.on('connection', (ws, req) => {
    // 初始化客户端
    let clientId = null;
    let lastActive = Date.now();
    
    // 设置 TCP_NODELAY（禁用 Nagle 算法）
    ws._socket.setNoDelay(true);
    
    // 设置超时监控
    const timeoutInterval = setInterval(() => {
        if (Date.now() - lastActive > CONNECTION_TIMEOUT) {
            console.log(`[TIMEOUT] Client ${clientId} inactive for ${CONNECTION_TIMEOUT}ms`);
            ws.terminate();
        }
    }, 10000);
    
    ws.on('message', (data, isBinary) => {
        if (!isBinary) {
            // 处理文本信令（注册/配对）
            handleSignaling(ws, data.toString(), clientId, (id) => { clientId = id; });
            lastActive = Date.now();
            return;
        }
        
        // 处理二进制音频数据（直接转发）
        lastActive = Date.now();
        
        // 极简解析：4字节Header [type(1) + seq(1) + targetId(2)]
        if (data.length < 4) return;
        
        const targetId = String(data.readUInt16BE(2));  // 目标客户端ID（转为字符串匹配）
        const audioData = data.slice(4);         // Opus 负载
        
        // 统计
        stats.totalPackets++;
        stats.packetsPerSecond++;
        stats.totalBytes += data.length;
        
        // 零拷贝转发
        const targetWs = clients.get(targetId);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            // 检查发送队列积压（防止内存爆炸）
            const info = clientInfo.get(targetWs);
            if (info && info.pendingWrites > 10) {
                // 目标客户端接收太慢，丢弃此包
                return;
            }
            
            // 直接发送，不做任何处理
            targetWs.send(data, { binary: true }, (err) => {
                if (err && err.code !== 'ERR_STREAM_WRITE_AFTER_END') {
                    // 发送失败，清理连接
                    cleanupClient(targetWs);
                }
                // 发送完成（成功或失败都减1），防止 pendingWrites 只增不减导致所有后续包被丢弃
                const targetInfo = clientInfo.get(targetWs);
                if (targetInfo) targetInfo.pendingWrites--;
            });
            
            // 更新积压计数
            const targetInfo = clientInfo.get(targetWs);
            if (targetInfo) targetInfo.pendingWrites++;
        }
    });
    
    ws.on('error', (err) => {
        console.error(`[ERROR] Client ${clientId}: ${err.message}`);
    });
    
    ws.on('close', () => {
        clearInterval(timeoutInterval);
        cleanupClient(ws);
        if (clientId) {
            clients.delete(clientId);
            peerMap.delete(clientId);
            console.log(`[CLOSE] Client ${clientId} disconnected. Active: ${clients.size}`);
        }
    });
    
    // 初始化客户端信息
    clientInfo.set(ws, { pendingWrites: 0 });
});

// 信令处理（极简）
function handleSignaling(ws, message, existingClientId, setClientId) {
    try {
        const data = JSON.parse(message);
        
        switch (data.type) {
            case 'register':
                // 注册客户端ID
                let clientId = data.clientId || `user_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
                if (clients.has(clientId)) {
                    clientId = `${clientId}_${Date.now()}`;
                }
                clients.set(clientId, ws);
                setClientId(clientId);
                
                // 绑定客户端ID到ws对象
                ws.clientId = clientId;
                
                ws.send(JSON.stringify({ type: 'registered', clientId }));
                console.log(`[REGISTER] ${clientId} registered. Active: ${clients.size}`);
                
                // 通知现有连接数（调试用）
                if (clients.size === 2) {
                    console.log('[INFO] 2 clients connected, ready for P2P voice');
                }
                break;
                
            case 'call':
                // 用户A呼叫用户B：通知B有人呼叫
                const callerId = data.callerId;   // 呼叫者ID
                const targetId = data.targetId;   // 被呼叫者ID
                const targetWs = clients.get(targetId);
                
                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    // 通知被呼叫者：有人呼入
                    targetWs.send(JSON.stringify({
                        type: 'incoming_call',
                        callerId: callerId
                    }));
                    console.log(`[CALL] ${callerId} → ${targetId} (notified)`);
                    
                    // 回复呼叫者：通知已送达
                    ws.send(JSON.stringify({
                        type: 'call_ringing',
                        targetId: targetId
                    }));
                } else {
                    // 被呼叫者不在线
                    ws.send(JSON.stringify({
                        type: 'call_error',
                        message: `对方 ${targetId} 不在线`
                    }));
                    console.log(`[CALL] ${callerId} → ${targetId} FAILED (offline)`);
                }
                break;
                
            case 'call_accept':
                // 被呼叫者接受呼叫：通知呼叫者
                const accepterId = data.accepterId;
                const callerWs = clients.get(data.callerId);
                
                if (callerWs && callerWs.readyState === WebSocket.OPEN) {
                    callerWs.send(JSON.stringify({
                        type: 'call_connected',
                        peerId: accepterId
                    }));
                    console.log(`[CALL] ${accepterId} accepted call from ${data.callerId}`);
                }
                break;
                
            case 'call_hangup':
                // 一方挂断：通知另一方
                const peerId = data.peerId;
                const peerWs = clients.get(peerId);
                
                if (peerWs && peerWs.readyState === WebSocket.OPEN) {
                    peerWs.send(JSON.stringify({
                        type: 'peer_hangup',
                        fromId: data.fromId
                    }));
                    console.log(`[CALL] ${data.fromId} hung up, notified ${peerId}`);
                }
                break;
        }
    } catch (e) {
        console.error('[SIGNAL] Parse error:', e.message);
    }
}

// 清理客户端资源
function cleanupClient(ws) {
    const info = clientInfo.get(ws);
    if (info) {
        clientInfo.delete(ws);
    }
}

// 启动服务器
server.listen(PORT, () => {
    console.log(`[SERVER] Ultra-lightweight voice relay running on port ${PORT}`);
    console.log(`[CONFIG] TCP_NODELAY: enabled | perMessageDeflate: disabled`);
    console.log(`[LIMITS] Max clients: ${MAX_CLIENTS} | Buffer pool: ${BUFFER_POOL_SIZE} bytes`);
    console.log(`[ROUTES] Worker/WASM files served from node_modules/opus-recorder/dist/`);
});
