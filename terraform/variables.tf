variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "GCP region for all resources"
}

variable "image_tag" {
  type        = string
  default     = "latest"
  description = "Docker image tag to deploy"
}

variable "gemini_api_key" {
  type        = string
  sensitive   = true
  description = "Gemini API key — stored in Secret Manager, never in plaintext"
}
