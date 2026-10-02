// Downmixes to mono, converts to 16-bit PCM and posts ~0.5 s chunks with their peak level.
class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(8000);
    this.n = 0;
    this.peak = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < input.length; c++) s += input[c][i];
      s /= input.length;
      const a = Math.abs(s);
      if (a > this.peak) this.peak = a;
      this.buf[this.n++] = Math.max(-1, Math.min(1, s)) * 0x7fff;
      if (this.n === this.buf.length) {
        this.port.postMessage({ pcm: this.buf.slice(0), peak: this.peak });
        this.n = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-worklet', PcmWorklet);
