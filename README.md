# RegGuardian

> **ARIA — Automated Regulatory Incident Analyst**
> Real-Time DORA Article 11 / SOX 404 Compliance Reporting During Live Incident War Rooms
> *Gemini Live Agent Challenge 2026 — Live Agent Category*

**🔴 Live demo:** https://regguardian-908307939543.us-central1.run.app

---

## What It Does

When a bank's payment gateway fails, DORA Article 11 mandates regulatory notification within **4 hours**. Engineers focus on the fix. The compliance documentation — which currently takes 4+ hours of post-mortem work — gets written from memory at 5 AM.

**ARIA joins the incident war room and:**
- 🎙️ **Listens** to the call via Gemini Live API — hears every service name, error code, impact number
- 🖥️ **Watches** engineers' screens every 5 seconds — reads Grafana, Kubernetes dashboards, alert panels
- 📋 **Builds** the DORA Article 11 report live, section by section, as the incident unfolds
- 🗣️ **Speaks** in three modes: Engineering (technical), Compliance (regulatory clauses), Executive (business impact)
- ⏱️ Reports that took **4 hours** now take under **8 minutes**

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 ESM · Express 4 · ws 8 |
| AI — Live Audio | Gemini 2.5 Flash Native Audio (`gemini-2.5-flash-native-audio-latest`) |
| AI — Analysis | Gemini 2.5 Flash (`gemini-2.5-flash` via generateContent) |
| Agent Orchestration | @google/adk (LlmAgent + FunctionTool) |
| Messaging | Cloud Pub/Sub (4 topics + 4 DLQ topics) |
| State | Firestore (incidents + report sections) |
| RAG | Vertex AI Search (runbooks + DORA/SOX corpus) |
| Infrastructure | Cloud Run · Terraform · Cloud Build CI/CD |
| Frontend | Vanilla JS + AudioWorklet + SSE + Web Speech API |

## Architecture

```
BROWSER (War Room)
├── Mic PCM 16kHz  ──────────► /ws/audio  → Gemini Live (native-audio)
│                                              └─ inputTranscription ──► generateContent
├── Screen PNG/5s  ──────────► /ws/screen → Gemini Vision  → Pub/Sub: visual-contexts
└── SSE listener   ◄──────────── /api/incidents/:id/report/stream

AGENT PIPELINE (sequential via Pub/Sub)
incident-events ─┐
                  ├──► [Analyst Agent]    → incident-analysis
visual-contexts ─┘
                       [Compliance Agent] → compliance-mappings
                       [Reporter Agent]  → Firestore + SSE → Browser
```

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full system design and the draw.io diagram.

## Quick Start (Local Dev)

### Prerequisites
- Node.js 20+
- GCP project with billing enabled
- `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com)

```bash
# 1. Clone and install
git clone https://github.com/manojmallick/regguardian
cd regguardian
npm ci

# 2. Configure environment
cp .env.example .env
# Edit .env — minimum required for local dev:
# GEMINI_API_KEY=your-key
# GCP_PROJECT_ID=your-project (for Firestore/Pub/Sub)

# 3. Start
npm start
# → http://localhost:8080

# 4. Health check
curl http://localhost:8080/health
# {"status":"ok","ts":...}
```

### Local Dev with Nodemon (auto-restart)
```bash
npm run dev
```

### Run Schema Tests (no GCP required)
```bash
npm test
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | From Google AI Studio. In prod: pulled from Secret Manager |
| `GCP_PROJECT_ID` | ✅ | Your GCP project ID |
| `GCP_REGION` | ✅ | Default: `us-central1` |
| `PUBSUB_TOPIC_INCIDENT_EVENTS` | | Default: `incident-events` |
| `PUBSUB_TOPIC_VISUAL_CONTEXTS` | | Default: `visual-contexts` |
| `PUBSUB_TOPIC_INCIDENT_ANALYSIS` | | Default: `incident-analysis` |
| `PUBSUB_TOPIC_COMPLIANCE_MAPPINGS` | | Default: `compliance-mappings` |
| `FIRESTORE_COLLECTION_INCIDENTS` | | Default: `incidents` |
| `GCS_BUCKET_SCREENSHOTS` | | Default: `regguardian-screenshots` |
| `GCS_BUCKET_REPORTS` | | Default: `regguardian-reports` |
| `VERTEX_SEARCH_DATASTORE_RUNBOOKS` | | Vertex AI Search datastore ID for runbooks |
| `VERTEX_SEARCH_DATASTORE_REGULATORY` | | Vertex AI Search datastore ID for DORA/SOX corpus |

See [`.env.example`](./.env.example) for the full list with defaults.

## Cloud Deployment (Terraform + Cloud Run)

### 1. Enable GCP APIs
```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  pubsub.googleapis.com \
  storage.googleapis.com \
  aiplatform.googleapis.com \
  monitoring.googleapis.com \
  logging.googleapis.com \
  secretmanager.googleapis.com
```

