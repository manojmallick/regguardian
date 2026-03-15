# RegGuardian — System Architecture

> **ARIA — Automated Regulatory Incident Analyst**
> Live Agent deployed on Google Cloud Run
> `https://regguardian-908307939543.us-central1.run.app`

---

## System Overview

RegGuardian turns a 4-hour post-mortem compliance task into an 8-minute automated output. ARIA joins live incident war rooms, listens to engineers, watches their screens, and writes DORA Article 11 / SOX Section 404 reports in real time — section by section, as the incident unfolds.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         REGGUARDIAN SYSTEM BOUNDARY                         │
│                                                                             │
│  BROWSER (War Room UI)                                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  ┌──────────────┐  ┌──────────────────┐  ┌─────────────────────┐   │   │
│  │  │   CONTROLS   │  │  LIVE TRANSCRIPT  │  │  DORA ARTICLE 11    │   │   │
│  │  │              │  │                  │  │     REPORT          │   │   │
│  │  │ Start/Stop   │  │ Audio events     │  │  ■ Timeline         │   │   │
│  │  │ Share Screen │  │ ARIA responses   │  │  ■ Blast Radius     │   │   │
│  │  │ DORA Clock   │  │ Vision insights  │  │  ■ Root Cause       │   │   │
│  │  │ Export PDF   │  │ Persona badge    │  │  ■ Regulatory       │   │   │
│  │  └──────────────┘  └──────────────────┘  │  ■ Remediation      │   │   │
│  │                                           │  ■ Summary          │   │   │
│  │  Mic ─► PCM 16kHz ─► WS /ws/audio        └─────────────────────┘   │   │
│  │  Screen ─► PNG 5s ─► WS /ws/screen                                  │   │
│  │  SSE ◄─────────────── GET /api/incidents/:id/report/stream          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                               │                                             │
│                               ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                   NODE.JS SERVER — Cloud Run                         │   │
│  │                                                                      │   │
│  │   server.js (Express + http.Server + dual WebSocketServer)          │   │
│  │        │                                                             │   │
│  │        ├── audioGateway.js ──► listenerAgent.js                     │   │
│  │        │                           │                                 │   │
│  │        │                    Gemini Live API (gemini-2.0-flash-live) │   │
│  │        │                    Persistent bidirectional stream          │   │
│  │        │                    PCM 16kHz mono → JSON IncidentEvent      │   │
│  │        │                           │                                 │   │
│  │        ├── screenGateway.js ──► visionAgent.js                      │   │
│  │        │                           │                                 │   │
│  │        │                    Gemini Vision (gemini-2.0-flash)        │   │
│  │        │                    PNG frame → JSON VisualContext           │   │
│  │        │                           │                                 │   │
│  │        │            ┌──────────────┴──────────────┐                 │   │
│  │        │            ▼                             ▼                 │   │
│  │        │      Pub/Sub: incident-events    Pub/Sub: visual-contexts  │   │
│  │        │            └──────────────┬──────────────┘                 │   │
│  │        │                           ▼                                 │   │
│  │        │                    analystAgent.js                          │   │
│  │        │                    ADK LlmAgent + Gemini chat session       │   │
│  │        │                    Tools: queryRunbooks, getHistory         │   │
│  │        │                    Shared session per incident (incidentId) │   │
│  │        │                           │                                 │   │
│  │        │                    Pub/Sub: incident-analysis               │   │
│  │        │                           │                                 │   │
│  │        │                           ▼                                 │   │
│  │        │                    complianceAgent.js                       │   │
│  │        │                    ADK LlmAgent                             │   │
│  │        │                    Tools: queryRegulations, getTemplate     │   │
│  │        │                    Maps incident → DORA/SOX obligations     │   │
│  │        │                           │                                 │   │
│  │        │                    Pub/Sub: compliance-mappings             │   │
│  │        │                           │                                 │   │
│  │        │                           ▼                                 │   │
│  │        │                    reporterAgent.js                         │   │
│  │        │                    ADK LlmAgent (synthesis only)            │   │
│  │        │                    Writes 6 report sections live            │   │
│  │        │                           │                                 │   │
│  │        │            ┌──────────────┴───────────────┐                │   │
│  │        │            ▼                              ▼                │   │
│  │        │       Firestore                     SSE → Browser          │   │
│  │        │       /incidents/{id}               sseManager.broadcast() │   │
│  │        │       /incidents/{id}/sections      report section appears │   │
│  │        │                                     in real time           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Agent Pipeline

