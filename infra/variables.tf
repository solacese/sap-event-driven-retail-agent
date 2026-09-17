# ---------------------------------------------------------------------------
# Input variables for the Discount Bot ECS Fargate stack.
# Every variable referenced in main.tf is declared here.
# No em dashes are used anywhere in this file.
# ---------------------------------------------------------------------------

variable "aws_region" {
  description = "AWS region to deploy into, for example eu-west-1."
  type        = string
}

variable "project_name" {
  description = "Name prefix applied to all resources."
  type        = string
  default     = "discount-bot"
}

variable "container_image" {
  description = "Full ECR image reference including tag."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate ARN for the ALB HTTPS listener."
  type        = string
}

variable "vpc_id" {
  description = "VPC id to deploy the ALB and Fargate service into."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnet ids for the internet-facing ALB."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Subnet ids for the Fargate tasks."
  type        = list(string)
}

variable "app_secret_arn" {
  description = "Secrets Manager secret ARN holding DEMO_PASSWORD and SESSION_SECRET keys."
  type        = string
}

variable "demo_password_key" {
  description = "JSON key inside the secret for the demo password."
  type        = string
  default     = "DEMO_PASSWORD"
}

variable "session_secret_key" {
  description = "JSON key inside the secret for the session secret."
  type        = string
  default     = "SESSION_SECRET"
}

variable "desired_count" {
  description = "Number of Fargate tasks to run."
  type        = number
  default     = 1
}

variable "container_port" {
  description = "Port the container listens on."
  type        = number
  default     = 8080
}

variable "task_cpu" {
  description = "Fargate task CPU units."
  type        = number
  default     = 512
}

variable "task_memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 1024
}

variable "broker_mode" {
  description = "Broker mode passed to the app: mock or solace."
  type        = string
  default     = "mock"
}

variable "simulators_enabled" {
  description = "Whether the fake-world simulators publish."
  type        = string
  default     = "true"
}

variable "topic_root" {
  description = "Topic root prefix for the taxonomy."
  type        = string
  default     = "acme/retail"
}

variable "llm_provider" {
  description = "LLM provider: openai_compatible, sap_ai_core or mock."
  type        = string
  default     = "mock"
}
