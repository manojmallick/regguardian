terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ─── Artifact Registry ────────────────────────────────────────────────────────
resource "google_artifact_registry_repository" "regguardian" {
  location      = var.region
  repository_id = "regguardian"
  format        = "DOCKER"
  description   = "RegGuardian Docker images"
}

# ─── Service Account for Cloud Run ───────────────────────────────────────────
resource "google_service_account" "cloudrun_sa" {
  account_id   = "regguardian-cloudrun"
  display_name = "RegGuardian Cloud Run Service Account"
}

# IAM roles for the Cloud Run service account
locals {
  cloudrun_sa_roles = [
    "roles/pubsub.publisher",
    "roles/pubsub.subscriber",
    "roles/datastore.user",
    "roles/storage.objectAdmin",
    "roles/aiplatform.user",
    "roles/monitoring.metricWriter",
    "roles/logging.logWriter",
    "roles/secretmanager.secretAccessor",
  ]
}

resource "google_project_iam_member" "cloudrun_sa_roles" {
  for_each = toset(local.cloudrun_sa_roles)
  project  = var.project_id
  role     = each.key
  member   = "serviceAccount:${google_service_account.cloudrun_sa.email}"
}

# ─── Secret Manager — Gemini API Key ─────────────────────────────────────────
resource "google_secret_manager_secret" "gemini_key" {
  secret_id = "gemini-api-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "gemini_key_v1" {
  secret      = google_secret_manager_secret.gemini_key.id
  secret_data = var.gemini_api_key
}

# ─── Pub/Sub — 4 topics + 4 DLQ topics + 4 subscriptions ────────────────────
locals {
  pubsub_topics = ["incident-events", "visual-contexts", "incident-analysis", "compliance-mappings"]
}

resource "google_pubsub_topic" "topics" {
  for_each = toset(local.pubsub_topics)
  name     = each.key
}

resource "google_pubsub_topic" "dlq_topics" {
  for_each = toset(local.pubsub_topics)
  name     = "${each.key}-dlq"
}

resource "google_pubsub_subscription" "subscriptions" {
  for_each = toset(local.pubsub_topics)
  name     = "${each.key}-sub"
  topic    = google_pubsub_topic.topics[each.key].name

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dlq_topics[each.key].id
    max_delivery_attempts = 5
  }

  ack_deadline_seconds       = 60
  message_retention_duration = "86400s"  # 24 hours
}

# DLQ also needs subscriptions for manual inspection
resource "google_pubsub_subscription" "dlq_subscriptions" {
  for_each = toset(local.pubsub_topics)
  name     = "${each.key}-dlq-sub"
  topic    = google_pubsub_topic.dlq_topics[each.key].name

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"  # 7 days
}

# ─── Firestore ────────────────────────────────────────────────────────────────
resource "google_firestore_database" "default" {
  project     = var.project_id
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"
}

# ─── Cloud Storage ────────────────────────────────────────────────────────────
resource "google_storage_bucket" "screenshots" {
  name          = "regguardian-screenshots-${var.project_id}"
  location      = var.region
  force_destroy = true

  lifecycle_rule {
    condition {
      age = 30
    }
    action {
      type = "Delete"
    }
  }
}

resource "google_storage_bucket" "reports" {
  name          = "regguardian-reports-${var.project_id}"
  location      = var.region
  force_destroy = true
}

# ─── Cloud Run Service ────────────────────────────────────────────────────────
# CRITICAL: min_instance_count = 1 — prevents cold start when judges visit URL
resource "google_cloud_run_v2_service" "regguardian" {
  name     = "regguardian"
  location = var.region

  template {
    service_account = google_service_account.cloudrun_sa.email

    scaling {
      min_instance_count = 1   # judges must not see a cold start timeout
      max_instance_count = 3
    }

    containers {
      # Use placeholder image initially so Cloud Run deploys without a real image.
      # After docker build + push, re-run: terraform apply -var="image_tag=latest"
      image = var.image_tag == "placeholder" ? "us-docker.pkg.dev/cloudrun/container/hello" : "${var.region}-docker.pkg.dev/${var.project_id}/regguardian/app:${var.image_tag}"

      # Non-secret env vars
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "GCP_REGION"
        value = var.region
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "PUBSUB_TOPIC_INCIDENT_EVENTS"
        value = "incident-events"
      }
      env {
        name  = "PUBSUB_TOPIC_VISUAL_CONTEXTS"
        value = "visual-contexts"
      }
      env {
        name  = "PUBSUB_TOPIC_INCIDENT_ANALYSIS"
        value = "incident-analysis"
      }
      env {
        name  = "PUBSUB_TOPIC_COMPLIANCE_MAPPINGS"
        value = "compliance-mappings"
      }
      env {
        name  = "FIRESTORE_COLLECTION_INCIDENTS"
        value = "incidents"
      }
      env {
        name  = "FIRESTORE_COLLECTION_REPORTS"
        value = "reports"
      }
      env {
        name  = "FIRESTORE_COLLECTION_RUNBOOKS"
        value = "runbooks"
      }
      env {
        name  = "GCS_BUCKET_SCREENSHOTS"
        value = google_storage_bucket.screenshots.name
      }
      env {
        name  = "GCS_BUCKET_REPORTS"
        value = google_storage_bucket.reports.name
      }

      # Gemini API key from Secret Manager — never in plaintext
      env {
        name = "GEMINI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.gemini_key.secret_id
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
      }

      # Health check / startup probe
      startup_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 10
        period_seconds        = 5
        failure_threshold     = 10
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

# Public access — judges need to hit the URL without authentication
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.regguardian.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ─── Cloud Monitoring Alert Policy ───────────────────────────────────────────
resource "google_monitoring_notification_channel" "email" {
  display_name = "RegGuardian Alerts"
  type         = "email"
  labels = {
    email_address = "alerts@example.com"  # Replace before deployment
  }
}
