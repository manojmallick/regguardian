// RegGuardian — Frontend Main JS
// Audio capture, screen capture, SSE listener, ARIA voice, persona badge

const ARIA_PERSONAS = {
  ENGINEER:   { label: 'Engineering Mode', color: '#06b6d4' },
  COMPLIANCE: { label: 'Compliance Mode',  color: '#8b5cf6' },
  EXECUTIVE:  { label: 'Executive Mode',   color: '#f59e0b' },
  UNKNOWN:    { label: 'Standby Mode',     color: '#9ba3b8' }
}

let incidentId = null
let audioWs    = null
let screenWs   = null
let eventSource = null
let audioCtx   = null
let audioStream = null
let screenInterval = null
let doraStartTime  = null
let doraInterval   = null

// ─── Incident Management ─────────────────────────────────────────────────────

window.startIncident = async function () {
  const title = document.getElementById('incident-title').value.trim() || 'Unnamed Incident'
  const description = document.getElementById('incident-desc').value.trim()

  try {
    const res = await fetch('/api/incidents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description })
    })
    const data = await res.json()
    incidentId = data.incidentId

    document.getElementById('incident-id-display').textContent = incidentId
    document.getElementById('incident-meta').classList.remove('hidden')
    document.getElementById('incident-active-controls').classList.remove('hidden')
    document.getElementById('btn-start').classList.add('hidden')
    document.getElementById('btn-export')?.classList.remove('hidden')
    document.getElementById('btn-demo-pipeline')?.classList.remove('hidden')

    setAriaStatus('active', 'ARIA ACTIVE')
    connectSSE()
    addTranscriptEntry({
      speakerRole: 'ARIA',
      ariaResponse: `Incident ${incidentId} created. Start audio and share screen to begin monitoring.`,
      timestamp: Date.now()
    })
  } catch (err) {
    console.error('Failed to create incident', err)
    addSystemMessage('Failed to create incident: ' + err.message)
  }
}

// ─── Audio Capture ────────────────────────────────────────────────────────────

let isAudioActive = false
let analyserNode  = null

window.toggleAudio = async function () {
  const btn = document.getElementById('btn-audio')

  if (isAudioActive) {
    stopAudio()
    btn.textContent = '🎙️ Start Listening'
    btn.classList.remove('active')
    setAudioStatus('off', 'OFF')
    document.getElementById('audio-meter-container').classList.add('hidden')
    setAriaStatus('active', 'ARIA ACTIVE')
    return
  }

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
    })

    audioCtx = new AudioContext({ sampleRate: 16000 })
    await audioCtx.audioWorklet.addModule('/audio-processor.js')

    const worklet = new AudioWorkletNode(audioCtx, 'pcm-processor')
    analyserNode = audioCtx.createAnalyser()
    analyserNode.fftSize = 256

    const source = audioCtx.createMediaStreamSource(audioStream)
    source.connect(analyserNode)
    source.connect(worklet)

    audioWs = new WebSocket(`${wsBase()}/ws/audio?incidentId=${incidentId}`)
    audioWs.binaryType = 'arraybuffer'

    audioWs.onopen = () => {
      isAudioActive = true
      btn.textContent = '🛑 Stop Listening'
      btn.classList.add('active')
      setAudioStatus('ok', 'LIVE')
      setAriaStatus('listening', 'ARIA LISTENING')
      document.getElementById('audio-meter-container').classList.remove('hidden')
      startAudioMeter()
    }

    worklet.port.onmessage = (e) => {
      if (audioWs?.readyState === WebSocket.OPEN) {
        audioWs.send(e.data)
      }
    }

    // Barge-in detection (voice activity)
    audioWs.onmessage = () => showBargeBadge()

    audioWs.onclose = () => {
      isAudioActive = false
      setAudioStatus('off', 'OFF')
    }
  } catch (err) {
    console.error('Audio capture failed', err)
    addSystemMessage('Microphone access denied or unavailable.')
  }
}

