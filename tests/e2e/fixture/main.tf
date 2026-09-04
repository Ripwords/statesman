# The acceptance fixture. `terraform_data` is built into Terraform core, so
# this needs no provider, no registry download and no cloud credentials — the
# only thing under test is the state backend.
terraform {
  required_version = ">= 1.6"
  backend "http" {}
}

variable "value" {
  type    = string
  default = "one"
}

resource "terraform_data" "canary" {
  input = var.value
}

output "value" {
  value = terraform_data.canary.output
}
