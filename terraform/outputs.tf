output "cloud_run_url" {
  description = "Public URL of the RegGuardian Cloud Run service"
  value       = google_cloud_run_v2_service.regguardian.uri
}

output "artifact_registry_repo" {
  description = "Docker image repository path"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/regguardian/app"
}

output "pubsub_topics" {
  description = "Created Pub/Sub topic names"
  value       = [for t in google_pubsub_topic.topics : t.name]
}