function stopAudio() {
  audioStream?.getTracks().forEach(t => t.stop())
  audioWs?.close()
  audioCtx?.close()
  isAudioActive = false
}

let meterRaf = null
function startAudioMeter() {
  const bar = document.getElementById('audio-bar')
  const data = new Uint8Array(analyserNode.frequencyBinCount)

  function update() {
    analyserNode.getByteFrequencyData(data)
    const avg = data.reduce((a, b) => a + b, 0) / data.length
    const pct = Math.min(100, (avg / 128) * 100 * 2)
    bar.style.width = pct + '%'
    meterRaf = requestAnimationFrame(update)
  }
  update()
}

// ─── Screen Capture ───────────────────────────────────────────────────────────

window.startScreen = async function () {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 1 } },
      audio: false
    })

    screenWs = new WebSocket(`${wsBase()}/ws/screen?incidentId=${incidentId}`)
    screenWs.binaryType = 'arraybuffer'

    const video = document.createElement('video')
    const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 })
    const ctx = canvas.getContext('2d')
    video.srcObject = stream
    video.play()

    screenWs.onopen = () => {
      setVisionStatus('ok', 'LIVE')
      screenInterval = setInterval(() => {
        if (screenWs?.readyState !== WebSocket.OPEN) return
        ctx.drawImage(video, 0, 0, 1280, 720)
        canvas.toBlob(async (blob) => {
          if (blob) screenWs.send(await blob.arrayBuffer())
        }, 'image/png')
      }, 5000)
    }

    stream.getVideoTracks()[0].onended = () => {
      clearInterval(screenInterval)
      screenWs?.close()
      setVisionStatus('off', 'OFF')
    }
  } catch (err) {
    console.error('Screen capture failed', err)
    addSystemMessage('Screen share cancelled or unavailable.')
  }
}

// ─── SSE Connection ───────────────────────────────────────────────────────────

function connectSSE() {
  eventSource = new EventSource(`/api/incidents/${incidentId}/report/stream`)

  eventSource.onopen = () => {
    setSseStatus('ok', 'Connected')
  }

  eventSource.addEventListener('report_section', (e) => {
    const section = JSON.parse(e.data)
    updateReportSection(section)
  })

  eventSource.addEventListener('aria_voice', (e) => {
    const { text, persona, rawQuote, doraTrigger } = JSON.parse(e.data)
    
    // Live DORA trigger from transcript
    if (doraTrigger) {
      startDoraClock()
      setDoraStatus('err', 'TRIGGERED')
    }

    // Demo script barge-in badge trigger
    if (rawQuote && /wait|no|stop|threshold|interrupted/i.test(rawQuote)) {
      showBargeBadge()
      // If we got a barge-in, we usually stop the current speech output:
      window.speechSynthesis?.cancel()
    }

    if (text) speakARIA(text, persona)
    updatePersonaBadge(persona)
    
    // Determine the user's role if a raw quote is provided, default to the ARIA response persona
    const speakerRole = (rawQuote && persona === 'UNKNOWN') ? 'ENGINEER' : persona
    
    addTranscriptEntry({ 
      speakerRole: speakerRole, 
      ariaResponse: text, 
      rawQuote: rawQuote, 
      persona: persona, 
      timestamp: Date.now() 
    })
  })

  eventSource.addEventListener('incident_complete', () => {
    eventSource.close()
    setSseStatus('warn', 'Resolved')
    addSystemMessage('Incident resolved. Final report saved.')
  })

  eventSource.onerror = () => {
    setSseStatus('off', 'Disconnected')
  }
}

// ─── Report Sections ──────────────────────────────────────────────────────────

const visibleSections = new Set()

/**
 * Lightweight markdown → safe HTML converter.
 * Handles: **bold**, `code`, *italic*, bullet lines, section headers (##), newlines.
 * No external library needed — avoids XSS by escaping first, then injecting known-safe tags.
 */