### 2. Terraform
```bash
cd terraform
terraform init
terraform plan \
  -var="project_id=YOUR_PROJECT" \
  -var="gemini_api_key=YOUR_KEY"
terraform apply \
  -var="project_id=YOUR_PROJECT" \
  -var="gemini_api_key=YOUR_KEY"
```

### 3. Build & Deploy via Cloud Build
```bash
# Trigger CI/CD manually (or push to main for auto-deploy)
gcloud builds submit --config cloudbuild.yaml \
  --substitutions SHORT_SHA=$(git rev-parse --short HEAD) \
  --project=YOUR_PROJECT
```

### 4. Verify Deployment
```bash
curl $(terraform output -raw cloud_run_url)/health
# {"status":"ok","ts":...}
```

### 5. Set Up CI/CD (automatic deploys on git push)
Create a Cloud Build trigger in GCP Console:
- Source: `github.com/manojmallick/regguardian`, branch `main`
- Config: `cloudbuild.yaml`

All future `git push → main` = automatic build + deploy.

## Repository Structure

```
regguardian/
├── src/
│   ├── server.js               # Entry point: Express + WebSocket + REST + SSE
│   ├── agents/
│   │   ├── listenerAgent.js    # Gemini Live API — audio → inputTranscription → IncidentEvent
│   │   ├── visionAgent.js      # Gemini Vision — screenshot → VisualContext
│   │   ├── analystAgent.js     # Root cause + blast radius analysis
│   │   ├── complianceAgent.js  # DORA/SOX regulatory mapping
│   │   └── reporterAgent.js    # Live report section generation
│   ├── websocket/
│   │   ├── audioGateway.js     # WS lifecycle → listenerAgent
│   │   └── screenGateway.js    # WS lifecycle → visionAgent
│   ├── services/
│   │   ├── pubsub.js           # publish/subscribe with ack/nack
│   │   ├── firestore.js        # incident state + report sections
│   │   ├── vertexSearch.js     # Runbook + regulatory RAG
│   │   ├── cloudStorage.js     # Screenshot archive + report export
│   │   ├── monitoring.js       # Custom Cloud Monitoring metrics
│   │   └── sseManager.js       # SSE connections + heartbeat + broadcast
│   ├── schemas/                # Zod validation (5 schemas)
│   ├── middleware/             # Circuit breaker, retry, error handler
│   └── utils/                  # Logger, metrics
├── frontend/
│   ├── index.html              # War-room 3-column dark UI
│   ├── main.js                 # Audio/screen capture + SSE + ARIA voice
│   ├── audio-processor.js      # AudioWorklet: Float32 → PCM Int16
│   └── style.css               # Dark theme, badges, animations
├── terraform/                  # All GCP infrastructure as code
│   ├── main.tf                 # Cloud Run, Pub/Sub, Firestore, Storage, IAM
│   ├── variables.tf            # Input variables
│   └── outputs.tf              # Service URL, bucket names
├── test/schemas/               # Schema unit tests (no GCP required)
├── Dockerfile                  # Multi-stage: builder → alpine runner
├── cloudbuild.yaml             # CI/CD pipeline
└── .env.example                # All env vars with defaults
```

## Regulatory Scope

| Regulation | Clause | Threshold | ARIA Action |
|---|---|---|---|
| DORA | Art. 11.1(a) | >5% transactions OR >2hr downtime | Triggers 4-hour countdown clock |
| DORA | Art. 11.1(b) | Same as above | Schedules 72-hour intermediate report |
| DORA | Art. 11.1(c) | Same as above | Schedules 1-month final report |
| SOX | Section 404 | Any IT control failure | Classifies: significant deficiency / material weakness |

## Gemini Live API — Hybrid Architecture

The Live API on AI Studio only exposes `bidiGenerateContent` on native-audio models (`gemini-2.5-flash-native-audio-latest`). These support `responseModalities: ['AUDIO']` and produce `inputTranscription` of participant speech, but cannot emit structured JSON directly.

**Solution — two-model hybrid:**
1. **Gemini Live** (`gemini-2.5-flash-native-audio-latest`, AUDIO modality only) — bidirectional audio stream, fires `inputTranscription` on each participant turn
2. **Gemini Flash** (`gemini-2.5-flash`, generateContent) — receives transcript, returns structured `IncidentEvent` JSON validated by Zod

This keeps the live session permanently open while producing typed, validated incident events for the agent pipeline.

## Debug Endpoint

```bash
# Check live state for any incident
curl https://regguardian-908307939543.us-central1.run.app/api/incidents/INC-XXXX/debug
```

Returns: incident document, all report sections, current SSE connection count.

---

*Built for the Gemini Live Agent Challenge 2026 — Live Agent Category*
*Source: https://github.com/manojmallick/regguardian*
