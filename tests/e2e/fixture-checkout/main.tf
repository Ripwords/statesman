# A local backend with no path: the path comes from backend.<env>.hcl, which is
# what proves the CLI's backend file reaches `terraform init`.
terraform {
  required_version = ">= 1.6"
  backend "local" {}
}

variable "value" {
  type = string
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
