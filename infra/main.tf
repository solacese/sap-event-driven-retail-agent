# ---------------------------------------------------------------------------
# Discount Bot: minimal ECS Fargate stack behind an ALB with HTTPS.
#
# Resources: ECR repo, ECS cluster, Fargate task definition (image from ECR on
# port 8080, plain env from variables, DEMO_PASSWORD + SESSION_SECRET pulled
# from Secrets Manager via the container `secrets` block), ECS service, ALB
# with an HTTPS listener (ACM cert), target group health-checked on /healthz,
# and the security groups that connect them.
#
# This stack is written to be internally consistent and readable. It does not
# need to be applied. No em dashes are used anywhere in this file.
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

locals {
  name = var.project_name
  tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
  }
}

# ---------------------------------------------------------------------------
# ECR repository for the app image.
# ---------------------------------------------------------------------------
resource "aws_ecr_repository" "app" {
  name                 = local.name
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.tags
}

# ---------------------------------------------------------------------------
# ECS cluster.
# ---------------------------------------------------------------------------
resource "aws_ecs_cluster" "this" {
  name = local.name
  tags = local.tags
}

# ---------------------------------------------------------------------------
# CloudWatch log group for container logs.
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name}"
  retention_in_days = 14
  tags              = local.tags
}

# ---------------------------------------------------------------------------
# IAM roles.
# execution_role: lets ECS pull the image and read the secret at task start.
# task_role: the app runtime role (kept minimal, nothing extra needed here).
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Allow the execution role to read the app secret so `secrets` injection works.
data "aws_iam_policy_document" "secret_read" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.app_secret_arn]
  }
}

resource "aws_iam_role_policy" "execution_secret" {
  name   = "${local.name}-secret-read"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.secret_read.json
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

# ---------------------------------------------------------------------------
# Security groups.
# alb_sg: allow 80 and 443 from the internet.
# service_sg: allow the container port only from the ALB.
# ---------------------------------------------------------------------------
resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "ALB ingress for Discount Bot"
  vpc_id      = var.vpc_id
  tags        = local.tags

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "All egress"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "service" {
  name        = "${local.name}-service"
  description = "Fargate service ingress from the ALB only"
  vpc_id      = var.vpc_id
  tags        = local.tags

  ingress {
    description     = "App port from ALB"
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "All egress"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---------------------------------------------------------------------------
# Application Load Balancer, target group and HTTPS listener.
# The target group health check hits /healthz.
# ---------------------------------------------------------------------------
resource "aws_lb" "this" {
  name               = "${local.name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids
  tags               = local.tags
}

resource "aws_lb_target_group" "this" {
  name        = "${local.name}-tg"
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"
  tags        = local.tags

  health_check {
    enabled             = true
    path                = "/healthz"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# HTTPS listener terminating TLS with the ACM certificate.
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
}

# Redirect plain HTTP to HTTPS.
resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# ---------------------------------------------------------------------------
# Task definition. Non-secret config is plain env; DEMO_PASSWORD and
# SESSION_SECRET come from Secrets Manager via the `secrets` block.
# ---------------------------------------------------------------------------
resource "aws_ecs_task_definition" "app" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  tags                     = local.tags

  container_definitions = jsonencode([
    {
      name      = local.name
      image     = var.container_image
      essential = true

      portMappings = [
        {
          containerPort = var.container_port
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "PORT", value = tostring(var.container_port) },
        { name = "NODE_ENV", value = "production" },
        { name = "BROKER_MODE", value = var.broker_mode },
        { name = "SIMULATORS_ENABLED", value = var.simulators_enabled },
        { name = "TOPIC_ROOT", value = var.topic_root },
        { name = "LLM_PROVIDER", value = var.llm_provider }
      ]

      secrets = [
        { name = "DEMO_PASSWORD", valueFrom = "${var.app_secret_arn}:${var.demo_password_key}::" },
        { name = "SESSION_SECRET", valueFrom = "${var.app_secret_arn}:${var.session_secret_key}::" }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "app"
        }
      }
    }
  ])
}

# ---------------------------------------------------------------------------
# ECS service on Fargate, wired to the target group.
# ---------------------------------------------------------------------------
resource "aws_ecs_service" "app" {
  name            = local.name
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"
  tags            = local.tags

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = local.name
    container_port   = var.container_port
  }

  # Wait for the HTTPS listener before the service starts registering targets.
  depends_on = [aws_lb_listener.https]
}
