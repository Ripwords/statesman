# Local state on purpose: this run tests variable delivery, not the backend,
# which tests/e2e/scenario.ts already covers.
terraform {
  required_version = ">= 1.6"
}

variable "value" {
  type    = string
  default = "one"
}

variable "replicas" {
  type = number
}

resource "terraform_data" "canary" {
  input = "${var.value}-${var.replicas}"
}

output "canary" {
  value = terraform_data.canary.output
}
