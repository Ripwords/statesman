variable "region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region"
}

variable "db_password" {
  type      = string
  sensitive = true
  description = <<-EOT
    The database password.
    Rotated quarterly.
  EOT
}

variable "tags" {
  type = map(object({ team = string, cost = optional(number) }))
  validation {
    condition     = length(var.tags) > 0
    error_message = "At least one tag."
  }
}

variable "untyped" {}

locals {
  not_a_variable = 1
}
