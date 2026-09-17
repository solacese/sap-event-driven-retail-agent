# ---------------------------------------------------------------------------
# Outputs for the Discount Bot ECS Fargate stack.
# No em dashes are used anywhere in this file.
# ---------------------------------------------------------------------------

output "alb_dns_name" {
  description = "Public DNS name of the ALB. Point your DNS record here."
  value       = aws_lb.this.dns_name
}

output "ecr_repository_url" {
  description = "ECR repository URL to push the app image to."
  value       = aws_ecr_repository.app.repository_url
}

output "ecs_cluster_name" {
  description = "Name of the ECS cluster."
  value       = aws_ecs_cluster.this.name
}

output "ecs_service_name" {
  description = "Name of the ECS service."
  value       = aws_ecs_service.app.name
}

output "target_group_arn" {
  description = "ARN of the target group health-checked on /healthz."
  value       = aws_lb_target_group.this.arn
}
