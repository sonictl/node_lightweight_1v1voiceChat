# node_lightweight_webVoiceChat

A Node.js implemented web voice chat app. Tech: WebSocket + Opus Encoder/Decoder + Jitter Buffer.

## Quick Start

```bash
npm install
npm start
```

Open `http://localhost:3000` in two browser tabs (or two devices on the same network).

## Usage

1. **Open the page** — you'll see your 4-digit Client ID (e.g., `1706`)
2. **Tell the other person your ID** — they enter it in the "对方 ID" input field
3. **Enter the other person's ID** in the input field
4. **Click "📞 开始通话"** — audio is encoded with Opus @ 8kbps, relayed via WebSocket, decoded and played in real-time
5. **Click "🔴 挂断"** to end the call

## How It Works

```
Microphone → Opus Encoder (Worker) → WebSocket Relay → Opus Decoder (Worker) → Speaker
```

- **Encoder**: `opus-recorder` Recorder class, outputs Ogg Opus pages
- **Network**: 4-byte header (type + seq + targetId) + Ogg Opus payload over WebSocket
- **Decoder**: `decoderWorker.min.js` as Web Worker, decodes Ogg Opus → PCM Float32
- **Jitter Buffer**: Ring buffer with sequence numbers (0-255), handles packet loss with PLC
- **Server**: Zero-copy relay, TCP_NODELAY, per-message deflate disabled

## Configuration

Edit `CONFIG` in `public/client.js`:

| Parameter | Default | Description |
|-----------|---------|-------------|
| sampleRate | 8000 | Audio sample rate (Hz) |
| frameDuration | 40 | Frame duration (ms) |
| bitrate | 8000 | Opus bitrate (bps) |
| jitterBufferSize | 5 | Ring buffer size (frames) |
| initialBufferMs | 120 | Initial buffering before playback |
| plcEnabled | true | Packet loss concealment |

## Tech Specs

- **Audio**: 8kHz mono, Opus @ 8kbps CBR, 40ms frames
- **Bandwidth**: ~3 KB/s per direction
- **Latency**: ~120ms initial buffer + network RTT
- **Concurrency**: 10-15 pairs @ 300 kb/s
- **Dependencies**: `opus-recorder` (browser), `ws` (server)