```
Audio Input (PCM 16kHz)          Screen Input (PNG 200KB/5s)
        │                                     │
        ▼                                     ▼
 ┌──────────────┐                   ┌──────────────────┐
 │   LISTENER   │                   │     VISION       │
 │    AGENT     │                   │     AGENT        │
 │              │                   │                  │
 │ Gemini Live  │                   │ Gemini Flash     │
 │ Persistent   │                   │ isProcessing     │
 │ stream       │                   │ flag (no queue)  │
 │ JSON extract │                   │ Reads dashboards │
 └──────┬───────┘                   └────────┬─────────┘
        │                                    │
        ▼                                    ▼
  Pub/Sub:                             Pub/Sub:
  incident-events                      visual-contexts
        │                                    │
        └──────────────┬─────────────────────┘
                       ▼
               ┌───────────────┐
               │    ANALYST    │
               │     AGENT     │
               │               │
               │ Gemini Flash  │
               │ Shared chat   │ ◄── Vertex AI Search
               │ session per   │     (Runbooks RAG)
               │ incident      │
               │               │
               │ Root cause    │
               │ Blast radius  │
               │ DORA trigger  │
               └───────┬───────┘
                       │
                       ▼
                 Pub/Sub:
                 incident-analysis
                       │
                       ▼
               ┌───────────────┐
               │  COMPLIANCE   │
               │     AGENT     │
               │               │
               │ Gemini Flash  │ ◄── Vertex AI Search
               │               │     (Regulatory corpus)
               │ DORA Art.11   │
               │ clause mapping│
               │ SOX 404 class │
               │               │
               │ Skip: P3 +    │
               │ no doraTrigger│
               └───────┬───────┘
                       │
                       ▼
                 Pub/Sub:
                 compliance-mappings
                       │
                       ▼
               ┌───────────────┐
               │   REPORTER    │
               │     AGENT     │
               │               │
               │ Gemini Flash  │
               │ Synthesis     │
               │ (no tools)    │
               │               │
               │ 6 sections:   │
               │ TIMELINE      │
               │ BLAST_RADIUS  │
               │ ROOT_CAUSE    │
               │ REGULATORY    │
               │ REMEDIATION   │
               │ SUMMARY       │
               └───────┬───────┘
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
    Firestore                   SSE Broadcast
    /incidents/{id}             → Browser
    /sections/{sectionId}       Report panel
                                updates live
```

---

## Data Schemas (Zod-validated)

```
Browser Audio                    Browser Screen
     │                                 │
     ▼ PCM binary                      ▼ PNG binary
listenerAgent                    visionAgent
     │                                 │
     ▼ Zod validate                    ▼ Zod validate
IncidentEvent                    VisualContext
{                                {
  type: service_failure|           anomalies: [{
         error_spike|               name, value, direction
         blast_radius_update|      }],
         timeline_event|           serviceHealth: [{
         severity_change            name, status: red|amber|green
  services: string[]              }],
  severity: P1|P2|P3|UNKNOWN     runbookTriggers: string[],
  blastRadius: {                  doraCritical: boolean,
    estimatedUsers: number        errorIndicators: string[],
    affectedPct: number           ariaObservation: string
  }                             }
  doraTrigger: boolean               │
  speakerRole: ENGINEER|             │
               COMPLIANCE|           │
               EXECUTIVE|UNKNOWN     │
  ariaResponse: string (≤300ch)      │
  rawQuote: string                   │
}                                    │
     │                               │
     └─────────────┬─────────────────┘
                   ▼ Zod validate
             IncidentAnalysis
             {
               rootCause: string,
               severity: P1|P2|P3|UNKNOWN,
               blastRadius: {
                 services: string[],
                 estimatedUsers: number,
                 transactionsBlocked: number
               },
               doraTrigger: boolean,
               remediationSteps: string[],
               runbookMatches: string[],
               confidence: 0-1
             }
                   │
                   ▼ Zod validate
             ComplianceMapping
             {
               doraObligation: {
                 triggered: boolean,
                 clause: "Art. 11.1(a)",
                 notificationDeadline: ISO datetime,
                 reportingType: initial|intermediate|final|none
               },
               soxImpact: {
                 controlDeficiency: boolean,
                 classification: none|significant_deficiency|
                                  material_weakness,
                 remediationRequired: boolean
               },
               reportTemplate: string,
               regulatoryNarrative: string
             }
                   │
                   ▼ Zod validate
             ReportSection
             {
               sectionId: TIMELINE|BLAST_RADIUS|ROOT_CAUSE|
                          REGULATORY|REMEDIATION|SUMMARY,
               content: string (markdown),
               isUpdate: boolean,
               confidence: 0-1
             }
```

