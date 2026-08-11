resource "cloudflare_r2_bucket" "cache" {
  account_id    = var.account_id
  name          = var.bucket_name
  location      = var.r2_location
  storage_class = "Standard"
}

resource "cloudflare_r2_bucket_lifecycle" "cache" {
  count       = var.enable_lifecycle ? 1 : 0
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.cache.name
  rules = [
    {
      id         = "abandoned-staging"
      enabled    = true
      conditions = { prefix = "staging/" }
      delete_objects_transition = {
        condition = { type = "Age", max_age = 86400 }
      }
    },
    {
      id         = "abort-multipart"
      enabled    = true
      conditions = { prefix = "" }
      abort_multipart_uploads_transition = {
        condition = { type = "Age", max_age = 86400 }
      }
    }
  ]
}

resource "cloudflare_workers_route" "cache" {
  count   = var.zone_id != null && var.hostname != null ? 1 : 0
  zone_id = var.zone_id
  pattern = "${var.hostname}/*"
  script  = var.worker_name
}

resource "cloudflare_dns_record" "cache" {
  count   = var.zone_id != null && var.hostname != null ? 1 : 0
  zone_id = var.zone_id
  name    = var.hostname
  type    = "CNAME"
  content = "${var.worker_name}.workers.dev"
  proxied = true
  ttl     = 1
}
