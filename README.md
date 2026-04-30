# node_lightweight_webVoiceChat

A Node.js implemented web voice chat app. Tech: WebSocket + WebCodecs (AudioEncoder/AudioDecoder) + AudioWorklet.

## Quick Start

```bash
npm install
npm start
```

Open `http://localhost:4001` — auto-redirects to a random room. Share the URL to invite others.

## Usage

1. **Open the page** — auto-assigned to a room (e.g. `/a3xk`)
2. **Choose codec preset** (optional) — 🚀 Low Latency / ⚖️ Balanced / 🎵 High Quality / 📡 Weak Network
3. **Click "📞 加入通话"** — audio encoded with Opus, relayed via WebSocket, decoded in real-time
4. **Click "❌ 退出通话"** to end the call

> **Note**: First joiner decides the codec config. Late joiners auto-sync and see config read-only.

## Features

- **URL path = Room ID** — `http://localhost:4001/room1` → room "room1"
- **Auto room redirect** — `/` generates a random 4-char room ID
- **Max rooms limit** — configurable via `.env` (`MAX_ROOMS=10`)
- **Room idle timeout** — auto-destroy empty rooms (`ROOM_IDLE_TIMEOUT=300s`)
- **Codec config sync** — first joiner's config synced to late joiners via server
- **1v1 only** — each room supports exactly 2 peers

## How It Works

```
Microphone → AudioWorklet (PCM capture) → AudioEncoder (Opus) → WebSocket Relay → AudioDecoder (Opus) → AudioWorklet (Ring Buffer) → Speaker
```

- **Capture**: `AudioWorkletProcessor` captures microphone PCM in configurable frames
- **Encoder**: `AudioEncoder` (WebCodecs) encodes PCM → Opus
- **Network**: 8-byte header (sampleRate + seq + timestamp) + Opus payload over WebSocket
- **Decoder**: `AudioDecoder` (WebCodecs) decodes Opus → PCM Float32
- **Playback**: Ring buffer in AudioWorklet with underrun protection
- **Server**: Zero-copy relay, room-based broadcasting, idle timeout cleanup

## Configuration

### `.env` (server)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 4001 | Server port |
| `MAX_ROOMS` | 10 | Maximum concurrent rooms |
| `ROOM_IDLE_TIMEOUT` | 300 | Room auto-destroy timeout (seconds) |

### Codec Presets (client UI)

| Preset | Sample Rate | Bitrate | Frame | Jitter |
|--------|:-----------:|:-------:|:-----:|:------:|
| 🚀 Low Latency | 48 kHz | 64 kbps | 20 ms | 2 frames |
| ⚖️ Balanced | 48 kHz | 32 kbps | 40 ms | 4 frames |
| 🎵 High Quality | 48 kHz | 64 kbps | 40 ms | 2 frames |
| 📡 Weak Network | 16 kHz | 16 kbps | 60 ms | 8 frames |

## Files

| File | Description |
|------|-------------|
| `server.js` | HTTP + WebSocket relay server with multi-room support |
| `public/index.html` | UI with codec config panel |
| `public/client.js` | Main client: WebSocket, WebCodecs, AudioWorklet, config sync |
| `public/opus-codec.js` | Standalone Opus codec module (WebCodecs-based) |
| `public/audio-worklet.js` | AudioWorkletProcessor for PCM capture & playback |
| `public/style.css` | Dark theme UI styles |
| `.env` | Server configuration |

## Tech Specs

- **Audio**: Mono, Opus, configurable sample rate & bitrate
- **Bandwidth**: ~4 KB/s per direction (balanced preset)
- **Latency**: ~160ms jitter buffer + network RTT (balanced preset)
- **Dependencies**: `ws` (server), `uuid` (server)
- **Browser**: Chrome 86+ / Edge 86+ (WebCodecs required)

## Browser Support

WebCodecs API is supported in:
- Chrome 86+
- Edge 86+
- Opera 72+
- Samsung Internet 15+

> **Note**: Uses browser-native `AudioEncoder`/`AudioDecoder`. No WASM binaries or external codec libraries required.