---

## GCP Infrastructure

```
┌─────────────────────────────────────────────────────────────────┐
│                         GOOGLE CLOUD PROJECT                     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                      Cloud Run                            │   │
│  │  regguardian service                                      │   │
│  │  min_instance_count=1 (no cold start)                    │   │
│  │  2 vCPU / 2Gi RAM                                         │   │
│  │  Port 8080 — HTTP + WS + SSE on same port                │   │
│  └──────────────┬──────────────────────────────────────────┘   │
│                 │                                                │
│    ┌────────────┼──────────────────────────────────────────┐   │
│    │            │                                           │   │
│    ▼            ▼                   ▼                ▼      │   │
│  Secret      Firestore          Pub/Sub          Vertex AI  │   │
│  Manager     (default)          4 topics         Search     │   │
│              /incidents         4 DLQ topics     runbooks   │   │
│  gemini-     /runbooks          4 subscriptions  regulatory │   │
│  api-key     /compliance        flowControl=5    datastore  │   │
│              Templates          ack_deadline=60s            │   │
│                                                             │   │
│    ▼                    ▼                  ▼               │   │
│  Cloud              Artifact           Cloud               │   │
│  Storage            Registry           Build               │   │
│  screenshots        regguardian         git push →         │   │
│  reports            Docker images       build → deploy     │   │
│                                                             │   │
│    ▼                                                        │   │
│  Cloud Monitoring + Cloud Logging                          │   │
│  custom metrics: incident_response_ms                      │   │
│                  vision_agent_latency_ms                   │   │
│                  agent_latency_ms                          │   │
│                  circuit_breaker_open                      │   │
└─────────────────────────────────────────────────────────────┘
```

---

## Real-Time Communication

```
AUDIO PIPELINE (latency target: <700ms voice → Pub/Sub)
───────────────
Browser Mic
  getUserMedia({ sampleRate: 16000 })
  AudioWorklet (audio thread)
    Float32Array → Int16Array (3 lines, no codec)
    postMessage(buffer, [buffer])  // zero-copy transfer
  WebSocket /ws/audio (binary frames, ~250ms chunks)
  audioGateway.js (routing only — no business logic)
  listenerAgent.js
    ONE Gemini Live session per incident (persistent)
    sendRealtimeInput({ audio: base64, mimeType: 'audio/pcm;rate=16000' })
    receiveMessages() async iterator
    Buffer partial JSON across chunks
    Zod validate → Pub/Sub publish
    broadcastARIAVoice() → SSE → Web Speech API speaks

SCREEN PIPELINE (cadence: 5s, latency target: <5s frame → Pub/Sub)
────────────────
Browser Screen
  getDisplayMedia({ width: 1280, height: 720 })
  canvas.toBlob('image/png') every 5s (~200KB)
  WebSocket /ws/screen (binary frames)
  screenGateway.js (routing only)
  visionAgent.js
    isProcessing flag — drops stale frames, no queue
    cloudStorage.archive() fire-and-forget (no await)
    vertexSearch.queryRunbooks() grounding BEFORE vision call
    gemini.generateContent([prompt + runbookContext, PNG])
    Zod validate → Pub/Sub publish

SSE REPORT STREAM (unidirectional server→browser)
──────────────────
GET /api/incidents/:id/report/stream
  sseManager.connect()
    Content-Type: text/event-stream
    Cache-Control: no-cache
    heartbeat every 15s (prevents proxy timeout)
    catch-up: sends all existing sections on connect
  reporterAgent writes section
  sseManager.broadcast() → res.write('event:...\ndata:...\n\n')
  EventSource auto-reconnects on disconnect
```

---

## Resilience Architecture

```
CIRCUIT BREAKER (opossum)
──────────────────────────
Gemini Live session creation → protected by circuit breaker
  timeout: 5000ms
  errorThreshold: 50%
  resetTimeout: 30s
  fallback: { fallback: true, mode: 'batch' }

RETRY WITH BACKOFF
──────────────────
Session drop → reconnect with exponential backoff
  maxRetries: 3
  baseDelay: 1000ms
  jitter: Math.random() * 100ms

DEAD LETTER QUEUES
──────────────────
All 4 Pub/Sub topics have DLQ siblings:
  incident-events-dlq
  visual-contexts-dlq
  incident-analysis-dlq
  compliance-mappings-dlq
Malformed Zod validation → DLQ, never downstream
maxDeliveryAttempts: 5

PUBSUB ACK STRATEGY
────────────────────
message.ack() only AFTER handler completes successfully
message.nack() on handler exception → redelivery
flowControl: { maxMessages: 5 } — prevents agent flooding
```

