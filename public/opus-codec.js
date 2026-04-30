// =============================================
// Opus WASM 编解码器
// 极致轻量 · 原生性能 · 共享 WASM 实例
// =============================================

const OPUS_CODEC = (() => {
    'use strict';

    // ---- 常量 ----
    const OPUS_APPLICATION_AUDIO = 2049;
    const OPUS_APPLICATION_VOIP = 2048;
    const OPUS_OK = 0;

    // WASM 加载状态
    let wasmInstance = null;
    let wasmModule = null;
    let wasmMemory = null;
    let initPromise = null;

    // ---- WASM 加载 ----
    const WASM_URLS = [
        '/opus.wasm',                                               // 本地优先
        'https://unpkg.com/opus-wasm@latest/dist/opus.wasm',       // unpkg CDN
        'https://cdn.jsdelivr.net/npm/opus-wasm@latest/dist/opus.wasm' // jsDelivr CDN
    ];

    async function loadWasm() {
        if (wasmInstance) return;

        // 尝试所有 URL
        for (const url of WASM_URLS) {
            try {
                const response = await fetch(url);
                if (!response.ok) continue;
                const wasmBytes = await response.arrayBuffer();
                const result = await WebAssembly.instantiate(wasmBytes, {
                    env: {
                        memoryBase: 0,
                        tableBase: 0,
                        memory: new WebAssembly.Memory({ initial: 256, maximum: 512 }),
                        table: new WebAssembly.Table({ initial: 0, maximum: 0, element: 'anyfunc' }),
                        abort: (msg) => { throw new Error(`WASM abort: ${msg}`); }
                    },
                    'wasi_snapshot_preview1': {
                        fd_write: () => OPUS_OK,
                        fd_close: () => OPUS_OK,
                        proc_exit: () => {}
                    }
                });

                wasmInstance = result.instance;
                wasmModule = result.module;
                wasmMemory = result.instance.exports.memory ||
                    result.instance.exports.memory || 
                    new WebAssembly.Memory({ initial: 256 });

                console.log(`[OpusWASM] Loaded from ${url}`);
                return;
            } catch (e) {
                console.warn(`[OpusWASM] Failed to load from ${url}: ${e.message}`);
            }
        }

        throw new Error('Failed to load opus.wasm from all sources. ' +
            'Place opus.wasm in the public/ directory, or check network connectivity.');
    }

    // ---- 共享 WASM 初始化 ----
    async function ensureWasm() {
        if (wasmInstance) return;
        if (initPromise) return initPromise;
        initPromise = loadWasm();
        return initPromise;
    }

    // =============================================
    // Opus 编码器
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
            this._frameSize = Math.floor(sampleRate * 0.04); // 40ms 帧
            this._encoderPtr = 0;
            this._initialized = false;
        }

        async init() {
            if (this._initialized) return;
            await ensureWasm();

            const exports = wasmInstance.exports;

            // 创建编码器
            let errorPtr = exports.malloc ? exports.malloc(4) : 0;
            const encoderPtr = exports.opus_encoder_create(
                this._sampleRate, this._channels, application, errorPtr
            );

            if (errorPtr) {
                const errorView = new Int32Array(wasmMemory.buffer);
                if (errorView[errorPtr / 4] !== OPUS_OK) {
                    throw new Error(`Opus encoder creation failed: error ${errorView[errorPtr / 4]}`);
                }
            }

            if (!encoderPtr) {
                throw new Error('Opus encoder creation returned null');
            }

            this._encoderPtr = encoderPtr;
            this._initialized = true;

            // 设置编码复杂度
            if (exports.opus_encoder_ctl) {
                // OPUS_SET_COMPLEXITY_REQUEST = 4002
                exports.opus_encoder_ctl(encoderPtr, 4002, complexity);
            }

            // 设置 DTX (静音检测)
            if (exports.opus_encoder_ctl) {
                // OPUS_SET_DTX_REQUEST = 4016
                exports.opus_encoder_ctl(encoderPtr, 4016, 1);
            }

            // 设置 FEC (前向纠错)
            if (exports.opus_encoder_ctl) {
                // OPUS_SET_INBAND_FEC_REQUEST = 4014
                exports.opus_encoder_ctl(encoderPtr, 4014, 1);
            }

            // 设置最大码率 32kbps
            if (exports.opus_encoder_ctl) {
                // OPUS_SET_BITRATE_REQUEST = 4006
                exports.opus_encoder_ctl(encoderPtr, 4006, 32000);
            }

            console.log(`[OpusEncoder] Created: ${this._sampleRate}Hz, ${this._channels}ch, ${this._frameSize} samples/frame`);
        }

        /**
         * 编码 PCM 帧为 Opus 包
         * @param {Float32Array} pcmFrames - 长度必须等于 frameSize
         * @returns {Uint8Array|null} Opus 编码数据，静音帧返回 null
         */
        encode(pcmFrames) {
            if (!this._initialized) throw new Error('Encoder not initialized');
            if (pcmFrames.length !== this._frameSize) {
                console.warn(`[OpusEncoder] Expected ${this._frameSize} samples, got ${pcmFrames.length}`);
                return null;
            }

            const exports = wasmInstance.exports;

            // 分配 WASM 内存
            const inputSize = pcmFrames.length * 4; // Float32
            const maxOutputSize = 4000; // 最大 Opus 帧 4000 字节
            const inputPtr = exports.malloc ? exports.malloc(inputSize) : this._allocInHeap(inputSize);
            const outputPtr = exports.malloc ? exports.malloc(maxOutputSize) : this._allocInHeap(maxOutputSize);

            if (!inputPtr || !outputPtr) {
                console.error('[OpusEncoder] WASM memory allocation failed');
                return null;
            }

            try {
                // 写入 PCM 数据
                const inputView = new Float32Array(wasmMemory.buffer, inputPtr, this._frameSize);
                inputView.set(pcmFrames);

                // 编码
                const encodedBytes = exports.opus_encode_float(
                    this._encoderPtr,
                    inputPtr,
                    this._frameSize,
                    outputPtr,
                    maxOutputSize
                );

                if (encodedBytes <= 0) {
                    return null; // 静音或错误
                }

                // 读取编码结果
                const result = new Uint8Array(wasmMemory.buffer, outputPtr, encodedBytes);
                return new Uint8Array(result);
            } finally {
                // 释放 WASM 内存
                if (exports.free) {
                    exports.free(inputPtr);
                    exports.free(outputPtr);
                }
            }
        }

        /**
         * 强制编码（即使静音也输出帧，用于保持连接活性）
         * @param {Float32Array} pcmFrames
         * @returns {Uint8Array}
         */
        forceEncode(pcmFrames) {
            const result = this.encode(pcmFrames);
            return result || new Uint8Array(0); // 返回空数组表示静音帧
        }

        destroy() {
            if (this._initialized && this._encoderPtr) {
                const exports = wasmInstance.exports;
                if (exports.opus_encoder_destroy) {
                    exports.opus_encoder_destroy(this._encoderPtr);
                }
                this._encoderPtr = 0;
                this._initialized = false;
            }
        }

        getFrameSize() { return this._frameSize; }
        getSampleRate() { return this._sampleRate; }
        getChannels() { return this._channels; }

        // 在 exports.malloc/free 不可用时的回退分配
        _allocInHeap(size) {
            // 简单的堆分配 - 从已知地址开始
            if (!this._heapOffset) {
                this._heapOffset = 1024 * 1024; // 从 1MB 偏移开始
            }
            const ptr = this._heapOffset;
            this._heapOffset += size;
            return ptr;
        }
    }

    // =============================================
    // Opus 解码器
    // =============================================
    class OpusDecoder {
        /**
         * @param {number} sampleRate - 输出采样率
         * @param {number} channels - 输出声道数
         */
        constructor(sampleRate = 48000, channels = 1) {
            this._sampleRate = sampleRate;
            this._channels = channels;
            this._decoderPtr = 0;
            this._initialized = false;
        }

        async init() {
            if (this._initialized) return;
            await ensureWasm();

            const exports = wasmInstance.exports;

            // 创建解码器
            let errorPtr = exports.malloc ? exports.malloc(4) : 0;
            const decoderPtr = exports.opus_decoder_create(
                this._sampleRate, this._channels, errorPtr
            );

            if (errorPtr) {
                const errorView = new Int32Array(wasmMemory.buffer);
                if (errorView[errorPtr / 4] !== OPUS_OK) {
                    throw new Error(`Opus decoder creation failed: error ${errorView[errorPtr / 4]}`);
                }
            }

            if (!decoderPtr) {
                throw new Error('Opus decoder creation returned null');
            }

            this._decoderPtr = decoderPtr;
            this._initialized = true;

            console.log(`[OpusDecoder] Created: ${this._sampleRate}Hz, ${this._channels}ch`);
        }

        /**
         * 解码 Opus 包为 PCM
         * @param {Uint8Array} opusData - Opus 编码数据
         * @param {number} [frameSize] - 期望的帧大小（采样点数），默认计算 40ms
         * @returns {Float32Array|null} 解码后的 PCM 数据
         */
        decode(opusData, frameSize) {
            if (!this._initialized) throw new Error('Decoder not initialized');
            if (!opusData || opusData.length === 0) {
                // 丢包或静音帧 - 返回静音缓冲区
                const silenceSize = frameSize || Math.floor(this._sampleRate * 0.04);
                return new Float32Array(silenceSize);
            }

            const exports = wasmInstance.exports;
            const maxFrameSize = frameSize || Math.floor(this._sampleRate * 0.06); // 60ms 最大

            // 分配 WASM 内存
            const inputSize = opusData.length;
            const outputSize = maxFrameSize * 4; // Float32
            const inputPtr = exports.malloc ? exports.malloc(inputSize) : this._allocInHeap(inputSize);
            const outputPtr = exports.malloc ? exports.malloc(outputSize) : this._allocInHeap(outputSize);

            if (!inputPtr || !outputPtr) {
                console.error('[OpusDecoder] WASM memory allocation failed');
                return new Float32Array(maxFrameSize);
            }

            try {
                // 写入 Opus 数据
                const inputView = new Uint8Array(wasmMemory.buffer, inputPtr, inputSize);
                inputView.set(opusData);

                // 解码
                const decodedSamples = exports.opus_decode_float(
                    this._decoderPtr,
                    inputPtr,
                    inputSize,
                    outputPtr,
                    maxFrameSize,
                    0 // 无 FEC
                );

                if (decodedSamples <= 0) {
                    return new Float32Array(maxFrameSize); // 静音
                }

                // 读取解码结果
                const result = new Float32Array(wasmMemory.buffer, outputPtr, decodedSamples * this._channels);
                return new Float32Array(result);
            } finally {
                if (exports.free) {
                    exports.free(inputPtr);
                    exports.free(outputPtr);
                }
            }
        }

        /**
         * 解码带丢包隐藏 (PLC) 的帧
         * @param {number} frameSize - 期望的帧大小
         * @returns {Float32Array} PLC 生成的 PCM
         */
        decodePLC(frameSize) {
            return this.decode(null, frameSize);
        }

        destroy() {
            if (this._initialized && this._decoderPtr) {
                const exports = wasmInstance.exports;
                if (exports.opus_decoder_destroy) {
                    exports.opus_decoder_destroy(this._decoderPtr);
                }
                this._decoderPtr = 0;
                this._initialized = false;
            }
        }

        _allocInHeap(size) {
            if (!this._heapOffset) {
                this._heapOffset = 1024 * 1024;
            }
            const ptr = this._heapOffset;
            this._heapOffset += size;
            return ptr;
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
     * 重置 WASM 模块（允许重新加载）
     */
    function reset() {
        wasmInstance = null;
        wasmModule = null;
        wasmMemory = null;
        initPromise = null;
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
