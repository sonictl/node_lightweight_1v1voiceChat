// PCM 采集 Worklet
class PCMCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = [];
    }
    
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0]) return true;
        
        const channelData = input[0];
        
        // 累积数据直到帧长达到 40ms
        this.buffer.push(...channelData);
        const frameSamples = sampleRate * 0.04;  // 40ms 的采样点数 (8kHz = 320)
        
        if (this.buffer.length >= frameSamples) {
            const frame = new Float32Array(this.buffer.slice(0, frameSamples));
            this.buffer = this.buffer.slice(frameSamples);
            this.port.postMessage(frame);
        }
        
        return true;
    }
}

registerProcessor('pcm-capture', PCMCapture);