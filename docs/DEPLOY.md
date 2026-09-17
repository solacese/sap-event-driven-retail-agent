# Deploying Discount Bot

Two paths. The simple path is a single EC2 instance running Docker Compose with Caddy for TLS and basic auth. The team-friendly path is ECS Fargate behind an ALB with secrets in Secrets Manager. Both serve the same image. No em dashes are used anywhere in this file.

The app already ships with a password gate of its own. Caddy basic auth and the ALB sit in front of it for defence in depth.

## Path 1: Simple, single EC2 t3.small with Docker Compose

This is the default for a quick, cheap, password-protected demo box.

### Prerequisites

- An EC2 t3.small (or larger) running a recent Amazon Linux or Ubuntu with Docker and the Docker Compose plugin installed.
- A DNS A record pointing your subdomain at the instance public IP, for example `discount-bot.example.com`.
- Security group inbound rules: allow TCP 80 and TCP 443 from the internet (Let's Encrypt needs 80 for the HTTP-01 challenge, browsers use 443). Do not expose 8080 or 4000 publicly.

### Steps

1. Clone the repo onto the instance and change into it.

2. Generate a bcrypt hash for Caddy basic auth. Do not put a plaintext password in the Caddyfile.

   ```bash
   docker run --rm caddy:2 caddy hash-password --plaintext 'choose-a-strong-password'
   ```

   Copy the printed hash.

3. Create a `.env` next to `docker-compose.yml`:

   ```bash
   DEMO_DOMAIN=discount-bot.example.com
   BASIC_AUTH_HASH=<paste the bcrypt hash from step 2>
   DEMO_PASSWORD=<the app password prospects type>
   SESSION_SECRET=<a long random string>
   BROKER_MODE=mock
   SIMULATORS_ENABLED=true
   LLM_PROVIDER=openai_compatible
   LLM_BASE_URL=http://litellm:4000/v1
   LLM_MODEL=discount-bot
   ```

   `DEMO_DOMAIN` and `BASIC_AUTH_HASH` are read by the Caddyfile. If you skip the LLM proxy, remove `LLM_BASE_URL` and the app falls back to the mock LLM.

4. Bring it up with the edge and llm profiles:

   ```bash
   docker compose --profile edge --profile llm up -d
   ```

   This starts three services: `app` (the demo on 8080, not exposed publicly through Caddy only), `litellm` (the LLM proxy on 4000), and `caddy` (TLS plus basic auth on 80 and 443). Caddy obtains a Let's Encrypt certificate for `DEMO_DOMAIN` automatically.

   For the smallest possible footprint with the mock LLM, drop the llm profile:

   ```bash
   docker compose --profile edge up -d
   ```

5. Visit `https://discount-bot.example.com`. Caddy prompts for basic auth (user `demo`, the password you hashed), then the app prompts for `DEMO_PASSWORD`.

### Notes

- SSE needs unbuffered proxying. The Caddyfile sets `flush_interval -1` on the reverse proxy so events flush immediately.
- Broker credentials are still entered in the UI and held in memory only. Nothing is persisted on the box.
- To update: `git pull` then `docker compose --profile edge --profile llm up -d --build`.

## Path 2: Team-friendly, ECS Fargate behind an ALB

For a shared, always-on deployment with proper secret handling and a managed load balancer.

Topology:

- Image pushed to ECR.
- ECS Fargate service running the container on port 8080.
- Application Load Balancer with an HTTPS listener terminating TLS with an ACM certificate.
- Target group health-checked on `/healthz`.
- `DEMO_PASSWORD` and `SESSION_SECRET` injected from a Secrets Manager secret via the task definition `secrets` block, never baked into the image or the task env.

This path is defined as a minimal Terraform stack in `infra/` and driven by `make deploy`.

### Required variables

The Terraform stack in `infra/` expects these variables (see `infra/variables.tf`):

| Variable | Meaning |
|---|---|
| `aws_region` | AWS region, for example `eu-west-1`. |
| `project_name` | Name prefix for all resources, for example `discount-bot`. |
| `container_image` | Full ECR image reference including tag, for example `<acct>.dkr.ecr.eu-west-1.amazonaws.com/discount-bot:latest`. |
| `certificate_arn` | ACM certificate ARN for the HTTPS listener. |
| `vpc_id` | VPC to deploy into. |
| `public_subnet_ids` | List of public subnet ids for the ALB. |
| `private_subnet_ids` | List of subnet ids for the Fargate tasks. |
| `app_secret_arn` | Secrets Manager secret ARN holding `DEMO_PASSWORD` and `SESSION_SECRET` keys. |
| `demo_password_key` | JSON key in the secret for the demo password. Defaults to `DEMO_PASSWORD`. |
| `session_secret_key` | JSON key in the secret for the session secret. Defaults to `SESSION_SECRET`. |
| `desired_count` | Number of Fargate tasks. Defaults to 1. |
| `container_port` | Container port. Defaults to 8080. |

Non-secret runtime configuration (`BROKER_MODE`, `SIMULATORS_ENABLED`, `TOPIC_ROOT`, `LLM_PROVIDER`, and so on) is passed as plain task environment variables and can be adjusted in `infra/main.tf`.

### Build, push, deploy

1. Build the image and push to ECR (create the ECR repo first with the Terraform stack or the console):

   ```bash
   aws ecr get-login-password --region eu-west-1 \
     | docker login --username AWS --password-stdin <acct>.dkr.ecr.eu-west-1.amazonaws.com
   docker build -t discount-bot .
   docker tag discount-bot:latest <acct>.dkr.ecr.eu-west-1.amazonaws.com/discount-bot:latest
   docker push <acct>.dkr.ecr.eu-west-1.amazonaws.com/discount-bot:latest
   ```

2. Create the Secrets Manager secret with the two keys:

   ```bash
   aws secretsmanager create-secret \
     --name discount-bot/app \
     --secret-string '{"DEMO_PASSWORD":"strong-password","SESSION_SECRET":"long-random-string"}'
   ```

3. Deploy with Terraform. `make deploy` runs `terraform init` and `terraform apply` in `infra/`. AWS credentials and a var-file are required.

   ```bash
   make deploy
   ```

   or directly:

   ```bash
   cd infra
   terraform init
   terraform apply -var-file=prod.tfvars
   ```

4. The stack outputs the ALB DNS name. Point your DNS at it, or use the ALB name directly. HTTPS is served by the ACM certificate.

## Health check contract

`GET /healthz` returns HTTP 200 with a JSON body:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "broker": { "connected": false, "kind": "mock" },
  "llm": { "provider": "openai_compatible", "model": "discount-bot", "reachable": true },
  "topicRoot": "acme/retail"
}
```

- `broker.connected` and `broker.kind` reflect the live Bus state (`mock` or `solace`).
- `llm.reachable` probes the active LLM provider. Mock is always reachable.
- The ALB target group uses `/healthz` as its health check path.

## Graceful shutdown

On `SIGINT` or `SIGTERM` the gateway tears down the Bus, which disconnects the Solace session cleanly if one is connected, then closes the HTTP server. A 3 second safety timer forces exit if close hangs. On ECS this makes task replacement and deploys clean, and on the EC2 box a `docker compose down` stops without leaving a dangling broker session.
