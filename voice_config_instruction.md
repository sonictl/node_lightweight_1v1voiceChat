## 语音编解码可配置项

当前项目使用 **WebCodecs Opus** 编解码，以下是所有可配置的参数及其影响：

### 1. 采样率 (`sampleRate`)
```javascript
sampleRate: 48000  // 可选: 8000, 16000, 24000, 48000
```
- **48000** — CD音质，语音通话推荐（当前值）
- **16000** — 电话音质，带宽减半
- **8000** — 窄带语音，最低带宽
- ⚡ 影响：越高音质越好，但带宽和CPU消耗越大

### 2. 帧长 (`frameDuration`)
```javascript
frameDuration: 0.04  // 可选: 0.02, 0.04, 0.06, 0.08, 0.12 (秒)
```
- **0.04 (40ms)** — 平衡延迟和带宽（当前值）
- **0.02 (20ms)** — 最低延迟，但带宽略高（Opus默认值）
- **0.06 (60ms)** — 更低带宽，适合弱网
- **0.12 (120ms)** — 最低带宽，但延迟明显
- ⚡ 影响：帧长越短延迟越低，但每帧头部开销占比越大

### 3. Opus 比特率 (`opusBitrate`)
```javascript
opusBitrate: 32000  // 可选: 6000 ~ 510000 (bps)
```
- **32000 (32kbps)** — 语音通话最优（当前值）
- **16000 (16kbps)** — 可接受的语音质量，带宽减半
- **8000 (8kbps)** — 窄带语音，极低带宽
- **64000 (64kbps)** — 接近无损语音
- ⚡ 影响：比特率越低带宽越小，但语音清晰度下降

### 4. 抖动缓冲 (`jitterBufferFrames`)
```javascript
jitterBufferFrames: 4  // 可选: 1 ~ 10
```
- **4 (约160ms)** — 平衡抗抖动和延迟（当前值）
- **1 (约40ms)** — 最低延迟，但网络抖动时易卡顿
- **8 (约320ms)** — 强抗抖动，适合不稳定网络
- ⚡ 影响：值越大越抗网络抖动，但端到端延迟增加

### 5. 声道数 (`numberOfChannels`)
```javascript
numberOfChannels: 1  // 可选: 1 (单声道), 2 (立体声)
```
- **1** — 单声道，语音通话标准（当前值）
- **2** — 立体声，带宽翻倍，语音通话不需要
- ⚡ 影响：语音通话始终建议用单声道

### 6. 麦克风音频处理
```javascript
getUserMedia({
    audio: {
        echoCancellation: true,   // 回声消除
        noiseSuppression: true,   // 降噪
        autoGainControl: true,    // 自动增益控制
        channelCount: 1,          // 单声道
        sampleRate: { ideal: 48000 }  // 目标采样率
    }
})
```
- **echoCancellation** — 建议开启，防止对方声音被麦克风重新拾取
- **noiseSuppression** — 建议开启，过滤背景噪音
- **autoGainControl** — 建议开启，自动调节麦克风音量

### 推荐配置组合

| 场景 | sampleRate | frameDuration | opusBitrate | jitterBuffer |
|------|:----------:|:-------------:|:-----------:|:------------:|
| 🚀 **低延迟**（当前） | 48000 | 40ms | 32kbps | 4帧 |
| 📡 **弱网环境** | 16000 | 60ms | 16kbps | 8帧 |
| 🎵 **高音质** | 48000 | 20ms | 64kbps | 2帧 |
| 📶 **极低带宽** | 8000 | 120ms | 8kbps | 6帧 |

这些参数都可以在 `public/client.js` 的 `CONFIG` 对象中调整，无需修改其他代码。