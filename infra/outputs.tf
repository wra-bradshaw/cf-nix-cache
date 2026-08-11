output "bucket_name" {
  value = cloudflare_r2_bucket.cache.name
}

output "bucket_id" {
  value = cloudflare_r2_bucket.cache.id
}

output "hostname" {
  value = var.hostname
}
