# node_lightweight_webVoiceChat

A Node.js implemented web voice chat app. Tech: WebSocket + WebCodecs (AudioEncoder/AudioDecoder) + AudioWorklet.

## Quick Start

```bash
npm install
npm start
```

Open `http://localhost:4001` in two browser tabs (or two devices on the same network).

## Usage

1. **Open the page** — you'll see your Peer ID
2. **Click "📞 加入语音会议室"** — audio is encoded with Opus @ 32kbps via WebCodecs, relayed via WebSocket, decoded and played in real-time
3. **Click "🔴 离开"** to end the call

## How It Works

```
Microphone → AudioWorklet (PCM capture) → AudioEncoder (Opus) → WebSocket Relay → AudioDecoder (Opus) → AudioWorklet (Ring Buffer) → Speaker
```

- **Capture**: `AudioWorkletProcessor` captures microphone PCM in 40ms frames
- **Encoder**: `AudioEncoder` (WebCodecs) encodes PCM → Opus @ 32kbps
- **Network**: 8-byte header (sampleRate + seq + timestamp) + Opus payload over WebSocket
- **Decoder**: `AudioDecoder` (WebCodecs) decodes Opus → PCM Float32
- **Playback**: Ring buffer in AudioWorklet with underrun protection
- **Server**: Zero-copy relay, room-based broadcasting

## Architecture

### Files

| File | Description |
|------|-------------|
| `server.js` | HTTP + WebSocket relay server |
| `public/index.html` | UI |
| `public/client.js` | Main client: WebSocket, WebCodecs, AudioWorklet management |
| `public/opus-codec.js` | Standalone Opus codec module (WebCodecs-based, zero WASM dependency) |
| `public/audio-worklet.js` | AudioWorkletProcessor for PCM capture & playback |

### Codec Module (`opus-codec.js`)

The `OPUS_CODEC` module provides a standalone Opus codec based on WebCodecs API:

```javascript
// Encoder
const encoder = new OPUS_CODEC.OpusEncoder(48000, 1, OPUS_CODEC.APPLICATION_VOIP);
await encoder.init();
const opusData = await encoder.encode(pcmFrames);  // Float32Array → Uint8Array

// Decoder
const decoder = new OPUS_CODEC.OpusDecoder(48000, 1);
await decoder.init();
const pcmData = await decoder.decode(opusData);    // Uint8Array → Float32Array
```

## Configuration

Edit `CONFIG` in `public/client.js`:

| Parameter | Default | Description |
|-----------|---------|-------------|
| sampleRate | 48000 | Audio sample rate (Hz) |
| frameDuration | 0.04 | Frame duration (seconds) |
| opusBitrate | 32000 | Opus bitrate (bps) |
| jitterBufferFrames | 4 | Ring buffer size (frames) |

## Tech Specs

- **Audio**: 48kHz mono, Opus @ 32kbps, 40ms frames
- **Bandwidth**: ~4 KB/s per direction
- **Latency**: ~160ms jitter buffer + network RTT
- **Dependencies**: `ws` (server), `uuid` (server)
- **Browser**: Chrome 86+ / Edge 86+ / Firefox 100+ (WebCodecs support required)

## Browser Support

WebCodecs API is supported in:
- Chrome 86+
- Edge 86+
- Firefox 100+ (behind flag)
- Opera 72+
- Samsung Internet 15+

> **Note**: This project uses browser-native `AudioEncoder`/`AudioDecoder` APIs. No WASM binaries or external codec libraries are required.
