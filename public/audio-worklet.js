// =============================================
// PCM AudioWorklet - 双向音频处理
// 输入: 麦克风捕获 → 主线程编码
// 输出: 主线程解码 → 扬声器播放
// v2.2 抗抖动增强版
// 改进:
//   - 环形缓冲区从 8 帧增大到 20 帧（1200ms 抗抖动）
//   - 预填机制：缓冲区填满 50% 后才开始播放
//   - PLC（丢包隐藏）：欠载时重复最后一帧，而非输出静音
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
        // 20 帧环形缓冲（1200ms @ 60ms/帧），远大于网络抖动
        this._ringBuffer = new Float32Array(this._frameSamples * 20);
        this._ringWrite = 0;
        this._ringRead = 0;
        this._ringSize = this._ringBuffer.length;

        // ---- 预填机制 ----
        this._underrun = true;          // 初始未就绪
        this._prefillThreshold = 0.5;   // 填满 50% 才开始播放
        this._prefillSamples = Math.floor(this._ringSize * this._prefillThreshold);

        // ---- PLC（丢包隐藏） ----
        this._lastFrame = null;         // 最后一帧完整 PCM 数据
        this._plcRepeatCount = 0;       // 当前连续重复次数
        this._plcMaxRepeat = 3;         // 最多连续重复 3 帧（180ms），之后输出静音

        // ---- 状态 ----
        this._frameSeq = 0;

        // 监听主线程消息
        this.port.onmessage = (event) => this._onMessage(event);

        console.log(`[VoiceWorklet] v2.2 Init: ${sampleRate}Hz, ${this._frameSamples}samples/frame, ring=${this._ringSize}samples`);
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

            // 保存最后一帧用于 PLC
            this._lastFrame = new Float32Array(pcm);
            this._plcRepeatCount = 0;

            // 检查是否达到预填阈值
            if (this._underrun && this._getBufferedSamples() >= this._prefillSamples) {
                this._underrun = false;
                console.log(`[VoiceWorklet] Prefill complete: ${this._getBufferedSamples()} samples buffered`);
            }
        }

        if (data.type === 'config') {
            // 更新帧参数（采样率不变，帧长可变）
            if (data.frameDuration) {
                this._frameDuration = data.frameDuration;
                this._frameSamples = Math.floor(this._sampleRate * this._frameDuration);
                // 重新分配环形缓冲区（20 帧容量）
                this._ringBuffer = new Float32Array(this._frameSamples * 20);
                this._ringWrite = 0;
                this._ringRead = 0;
                this._ringSize = this._ringBuffer.length;
                this._prefillSamples = Math.floor(this._ringSize * this._prefillThreshold);
                this._underrun = true;
                this._lastFrame = null;
                this._plcRepeatCount = 0;
                console.log(`[VoiceWorklet] Config updated: frameDuration=${this._frameDuration}s, frameSamples=${this._frameSamples}, ringSize=${this._ringSize}`);
            }
        }

        if (data.type === 'reset') {
            this._ringWrite = 0;
            this._ringRead = 0;
            this._underrun = true;
            this._captureBuffer = [];
            this._lastFrame = null;
            this._plcRepeatCount = 0;
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
     * PLC：生成丢包隐藏数据
     * 重复最后一帧，逐渐衰减振幅避免爆音
     */
    _generatePLC(count) {
        const output = new Float32Array(count);

        if (!this._lastFrame) {
            return output; // 没有历史帧，输出静音
        }

        // 衰减系数：每次重复衰减 30%
        const attenuation = Math.pow(0.7, this._plcRepeatCount);

        // 从最后一帧复制数据并衰减
        for (let i = 0; i < count; i++) {
            const srcIdx = i % this._lastFrame.length;
            output[i] = this._lastFrame[srcIdx] * attenuation;
        }

        this._plcRepeatCount++;

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
            const needed = outputChannelL.length;

            if (this._underrun) {
                // 缓冲区未就绪（预填中），输出静音
                outputChannelL.fill(0);
                if (outputChannelR) outputChannelR.fill(0);
            } else {
                const available = this._getBufferedSamples();

                if (available >= needed) {
                    // 正常播放：从环形缓冲区读取
                    const pcm = this._readFromRing(needed);
                    outputChannelL.set(pcm);
                    if (outputChannelR) outputChannelR.set(pcm);
                } else {
                    // 欠载：使用 PLC 生成数据
                    const pcm = this._generatePLC(needed);

                    // 将 PLC 数据写入输出
                    outputChannelL.set(pcm);
                    if (outputChannelR) outputChannelR.set(pcm);

                    // 如果有部分可用数据，先使用真实数据
                    if (available > 0) {
                        const realData = this._readFromRing(available);
                        outputChannelL.set(realData, 0);
                        if (outputChannelR) outputChannelR.set(realData, 0);
                    }

                    // 通知主线程欠载
                    this.port.postMessage({
                        type: 'underrun',
                        available,
                        needed,
                        plcRepeated: this._plcRepeatCount
                    });

                    // 如果 PLC 连续重复超过最大次数，标记为欠载状态
                    if (this._plcRepeatCount >= this._plcMaxRepeat) {
                        this._underrun = true;
                        console.log(`[VoiceWorklet] PLC max repeats (${this._plcMaxRepeat}) reached, entering underrun state`);
                    }
                }
            }
        }

        return true; // 保持处理器存活
    }
}

registerProcessor('voice-worklet', VoiceWorklet);
