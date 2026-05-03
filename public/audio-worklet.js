// =============================================
// PCM AudioWorklet - 双向音频处理
// 输入: 麦克风捕获 → 主线程编码
// 输出: 主线程解码 → 扬声器播放
// v2.1 2026-05-03 22:24:19
// =============================================

class VoiceWorklet extends AudioWorkletProcessor {
    constructor() {
        super();

        // ---- 捕获端参数 ----
        this._sampleRate = sampleRate; // AudioContext 的采样率
        this._frameDuration = 0.04;    // 40ms 帧长（默认，可通过消息更新）
        this._frameSamples = Math.floor(sampleRate * this._frameDuration);
        this._captureBuffer = [];

        // ---- 播放端参数 ----
        this._ringBuffer = new Float32Array(this._frameSamples * 8); // 8 帧环形缓冲
        this._ringWrite = 0;
        this._ringRead = 0;
        this._ringSize = this._ringBuffer.length;
        this._underrun = true; // 初始未就绪

        // ---- 状态 ----
        this._frameSeq = 0;

        // 监听主线程消息
        this.port.onmessage = (event) => this._onMessage(event);

        console.log(`[VoiceWorklet] Init: ${sampleRate}Hz, ${this._frameSamples}samples/frame`);
    }

    /**
     * 主线程发来的解码后 PCM 数据
     */
    _onMessage(event) {
        const data = event.data;

        if (data.type === 'pcm') {
            // 将解码后的 PCM 写入环形缓冲区
            const pcm = data.data; // Float32Array
            if (!(pcm instanceof Float32Array)) return;

            for (let i = 0; i < pcm.length; i++) {
                this._ringBuffer[this._ringWrite] = pcm[i];
                this._ringWrite = (this._ringWrite + 1) % this._ringSize;
            }

            // 标记有数据了
            if (this._underrun && this._getBufferedSamples() >= this._frameSamples) {
                this._underrun = false;
            }
        }

        if (data.type === 'config') {
            // 更新帧参数（采样率不变，帧长可变）
            if (data.frameDuration) {
                this._frameDuration = data.frameDuration;
                this._frameSamples = Math.floor(this._sampleRate * this._frameDuration);
                // 重新分配环形缓冲区（8 帧容量）
                this._ringBuffer = new Float32Array(this._frameSamples * 8);
                this._ringWrite = 0;
                this._ringRead = 0;
                this._ringSize = this._ringBuffer.length;
                this._underrun = true;
                console.log(`[VoiceWorklet] Config updated: frameDuration=${this._frameDuration}s, frameSamples=${this._frameSamples}, ringSize=${this._ringSize}`);
            }
        }

        if (data.type === 'reset') {
            this._ringWrite = 0;
            this._ringRead = 0;
            this._underrun = true;
            this._captureBuffer = [];
        }

        if (data.type === 'flush') {
            // 输出剩余捕获数据
            if (this._captureBuffer.length > 0) {
                const frame = new Float32Array(this._captureBuffer);
                this._captureBuffer = [];
                this.port.postMessage({
                    type: 'pcm',
                    data: frame,
                    sampleRate: this._sampleRate,
                    seq: this._frameSeq++
                });
            }
        }
    }

    /**
     * 获取环形缓冲区中可用样本数
     */
    _getBufferedSamples() {
        let samples = this._ringWrite - this._ringRead;
        if (samples < 0) samples += this._ringSize;
        return samples;
    }

    /**
     * 从环形缓冲区读取 count 个样本
     */
    _readFromRing(count) {
        const output = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            output[i] = this._ringBuffer[this._ringRead];
            this._ringRead = (this._ringRead + 1) % this._ringSize;
        }
        return output;
    }

    /**
     * AudioWorklet 主处理循环
     * 每次调用处理 128 个样本（约 2.67ms @48kHz）
     */
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        // ---- 捕获端: 累积麦克风输入 ----
        if (input && input[0]) {
            const channelData = input[0];
            this._captureBuffer.push(...channelData);

            // 当积累够一帧时，发送给主线程编码
            if (this._captureBuffer.length >= this._frameSamples) {
                const frame = new Float32Array(this._captureBuffer.slice(0, this._frameSamples));
                this._captureBuffer = this._captureBuffer.slice(this._frameSamples);

                this.port.postMessage({
                    type: 'pcm',
                    data: frame,
                    sampleRate: this._sampleRate,
                    seq: this._frameSeq++
                });
            }
        }

        // ---- 播放端: 向扬声器输出 ----
        if (output && output[0]) {
            const outputChannelL = output[0];
            const outputChannelR = output[1]; // 可能为 undefined（单声道输出）

            if (this._underrun) {
                // 缓冲区未就绪，输出静音
                outputChannelL.fill(0);
                if (outputChannelR) outputChannelR.fill(0);
            } else {
                const available = this._getBufferedSamples();
                const needed = outputChannelL.length;

                if (available >= needed) {
                    const pcm = this._readFromRing(needed);
                    // 左声道
                    outputChannelL.set(pcm);
                    // 右声道（如果有）—— 复制相同数据实现立体声
                    if (outputChannelR) outputChannelR.set(pcm);
                } else {
                    // 部分可用，填充静音
                    const partial = this._readFromRing(available);
                    outputChannelL.set(partial, 0);
                    outputChannelL.fill(0, available);
                    if (outputChannelR) {
                        outputChannelR.set(partial, 0);
                        outputChannelR.fill(0, available);
                    }
                    // 通知主线程欠载
                    this.port.postMessage({ type: 'underrun', available, needed });
                }
            }
        }

        return true; // 保持处理器存活
    }
}

registerProcessor('voice-worklet', VoiceWorklet);
