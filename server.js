// =============================================
// WebSocket + Opus(WASM) 语音中继服务器
// 极致轻量 · 最低延迟 · 资源受限环境最优解
// =============================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const PORT = 4001;
const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.wasm': 'application/wasm',
    '.css': 'text/css',
    '.json': 'application/json'
};

// =============================================
// HTTP 静态文件服务器
// =============================================
const server = http.createServer((req, res) => {
    const url = req.url;
    let filePath = path.join(__dirname, 'public', url === '/' ? 'index.html' : url);

    // 安全：防止目录穿越
    const normalizedPath = path.normalize(filePath);
    if (!normalizedPath.startsWith(path.join(__dirname, 'public'))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('404 Not Found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': contentType,
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp'
        });
        res.end(data);
    });
});

// =============================================
// WebSocket 服务器
// =============================================
const WebSocket = require('ws');
const wss = new WebSocket.Server({
    server,
    maxPayload: 1024 * 1024 // 1MB max per message
});

// =============================================
// 房间状态
// =============================================
const rooms = new Map();   // roomId -> Set<peerId>
const peers = new Map();   // peerId -> { ws, roomId }

// =============================================
// WebSocket 事件处理
// =============================================
wss.on('connection', (ws) => {
    let peerId = null;
    let roomId = null;

    // ---- 消息处理 ----
    ws.on('message', (data, isBinary) => {
        try {
            if (isBinary) {
                handleBinaryMessage(ws, peerId, roomId, data);
            } else {
                const msg = JSON.parse(data.toString());
                switch (msg.type) {
                    case 'join':
                        ({ peerId, roomId } = handleJoin(ws, msg, peerId, roomId));
                        break;
                    case 'leave':
                        handleLeave(ws, peerId, roomId);
                        peerId = null;
                        roomId = null;
                        break;
                    case 'ping':
                        ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
                        break;
                }
            }
        } catch (err) {
            console.error(`[WS] Error: ${err.message}`);
        }
    });

    // ---- 断开连接 ----
    ws.on('close', () => {
        if (peerId && roomId) {
            handleLeave(ws, peerId, roomId);
        }
    });

    ws.on('error', () => {
        if (peerId && roomId) {
            handleLeave(ws, peerId, roomId);
        }
    });
});

// =============================================
// 加入房间
// =============================================
function handleJoin(ws, msg, oldPeerId, oldRoomId) {
    // 先离开旧房间
    if (oldPeerId && oldRoomId) {
        handleLeave(ws, oldPeerId, oldRoomId);
    }

    const newPeerId = msg.peerId || uuidv4().slice(0, 8);
    const newRoomId = msg.roomId || 'default';

    // 确保 peerId 在房间内唯一
    const finalPeerId = ensureUniquePeerId(newRoomId, newPeerId);

    // 创建房间（如果不存在）
    if (!rooms.has(newRoomId)) {
        rooms.set(newRoomId, new Set());
    }

    const room = rooms.get(newRoomId);
    room.add(finalPeerId);
    peers.set(finalPeerId, { ws, roomId: newRoomId });

    // 获取房间内其他 peer 列表
    const existingPeers = Array.from(room).filter(id => id !== finalPeerId);

    // 回复加入成功
    ws.send(JSON.stringify({
        type: 'joined',
        peerId: finalPeerId,
        roomId: newRoomId,
        peers: existingPeers
    }));

    // 通知房间内其他 peer
    broadcastToRoom(newRoomId, {
        type: 'peer_joined',
        peerId: finalPeerId
    }, finalPeerId);

    console.log(`[JOIN] Peer "${finalPeerId}" joined room "${newRoomId}" (${room.size} peers)`);

    return { peerId: finalPeerId, roomId: newRoomId };
}

function ensureUniquePeerId(roomId, baseId) {
    const room = rooms.get(roomId);
    if (!room || !room.has(baseId)) return baseId;

    // 如果 ID 冲突，追加数字后缀
    let counter = 1;
    while (room.has(`${baseId}_${counter}`)) {
        counter++;
    }
    return `${baseId}_${counter}`;
}

// =============================================
// 离开房间
// =============================================
function handleLeave(ws, peerId, roomId) {
    if (!peerId || !roomId) return;

    const room = rooms.get(roomId);
    if (room) {
        room.delete(peerId);

        // 通知房间内其他人
        broadcastToRoom(roomId, {
            type: 'peer_left',
            peerId
        }, peerId);

        console.log(`[LEAVE] Peer "${peerId}" left room "${roomId}" (${room.size} peers remain)`);

        // 如果房间空了，清理
        if (room.size === 0) {
            rooms.delete(roomId);
            console.log(`[ROOM] Room "${roomId}" deleted (empty)`);
        }
    }

    peers.delete(peerId);
}

// =============================================
// 二进制音频数据中继
// =============================================
function handleBinaryMessage(ws, peerId, roomId, data) {
    if (!peerId || !roomId) {
        console.warn('[BINARY] Received from unregistered peer');
        return;
    }

    // Opus 数据包的二进制格式：
    // [0-1] 采样率 (Uint16, Hz)
    // [2-3] 帧序号 (Uint16, 用于丢包检测)
    // [4-7] 时间戳 (Uint32, ms)
    // [8..] Opus 编码数据

    // 广播给房间内所有其他 peer
    broadcastBinaryToRoom(roomId, data, peerId);
}

// =============================================
// 广播
// =============================================
function broadcastToRoom(roomId, message, excludePeerId) {
    const room = rooms.get(roomId);
    if (!room) return;

    const jsonStr = JSON.stringify(message);

    for (const pid of room) {
        if (pid === excludePeerId) continue;
        const peer = peers.get(pid);
        if (peer && peer.ws.readyState === WebSocket.OPEN) {
            peer.ws.send(jsonStr);
        }
    }
}

function broadcastBinaryToRoom(roomId, data, excludePeerId) {
    const room = rooms.get(roomId);
    if (!room) return;

    for (const pid of room) {
        if (pid === excludePeerId) continue;
        const peer = peers.get(pid);
        if (peer && peer.ws.readyState === WebSocket.OPEN) {
            peer.ws.send(data);
        }
    }
}

// =============================================
// 健康检查：定期清理断开的连接
// =============================================
setInterval(() => {
    for (const [pid, peer] of peers) {
        if (peer.ws.readyState !== WebSocket.OPEN) {
            const room = rooms.get(peer.roomId);
            if (room) {
                room.delete(pid);
                broadcastToRoom(peer.roomId, { type: 'peer_left', peerId: pid }, pid);
                if (room.size === 0) {
                    rooms.delete(peer.roomId);
                }
            }
            peers.delete(pid);
            console.log(`[CLEANUP] Removed stale peer "${pid}"`);
        }
    }
}, 30000);

// =============================================
// 启动
// =============================================
server.listen(PORT, () => {
    console.log('═══════════════════════════════════════════');
    console.log('  WebSocket + WebCodecs Voice Relay');
    console.log(`  Server: http://localhost:${PORT}`);
    console.log(`  WS:     ws://localhost:${PORT}`);
    console.log('═══════════════════════════════════════════');
    console.log('[READY] WebCodecs Opus relay running');
});
