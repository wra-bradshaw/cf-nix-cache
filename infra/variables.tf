variable "cloudflare_api_token" {
  description = "Cloudflare API token with R2 and DNS/Workers route permissions; keep this out of Terraform state where possible."
  type        = string
  sensitive   = true
}

variable "account_id" {
  description = "Cloudflare account that owns the R2 bucket and Worker."
  type        = string
}

variable "zone_id" {
  description = "Optional zone ID for the custom cache hostname."
  type        = string
  default     = null
}

variable "hostname" {
  description = "Optional public hostname routed to the Worker."
  type        = string
  default     = null
}

variable "worker_name" {
  type    = string
  default = "cf-nix-cache"
}

variable "bucket_name" {
  type    = string
  default = "cf-nix-cache-prod"
}

variable "r2_location" {
  type    = string
  default = "oc"
}

variable "enable_lifecycle" {
  type    = bool
  default = true
}

variable "force_destroy" {
  description = "Allow deletion of the bucket in non-production environments."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  tags = merge(var.tags, { application = var.worker_name, managed_by = "terraform" })
}
