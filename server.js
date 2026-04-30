// =============================================
// WebSocket + WebCodecs 语音中继服务器
// 多房间 · URL路径即房间ID · 自动资源回收
// =============================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// =============================================
// .env 配置加载
// =============================================
function loadEnv() {
    const envFile = path.join(__dirname, '.env');
    const config = {
        PORT: 4001,
        MAX_ROOMS: 10,
        ROOM_IDLE_TIMEOUT: 300
    };
    try {
        const content = fs.readFileSync(envFile, 'utf-8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim();
            if (key in config) {
                config[key] = isNaN(Number(val)) ? val : Number(val);
            }
        }
    } catch (err) {
        console.log('[ENV] No .env file found, using defaults');
    }
    return config;
}

const ENV = loadEnv();
const PORT = ENV.PORT;
const MAX_ROOMS = ENV.MAX_ROOMS;
const ROOM_IDLE_TIMEOUT_MS = ENV.ROOM_IDLE_TIMEOUT * 1000;

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.wasm': 'application/wasm',
    '.css': 'text/css',
    '.json': 'application/json'
};

// =============================================
// 生成随机4位字母数字房间ID
// =============================================
function generateRoomId() {
    const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
    let id = '';
    for (let i = 0; i < 4; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
}

// =============================================
// HTTP 静态文件服务器
// =============================================
const server = http.createServer((req, res) => {
    const url = req.url;

    // 根路径：生成随机房间ID并重定向
    if (url === '/') {
        const roomId = generateRoomId();
        console.log(`[REDIRECT] / -> /${roomId}`);
        res.writeHead(302, { 'Location': `/${roomId}` });
        res.end();
        return;
    }

    // 去掉查询参数（支持 ?v=N 缓存破坏）
    const cleanUrl = url.split('?')[0];
    const ext = path.extname(cleanUrl);
    if (!MIME_TYPES[ext]) {
        // 提取房间ID用于页面显示
        const roomId = url.slice(1).split('/')[0] || 'default';
        let filePath = path.join(__dirname, 'public', 'index.html');

        // 安全：防止目录穿越
        const normalizedPath = path.normalize(filePath);
        if (!normalizedPath.startsWith(path.join(__dirname, 'public'))) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        fs.readFile(filePath, 'utf-8', (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('404 Not Found');
                return;
            }
            // 将房间ID注入到HTML中，供前端JS读取
            const injected = data.replace(
                '</head>',
                `<script>window.__ROOM_ID__ = ${JSON.stringify(roomId)};</script>\n</head>`
            );
            res.writeHead(200, {
                'Content-Type': 'text/html',
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp'
            });
            res.end(injected);
        });
        return;
    }

    // 静态文件服务（使用去掉查询参数的路径）
    let filePath = path.join(__dirname, 'public', cleanUrl);

    // 安全：防止目录穿越
    const normalizedPath = path.normalize(filePath);
    if (!normalizedPath.startsWith(path.join(__dirname, 'public'))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

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
// 默认编解码配置
// =============================================
const DEFAULT_CODEC_CONFIG = {
    sampleRate: 48000,
    frameDuration: 0.04,
    opusBitrate: 32000,
    jitterBufferFrames: 4
};

// =============================================
// 房间状态
// =============================================
const rooms = new Map();   // roomId -> { peers: Set<peerId>, timer: timeoutId, codecConfig: {} }
const peers = new Map();   // peerId -> { ws, roomId }

// =============================================
// 房间空闲超时管理
// =============================================
function scheduleRoomCleanup(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    // 清除已有的定时器
    if (room.timer) {
        clearTimeout(room.timer);
        room.timer = null;
    }

    // 如果房间有用户，不设置定时器
    if (room.peers.size > 0) return;

    // 设置空闲超时自动销毁
    room.timer = setTimeout(() => {
        if (rooms.has(roomId)) {
            const r = rooms.get(roomId);
            if (r.peers.size === 0) {
                rooms.delete(roomId);
                console.log(`[ROOM] Room "${roomId}" auto-destroyed after ${ENV.ROOM_IDLE_TIMEOUT} seconds idle timeout`);
            }
        }
    }, ROOM_IDLE_TIMEOUT_MS);

    console.log(`[ROOM] Room "${roomId}" idle timer set (${ENV.ROOM_IDLE_TIMEOUT}s)`);
}

function cancelRoomCleanup(roomId) {
    const room = rooms.get(roomId);
    if (room && room.timer) {
        clearTimeout(room.timer);
        room.timer = null;
    }
}

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

    const newPeerId = msg.peerId || uuidv4().slice(0, 4);
    const newRoomId = msg.roomId || 'default';

    // ---- 检查最大房间数限制 ----
    // 如果房间不存在，检查是否已达到 MAX_ROOMS
    if (!rooms.has(newRoomId) && rooms.size >= MAX_ROOMS) {
        ws.send(JSON.stringify({
            type: 'error',
            message: `❌ 服务器已达最大房间数限制 (${MAX_ROOMS})，无法创建新房间`
        }));
        console.log(`[REJECT] Max rooms (${MAX_ROOMS}) reached, cannot create room "${newRoomId}"`);
        return { peerId: null, roomId: null };
    }

    // 确保 peerId 在房间内唯一
    const finalPeerId = ensureUniquePeerId(newRoomId, newPeerId);

    // 创建房间（如果不存在），使用发起方的编解码配置
    if (!rooms.has(newRoomId)) {
        const userConfig = msg.codecConfig || {};
        const roomConfig = { ...DEFAULT_CODEC_CONFIG, ...userConfig };
        rooms.set(newRoomId, { peers: new Set(), timer: null, codecConfig: roomConfig });
        console.log(`[CONFIG] Room "${newRoomId}" codec config:`, roomConfig);
    }

    const room = rooms.get(newRoomId);

    // 限制：仅支持 1v1 通话，房间最多 2 人
    if (room.peers.size >= 2) {
        ws.send(JSON.stringify({
            type: 'error',
            message: '❌ 1v1通话房间已满，仅支持 1v1 通话'
        }));
        console.log(`[REJECT] Room "${newRoomId}" is full (2/2), rejected peer "${newPeerId}"`);
        return { peerId: null, roomId: null };
    }

    // 房间有用户加入，取消空闲销毁定时器
    cancelRoomCleanup(newRoomId);

    room.peers.add(finalPeerId);
    peers.set(finalPeerId, { ws, roomId: newRoomId });

    // 获取房间内其他 peer 列表
    const existingPeers = Array.from(room.peers).filter(id => id !== finalPeerId);

    // 回复加入成功（携带房间编解码配置）
    ws.send(JSON.stringify({
        type: 'joined',
        peerId: finalPeerId,
        roomId: newRoomId,
        peers: existingPeers,
        codecConfig: room.codecConfig
    }));

    // 通知房间内其他 peer
    broadcastToRoom(newRoomId, {
        type: 'peer_joined',
        peerId: finalPeerId
    }, finalPeerId);

    console.log(`[JOIN] Peer "${finalPeerId}" joined room "${newRoomId}" (${room.peers.size}/${MAX_ROOMS} rooms)`);

    return { peerId: finalPeerId, roomId: newRoomId };
}

function ensureUniquePeerId(roomId, baseId) {
    const room = rooms.get(roomId);
    if (!room || !room.peers.has(baseId)) return baseId;

    // 如果 ID 冲突，追加数字后缀
    let counter = 1;
    while (room.peers.has(`${baseId}_${counter}`)) {
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
        room.peers.delete(peerId);

        // 通知房间内其他人
        broadcastToRoom(roomId, {
            type: 'peer_left',
            peerId
        }, peerId);

        console.log(`[LEAVE] Peer "${peerId}" left room "${roomId}" (${room.peers.size} peers remain)`);

        // 如果房间空了，设置空闲超时自动销毁
        if (room.peers.size === 0) {
            scheduleRoomCleanup(roomId);
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

    for (const pid of room.peers) {
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

    for (const pid of room.peers) {
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
                room.peers.delete(pid);
                broadcastToRoom(peer.roomId, { type: 'peer_left', peerId: pid }, pid);
                if (room.peers.size === 0) {
                    scheduleRoomCleanup(peer.roomId);
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
    console.log(`  Max Rooms: ${MAX_ROOMS}`);
    console.log(`  Room Idle Timeout: ${ENV.ROOM_IDLE_TIMEOUT}s`);
    console.log(`  Default Codec: Opus ${DEFAULT_CODEC_CONFIG.opusBitrate/1000}kbps @ ${DEFAULT_CODEC_CONFIG.sampleRate/1000}kHz`);
    console.log('═══════════════════════════════════════════');
    console.log('[READY] Multi-room WebCodecs Opus relay running');
});