function mdToHtml(text) {
  // 1. Escape HTML entities first (XSS safety)
  let h = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // 2. Strip any ## Section headers Gemini sometimes adds inside content
  h = h.replace(/^####?\s.+$/gm, '')
  // 3. Bold
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // 4. Code spans
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>')
  // 5. Italic
  h = h.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  // 6. Bullet points (*, -)
  h = h.replace(/^[*\-]\s+(.+)$/gm, '<li>$1</li>')
  h = h.replace(/((<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
  // 7. Newlines → paragraphs (skip blank lines → paragraph breaks)
  h = h.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
        .map(p => p.startsWith('<ul>') || p.startsWith('<li>') ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`)
        .join('')
  return h
}

function updateReportSection(section) {
  const { sectionId, content, confidence } = section
  const container = document.getElementById(`sec-${sectionId}`)
  if (!container) return

  const placeholder = document.querySelector('.section-placeholder')
  if (placeholder) placeholder.style.display = 'none'

  container.classList.remove('hidden')
  container.querySelector('.section-content').innerHTML = mdToHtml(content)

  // Add confidence bar
  let bar = container.querySelector('.confidence-bar')
  if (!bar) {
    bar = document.createElement('div')
    bar.className = 'confidence-bar'
    const fill = document.createElement('div')
    fill.className = 'confidence-fill'
    bar.appendChild(fill)
    container.querySelector('.section-content').appendChild(bar)
  }
  bar.querySelector('.confidence-fill').style.width = (confidence * 100) + '%'

  if (!visibleSections.has(sectionId)) {
    visibleSections.add(sectionId)
  }

  // Check if REGULATORY section contains DORA trigger
  if (sectionId === 'REGULATORY' && content.toLowerCase().includes('art. 11.1(a)')) {
    startDoraClock()
    setDoraStatus('err', 'TRIGGERED')
  }
}

// ─── DORA Clock ───────────────────────────────────────────────────────────────

function startDoraClock() {
  if (doraStartTime) return  // already running
  doraStartTime = Date.now()
  const deadline = 4 * 60 * 60 * 1000  // 4 hours in ms

  const clock = document.getElementById('dora-clock')
  const timer = document.getElementById('dora-timer')
  clock.classList.remove('hidden')

  doraInterval = setInterval(() => {
    const remaining = deadline - (Date.now() - doraStartTime)
    if (remaining <= 0) {
      timer.textContent = 'DEADLINE PASSED'
      clock.classList.add('urgent')
      clearInterval(doraInterval)
      return
    }
    const h = Math.floor(remaining / 3600000)
    const m = Math.floor((remaining % 3600000) / 60000)
    const s = Math.floor((remaining % 60000) / 1000)
    timer.textContent = `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    if (remaining < 30 * 60 * 1000) clock.classList.add('urgent')
  }, 1000)
}

// ─── ARIA Voice ───────────────────────────────────────────────────────────────

function speakARIA(text, persona) {
  if (!window.speechSynthesis || !text) return
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.rate  = 0.95
  utterance.pitch = 0.9
  speechSynthesis.speak(utterance)

  // Barge-in: cancel if user speaks
  utterance.onboundary = () => {
    if (isAudioActive) {
      // Gemini Live handles barge-in internally; just show the badge
    }
  }
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function setAriaStatus(state, text) {
  const el = document.getElementById('aria-status')
  el.className = `aria-status aria-${state}`
  document.getElementById('aria-status-text').textContent = text
}

function updatePersonaBadge(persona) {
  const badge = document.getElementById('persona-badge')
  const config = ARIA_PERSONAS[persona] || ARIA_PERSONAS.UNKNOWN
  badge.textContent = config.label
  badge.style.color = config.color
  badge.style.borderColor = config.color
  badge.classList.remove('hidden')
}

let bargeTimeout = null
function showBargeBadge() {
  const badge = document.getElementById('barge-badge')
  badge.classList.remove('hidden')
  clearTimeout(bargeTimeout)
  bargeTimeout = setTimeout(() => badge.classList.add('hidden'), 2000)
}

function addTranscriptEntry(event) {
  const feed = document.getElementById('transcript-feed')
  const placeholder = feed.querySelector('.transcript-placeholder')
  if (placeholder) placeholder.remove()

  const entry = document.createElement('div')
  const isAria = event.speakerRole === 'ARIA'
  entry.className = `transcript-entry${isAria ? ' aria-entry' : ''}`

  const time = new Date(event.timestamp || Date.now()).toLocaleTimeString()
  const speaker = event.speakerRole || 'UNKNOWN'

  entry.innerHTML = `
    <div class="entry-header">
      <span class="entry-speaker speaker-${speaker}">${speaker}</span>
      ${event.severity ? `<span class="entry-severity severity-${event.severity}">${event.severity}</span>` : ''}
      <span class="entry-time">${time}</span>
    </div>
    ${event.rawQuote ? `<div class="entry-text">${escapeHtml(event.rawQuote)}</div>` : ''}
    ${event.ariaResponse ? `<div class="entry-aria">ARIA: ${escapeHtml(event.ariaResponse)}</div>` : ''}
  `
  feed.appendChild(entry)
  feed.scrollTop = feed.scrollHeight
}

function addSystemMessage(msg) {
  addTranscriptEntry({ speakerRole: 'ARIA', ariaResponse: msg, timestamp: Date.now() })
}

function setAudioStatus(state, text) {
  const el = document.getElementById('audio-status')
  el.className = `status-value status-${state}`
  el.textContent = text
}

function setVisionStatus(state, text) {
  const el = document.getElementById('vision-status')
  el.className = `status-value status-${state}`
  el.textContent = text
}

function setSseStatus(state, text) {
  const el = document.getElementById('sse-status')
  el.className = `status-value status-${state}`
  el.textContent = text
}

function setDoraStatus(state, text) {
  const el = document.getElementById('dora-status')
  el.className = `status-value status-${state}`
  el.textContent = text
}

function updateSeverityBadge(severity) {
  const badge = document.getElementById('severity-badge')
  badge.className = `severity-badge severity-${severity}`
  badge.textContent = severity
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function wsBase() {
  return location.protocol === 'https:' ? `wss://${location.host}` : `ws://${location.host}`
}

// ─── Stop Incident ────────────────────────────────────────────────────────────

window.stopIncident = function () {
  stopAudio()
  clearInterval(screenInterval)
  screenWs?.close()
  eventSource?.close()
  clearInterval(doraInterval)
  setAriaStatus('idle', 'ARIA IDLE')
  setAudioStatus('off', 'OFF')
  setVisionStatus('off', 'OFF')
  setSseStatus('off', 'Disconnected')
  addSystemMessage('ARIA stopped. Incident monitoring ended.')
}

// ─── One-Click Demo (Synthetic P1 Replay) ────────────────────────────────────

const DEMO_TRANSCRIPT = [
  { delay: 800,  role: 'ENGINEER', text: 'payment-gateway-v2 is throwing 503s across all regions. Started at 22:51 UTC.' },
  { delay: 2500, role: 'ENGINEER', text: 'postgres-primary connection pool is exhausted — showing 500/500 connections.' },
  { delay: 4500, role: 'ENGINEER', text: 'CPU on payment-gateway-v2 is at 94.7%. Error rate is 18% and climbing.' },
  { delay: 6500, role: 'ENGINEER', text: 'This is a P1. 73,000 active users in EMEA can\'t complete transactions right now.' },
  { delay: 8500, role: 'ENGINEER', text: 'We\'re seeing postgres deadlocks on the payments table. Suspect a spike from the marketing campaign.' },
  { delay: 10500, role: 'ARIA',    aria: 'Signal received. Root cause identified: postgres-primary connection pool exhaustion cascading to payment-gateway-v2 failures. P1 severity — 73,000 users impacted. DORA Article 11.1(a) threshold crossed. Generating compliance report...' },
]

window.runDemo = async function () {
  // Reset visible sections
  document.querySelectorAll('.report-section').forEach(s => s.classList.add('hidden'))
  document.querySelector('.section-placeholder').style.display = ''
  visibleSections.clear()

  document.getElementById('incident-title').value = 'Payment Gateway P1 — EMEA Region'
  document.getElementById('incident-desc').value = '503 errors on payment-gateway-v2 — postgres connection pool exhausted'

  await startIncident()

  // Replay scripted war-room transcript
  for (const line of DEMO_TRANSCRIPT) {
    await new Promise(r => setTimeout(r, line.delay))
    if (line.role === 'ARIA') {
      addTranscriptEntry({ speakerRole: 'ARIA', ariaResponse: line.aria, timestamp: Date.now() })
    } else {
      addTranscriptEntry({ speakerRole: line.role, rawQuote: line.text, timestamp: Date.now() })
    }
  }

  // Trigger full Gemini pipeline after transcript plays
  await new Promise(r => setTimeout(r, 1500))
  await triggerDemoPipeline()
}

window.triggerDemoPipeline = async function () {
  if (!incidentId) { addSystemMessage('Start an incident first.'); return }
  const btn = document.getElementById('btn-demo-pipeline')
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating...' }

  try {
    await fetch(`/api/incidents/${incidentId}/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        services: ['payment-gateway-v2', 'postgres-primary'],
        severity: 'P1',
        estimatedUsers: 73000,
        doraTrigger: true,
        rawQuote: 'payment-gateway-v2 503s across EMEA, postgres connection pool exhausted at 500/500, CPU 94.7%, 73k users impacted'
      })
    })
    addSystemMessage('ARIA: Analysis pipeline running — report sections appearing now...')
    if (btn) btn.classList.add('hidden')
  } catch (err) {
    addSystemMessage('Pipeline trigger failed: ' + err.message)
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Trigger Demo Pipeline' }
  }
}

// ─── Demo Mode ────────────────────────────────────────────────────────────────

// One-click demo: creates incident, connects SSE, fires demo pipeline
window.runDemo = async function () {
  const btn = document.getElementById('btn-demo')
  if (btn) { btn.textContent = '⏳ Starting demo...'; btn.disabled = true }

  try {
    // 1. Create incident with demo title
    const res = await fetch('/api/incidents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Payment Gateway P1 — Demo',
        description: 'Synthetic P1: payment-gateway-v2 503s + postgres connection pool exhausted'
      })
    })
    const data = await res.json()
    incidentId = data.incidentId

    document.getElementById('incident-id-display').textContent = incidentId
    document.getElementById('incident-meta').classList.remove('hidden')
    document.getElementById('incident-active-controls').classList.remove('hidden')
    document.getElementById('btn-start')?.classList.add('hidden')
    document.getElementById('btn-demo')?.classList.add('hidden')
    document.getElementById('btn-export')?.classList.remove('hidden')
    document.getElementById('btn-demo-pipeline')?.classList.remove('hidden')

    setAriaStatus('active', 'ARIA ACTIVE')
    connectSSE()

    // Add demo-mode transcript entries to simulate the incident unfolding
    addTranscriptEntry({
      speakerRole: 'ARIA',
      ariaResponse: `Demo mode active. Incident ${incidentId} created. Triggering synthetic P1 pipeline in 2 seconds...`,
      timestamp: Date.now()
    })

    // 2. Trigger demo pipeline after SSE is ready
    await new Promise(r => setTimeout(r, 2000))
    await triggerDemoPipeline()

  } catch (err) {
    console.error('Demo failed', err)
    addSystemMessage('Demo failed: ' + err.message)
    if (btn) { btn.textContent = '⚡ Run Demo (Synthetic P1)'; btn.disabled = false }
  }
}

// Trigger demo pipeline for current incident (can also be called mid-incident)
window.triggerDemoPipeline = async function () {
  if (!incidentId) { addSystemMessage('No active incident. Start one first.'); return }

  addTranscriptEntry({
    speakerRole: 'ARIA',
    ariaResponse: 'Triggering synthetic P1 incident pipeline. Watch the DORA report build in real time...',
    timestamp: Date.now()
  })

  // Simulate persona switch to show multi-stakeholder capability
  setTimeout(() => updatePersonaBadge('ENGINEER'), 500)
  setTimeout(() => updatePersonaBadge('COMPLIANCE'), 8000)
  setTimeout(() => updatePersonaBadge('EXECUTIVE'), 14000)

  // Simulate barge-in badge
  setTimeout(() => {
    const badge = document.getElementById('barge-badge')
    badge.classList.remove('hidden')
    setTimeout(() => badge.classList.add('hidden'), 2500)
  }, 5000)

  // Fire demo pipeline
  const res = await fetch(`/api/incidents/${incidentId}/demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      services: ['payment-gateway-v2', 'postgres-primary'],
      severity: 'P1',
      estimatedUsers: 73000,
      doraTrigger: true,
      rawQuote: 'payment-gateway-v2 throwing 503s on /api/charge, postgres connection pool exhausted, 7.3% transaction failure rate crossing DORA threshold'
    })
  })
  const result = await res.json()
  if (result.status === 'running') {
    // Start DORA countdown clock
    startDoraClock()
    document.getElementById('severity-badge').textContent = 'P1'
    document.getElementById('severity-badge').className = 'severity-badge severity-p1'
    document.getElementById('dora-status').textContent = 'TRIGGERED'
    document.getElementById('dora-status').className = 'status-value status-warn'
    addSystemMessage('P1 pipeline running — DORA report sections will appear as they are generated')
  }
}

// ─── Export Report ────────────────────────────────────────────────────────────

window.exportReport = function () {
  const now = new Date().toISOString()
  const header = [
    '================================================================================',
    '  REGULATORY INCIDENT REPORT — DORA ARTICLE 11 / SOX SECTION 404',
    '  Generated by RegGuardian ARIA (Automated Regulatory Incident Analyst)',
    '================================================================================',
    `  Incident ID      : ${incidentId || 'UNKNOWN'}`,
    `  Report generated : ${now}`,
    `  Classification   : P1 — Major Incident`,
    `  Frameworks       : EU DORA Article 11, SOX Section 404`,
    '================================================================================',
    '',
  ].join('\n')

  const sections = []
  for (const id of ['TIMELINE','BLAST_RADIUS','ROOT_CAUSE','REGULATORY','REMEDIATION','SUMMARY']) {
    const el = document.querySelector(`#sec-${id} .section-content`)
    if (el && el.innerText.trim()) {
      const label = { TIMELINE:'Timeline of Events', BLAST_RADIUS:'Blast Radius Assessment',
        ROOT_CAUSE:'Root Cause Analysis', REGULATORY:'Regulatory Obligations (DORA / SOX)',
        REMEDIATION:'Remediation Actions', SUMMARY:'Executive Summary' }[id]
      sections.push(`## ${label}\n\n${el.innerText.trim()}`)
    }
  }

  if (sections.length === 0) { alert('No report sections yet. Run the demo pipeline first.'); return }

  const footer = [
    '',
    '================================================================================',
    '  END OF REPORT',
    `  This report was auto-generated under DORA Article 11 obligations.`,
    `  Regulators should be notified within the deadline stated in the REGULATORY section.`,
    '================================================================================',
  ].join('\n')

  const blob = new Blob([header + sections.join('\n\n---\n\n') + footer], { type: 'text/plain' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${incidentId || 'incident'}-DORA-report-${now.slice(0,10)}.txt`
  a.click()
}
