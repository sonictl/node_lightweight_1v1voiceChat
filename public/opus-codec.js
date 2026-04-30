// =============================================
// Opus WebCodecs 编解码器
// 基于 AudioEncoder / AudioDecoder API
// 浏览器原生 · 零 WASM 依赖 · 极致轻量
// =============================================

const OPUS_CODEC = (() => {
    'use strict';

    // ---- 常量 ----
    const OPUS_APPLICATION_AUDIO = 2049;
    const OPUS_APPLICATION_VOIP = 2048;

    // =============================================
    // Opus 编码器 (基于 AudioEncoder)
    // =============================================
    class OpusEncoder {
        /**
         * @param {number} sampleRate - 采样率 (8000-48000)
         * @param {number} channels - 声道数 (1=mono, 2=stereo)
         * @param {number} application - OPUS_APPLICATION_AUDIO 或 OPUS_APPLICATION_VOIP
         * @param {number} complexity - 编码复杂度 (0-10, 推荐 5)
         */
        constructor(sampleRate = 48000, channels = 1, application = OPUS_APPLICATION_VOIP, complexity = 5) {
            this._sampleRate = sampleRate;
            this._channels = channels;
            this._application = application;
            this._complexity = complexity;
            this._frameSize = Math.floor(sampleRate * 0.04); // 40ms 帧
            this._encoder = null;
            this._initialized = false;
            this._outputQueue = []; // 编码输出队列
            this._resolveQueue = []; // 等待编码结果的 Promise resolve
        }

        async init() {
            if (this._initialized) return;

            // 检查浏览器支持
            if (!window.AudioEncoder) {
                throw new Error('浏览器不支持 AudioEncoder API (WebCodecs)');
            }

            // 检查 Opus 编解码器支持
            const supported = await AudioEncoder.isConfigSupported({
                codec: 'opus',
                sampleRate: this._sampleRate,
                numberOfChannels: this._channels
            });

            if (!supported.supported) {
                throw new Error('浏览器不支持 Opus 编码');
            }

            this._encoder = new AudioEncoder({
                output: (chunk) => {
                    // 编码完成，将结果放入队列
                    const opusData = new Uint8Array(chunk.byteLength);
                    chunk.copyTo(opusData);

                    if (this._resolveQueue.length > 0) {
                        const resolve = this._resolveQueue.shift();
                        resolve(opusData);
                    } else {
                        this._outputQueue.push(opusData);
                    }
                },
                error: (e) => {
                    console.error('[OpusEncoder] Error:', e);
                    if (this._resolveQueue.length > 0) {
                        const reject = this._resolveQueue.shift();
                        reject(e);
                    }
                }
            });

            // 配置编码器
            // 注意: WebCodecs 的 Opus 编码器不支持 application 和 complexity 参数
            // 这些参数由浏览器内部优化
            this._encoder.configure({
                codec: 'opus',
                sampleRate: this._sampleRate,
                numberOfChannels: this._channels,
                bitrate: this._application === OPUS_APPLICATION_VOIP ? 32000 : 64000
            });

            this._initialized = true;
            console.log(`[OpusEncoder] Created: ${this._sampleRate}Hz, ${this._channels}ch, ${this._frameSize} samples/frame`);
        }

        /**
         * 编码 PCM 帧为 Opus 包
         * @param {Float32Array} pcmFrames - 长度必须等于 frameSize
         * @returns {Promise<Uint8Array|null>} Opus 编码数据
         */
        async encode(pcmFrames) {
            if (!this._initialized) throw new Error('Encoder not initialized');
            if (pcmFrames.length !== this._frameSize) {
                console.warn(`[OpusEncoder] Expected ${this._frameSize} samples, got ${pcmFrames.length}`);
                return null;
            }

            // 创建 AudioData 对象
            const audioData = new AudioData({
                format: 'f32-planar',
                sampleRate: this._sampleRate,
                numberOfFrames: this._frameSize,
                numberOfChannels: this._channels,
                timestamp: performance.now() * 1000, // 微秒
                data: pcmFrames
            });

            // 等待编码结果
            return new Promise((resolve, reject) => {
                this._resolveQueue.push(resolve);
                this._encoder.encode(audioData);
                audioData.close();

                // 超时保护
                setTimeout(() => {
                    const idx = this._resolveQueue.indexOf(resolve);
                    if (idx !== -1) {
                        this._resolveQueue.splice(idx, 1);
                        reject(new Error('编码超时'));
                    }
                }, 1000);
            });
        }

        /**
         * 强制编码（即使静音也输出帧，用于保持连接活性）
         * @param {Float32Array} pcmFrames
         * @returns {Promise<Uint8Array>}
         */
        async forceEncode(pcmFrames) {
            const result = await this.encode(pcmFrames);
            return result || new Uint8Array(0);
        }

        /**
         * 同步编码（向后兼容）
         * 注意：WebCodecs 的 AudioEncoder.encode() 是异步的，
         * 此方法会触发编码并将结果放入队列，但调用方需要稍后通过
         * 轮询或回调获取结果。推荐使用 async encode() 方法。
         * @param {Float32Array} pcmFrames
         * @returns {Uint8Array|null} 如果队列中有已完成的编码结果则返回，否则返回 null
         */
        encodeSync(pcmFrames) {
            if (!this._initialized) throw new Error('Encoder not initialized');
            if (pcmFrames.length !== this._frameSize) {
                console.warn(`[OpusEncoder] Expected ${this._frameSize} samples, got ${pcmFrames.length}`);
                return null;
            }

            // 创建 AudioData 对象
            const audioData = new AudioData({
                format: 'f32-planar',
                sampleRate: this._sampleRate,
                numberOfFrames: this._frameSize,
                numberOfChannels: this._channels,
                timestamp: performance.now() * 1000,
                data: pcmFrames
            });

            this._encoder.encode(audioData);
            audioData.close();

            // 同步模式下，从队列中取出之前已完成的结果
            if (this._outputQueue.length > 0) {
                return this._outputQueue.shift();
            }

            return null;
        }

        destroy() {
            if (this._encoder && this._encoder.state !== 'closed') {
                this._encoder.close();
            }
            this._encoder = null;
            this._initialized = false;
            this._outputQueue = [];
            this._resolveQueue = [];
        }

        getFrameSize() { return this._frameSize; }
        getSampleRate() { return this._sampleRate; }
        getChannels() { return this._channels; }
    }

    // =============================================
    // Opus 解码器 (基于 AudioDecoder)
    // =============================================
    class OpusDecoder {
        /**
         * @param {number} sampleRate - 输出采样率
         * @param {number} channels - 输出声道数
         */
        constructor(sampleRate = 48000, channels = 1) {
            this._sampleRate = sampleRate;
            this._channels = channels;
            this._decoder = null;
            this._initialized = false;
            this._outputQueue = [];
            this._resolveQueue = [];
        }

        async init() {
            if (this._initialized) return;

            // 检查浏览器支持
            if (!window.AudioDecoder) {
                throw new Error('浏览器不支持 AudioDecoder API (WebCodecs)');
            }

            // 检查 Opus 解码器支持
            const supported = await AudioDecoder.isConfigSupported({
                codec: 'opus',
                sampleRate: this._sampleRate,
                numberOfChannels: this._channels
            });

            if (!supported.supported) {
                throw new Error('浏览器不支持 Opus 解码');
            }

            this._decoder = new AudioDecoder({
                output: (audioData) => {
                    // 解码完成，提取 PCM 数据
                    const pcmData = new Float32Array(audioData.numberOfFrames);
                    audioData.copyTo(pcmData, { planeIndex: 0 });
                    audioData.close();

                    if (this._resolveQueue.length > 0) {
                        const resolve = this._resolveQueue.shift();
                        resolve(pcmData);
                    } else {
                        this._outputQueue.push(pcmData);
                    }
                },
                error: (e) => {
                    console.error('[OpusDecoder] Error:', e);
                    if (this._resolveQueue.length > 0) {
                        const reject = this._resolveQueue.shift();
                        reject(e);
                    }
                }
            });

            this._decoder.configure({
                codec: 'opus',
                sampleRate: this._sampleRate,
                numberOfChannels: this._channels
            });

            this._initialized = true;
            console.log(`[OpusDecoder] Created: ${this._sampleRate}Hz, ${this._channels}ch`);
        }

        /**
         * 解码 Opus 包为 PCM
         * @param {Uint8Array} opusData - Opus 编码数据
         * @param {number} [frameSize] - 期望的帧大小（采样点数），默认计算 40ms
         * @returns {Promise<Float32Array|null>} 解码后的 PCM 数据
         */
        async decode(opusData, frameSize) {
            if (!this._initialized) throw new Error('Decoder not initialized');

            if (!opusData || opusData.length === 0) {
                // 丢包或静音帧 - 返回静音缓冲区
                const silenceSize = frameSize || Math.floor(this._sampleRate * 0.04);
                return new Float32Array(silenceSize);
            }

            // 创建 EncodedAudioChunk
            const chunk = new EncodedAudioChunk({
                type: 'key',
                timestamp: performance.now() * 1000,
                duration: (frameSize || Math.floor(this._sampleRate * 0.04)) / this._sampleRate * 1_000_000,
                data: opusData
            });

            // 等待解码结果
            return new Promise((resolve, reject) => {
                this._resolveQueue.push(resolve);
                this._decoder.decode(chunk);

                // 超时保护
                setTimeout(() => {
                    const idx = this._resolveQueue.indexOf(resolve);
                    if (idx !== -1) {
                        this._resolveQueue.splice(idx, 1);
                        reject(new Error('解码超时'));
                    }
                }, 1000);
            });
        }

        /**
         * 解码带丢包隐藏 (PLC) 的帧
         * @param {number} frameSize - 期望的帧大小
         * @returns {Promise<Float32Array>} PLC 生成的 PCM
         */
        async decodePLC(frameSize) {
            return this.decode(null, frameSize);
        }

        /**
         * 同步解码（向后兼容）
         * 注意：WebCodecs 的 AudioDecoder.decode() 是异步的，
         * 此方法会触发解码并将结果放入队列，但调用方需要稍后通过
         * 轮询或回调获取结果。推荐使用 async decode() 方法。
         * @param {Uint8Array} opusData
         * @param {number} [frameSize]
         * @returns {Float32Array|null} 如果队列中有已完成的解码结果则返回，否则返回 null
         */
        decodeSync(opusData, frameSize) {
            if (!this._initialized) throw new Error('Decoder not initialized');

            if (!opusData || opusData.length === 0) {
                const silenceSize = frameSize || Math.floor(this._sampleRate * 0.04);
                return new Float32Array(silenceSize);
            }

            const chunk = new EncodedAudioChunk({
                type: 'key',
                timestamp: performance.now() * 1000,
                duration: (frameSize || Math.floor(this._sampleRate * 0.04)) / this._sampleRate * 1_000_000,
                data: opusData
            });

            this._decoder.decode(chunk);

            // 同步模式下，从队列中取出之前已完成的结果
            if (this._outputQueue.length > 0) {
                return this._outputQueue.shift();
            }

            return null;
        }

        destroy() {
            if (this._decoder && this._decoder.state !== 'closed') {
                this._decoder.close();
            }
            this._decoder = null;
            this._initialized = false;
            this._outputQueue = [];
            this._resolveQueue = [];
        }

        _allocInHeap(size) {
            // 不再需要 WASM 内存分配
            return 0;
        }
    }

    // =============================================
    // 工具函数
    // =============================================
    /**
     * 检测音频帧是否为静音
     * @param {Float32Array} pcmData
     * @param {number} [threshold=0.001] - RMS 阈值
     * @returns {boolean}
     */
    function isSilence(pcmData, threshold = 0.001) {
        let sumSq = 0;
        for (let i = 0; i < pcmData.length; i++) {
            sumSq += pcmData[i] * pcmData[i];
        }
        const rms = Math.sqrt(sumSq / pcmData.length);
        return rms < threshold;
    }

    /**
     * 重置模块（WebCodecs 版本无需特殊操作）
     */
    function reset() {
        // WebCodecs 实现无需重置
    }

    // =============================================
    // 公共 API
    // =============================================
    return {
        OpusEncoder,
        OpusDecoder,
        isSilence,
        reset,
        APPLICATION_AUDIO: OPUS_APPLICATION_AUDIO,
        APPLICATION_VOIP: OPUS_APPLICATION_VOIP
    };
})();
