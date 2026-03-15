/* PCM Processor — AudioWorklet (runs in dedicated audio thread)
 * Converts Float32Array (AudioWorklet native) → Int16Array (PCM 16kHz)
 * Uses transferable buffer (no copy) for performance.
 * Must be registered as 'pcm-processor'. */

class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0]  // Float32Array from mic
    if (!input || input.length === 0) return true

    const pcm = new Int16Array(input.length)
    for (let i = 0; i < input.length; i++) {
      // Clamp Float32 [-1, 1] → Int16 [-32768, 32767]
      pcm[i] = Math.max(-32768, Math.min(32767, input[i] * 32768))
    }

    // Transfer buffer — zero-copy pass to main thread
    this.port.postMessage(pcm.buffer, [pcm.buffer])
    return true  // keep processor alive
  }
}

registerProcessor('pcm-processor', PCMProcessor)