---

## ARIA Persona System

```
speakerRole detected from audio (vocabulary, job titles, questions)
        │
        ├── ENGINEER  → badge: "Engineering Mode" (#06b6d4 cyan)
        │               style: service names, error codes, stack traces
        │               example: "payment-gateway-v2 503 on /api/charge, p99 847ms"
        │
        ├── COMPLIANCE → badge: "Compliance Mode" (#8b5cf6 purple)
        │               style: exact DORA/SOX clause references
        │               example: "DORA Art.11.1(a) — notify regulator by 14:32 UTC"
        │
        └── EXECUTIVE → badge: "Executive Mode" (#f59e0b amber)
                        style: business impact, no jargon
                        example: "73,000 transactions blocked, $240K/hr revenue impact"

Barge-in: User speaks mid-ARIA-response
  → Gemini Live handles internally (no code needed)
  → Frontend shows: "USER INTERRUPTED — RE-PRIORITISING" (2s animation)
  → Returns to: "ARIA ACTIVE"
```

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check — `{status:"ok", ts, version}` |
| `POST` | `/api/incidents` | Create incident — returns `{incidentId}` |
| `GET` | `/api/incidents/:id/report/stream` | SSE stream — live report sections |
| `GET` | `/api/incidents/:id/debug` | Debug — last Pub/Sub msg per topic |
| `GET` | `/api/incidents/:id/report` | Get full report from Firestore |
| `POST` | `/api/incidents/:id/demo` | **Demo mode** — triggers full pipeline with synthetic P1 incident |
| `GET` | `/api/incidents/:id/export` | Export report as plain text |
| `WS` | `/ws/audio?incidentId=X` | Binary PCM audio stream |
| `WS` | `/ws/screen?incidentId=X` | Binary PNG screenshot stream |

---

## Environment Configuration

```bash
# Google Cloud
GCP_PROJECT_ID=your-project-id
GCP_REGION=us-central1

# Gemini (prod: Secret Manager injection)
GEMINI_API_KEY=your-key

# Pub/Sub topics
PUBSUB_TOPIC_INCIDENT_EVENTS=incident-events
PUBSUB_TOPIC_VISUAL_CONTEXTS=visual-contexts
PUBSUB_TOPIC_INCIDENT_ANALYSIS=incident-analysis
PUBSUB_TOPIC_COMPLIANCE_MAPPINGS=compliance-mappings

# Firestore collections
FIRESTORE_COLLECTION_INCIDENTS=incidents
FIRESTORE_COLLECTION_REPORTS=reports
FIRESTORE_COLLECTION_RUNBOOKS=runbooks

# Cloud Storage
GCS_BUCKET_SCREENSHOTS=regguardian-screenshots
GCS_BUCKET_REPORTS=regguardian-reports

# Vertex AI Search datastore IDs
VERTEX_SEARCH_DATASTORE_RUNBOOKS=your-runbooks-datastore-id
VERTEX_SEARCH_DATASTORE_REGULATORY=your-regulatory-datastore-id

PORT=8080
NODE_ENV=production
```

---

## Technology Decisions

| Tech | Why This, Not Alternatives |
|---|---|
| `ws@8` (raw WebSocket) | Binary audio frames, no serialisation overhead vs Socket.io |
| `AudioWorklet` not `MediaRecorder` | MediaRecorder → WebM/Opus. Gemini Live requires PCM 16kHz mono |
| `gemini-2.0-flash-live` | Live bidirectional stream — not request/response. Barge-in built in |
| `gemini-2.0-flash` (vision/agents) | Sufficient for dashboard reading; Pro exceeds 5s latency budget |
| SSE not WebSocket for reports | Report is server→client only. SSE auto-reconnects, simpler client |
| Pub/Sub between agents | Decoupled: crash one agent, others keep running |
| Firestore for state | Real-time listeners; no polling needed for SSE catch-up |
| Zod before publish | Fail fast — corrupted data must never reach downstream agents |
| `isProcessing` not queue | 5s-old screenshots have no diagnostic value |
| `min_instance_count=1` | No cold start when judges or reviewers open the URL |
| All IaC in one `main.tf` | Hackathon: judges read top-to-bottom, one file = full picture |

---

*Last updated: March 2026 — RegGuardian v1.0 — Gemini Live Agent Challenge 2026*
