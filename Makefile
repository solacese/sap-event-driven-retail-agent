# ---------------------------------------------------------------------------
# Discount Bot demo. Simple make targets over npm, Docker and Terraform.
# No em dashes are used anywhere in this file.
# ---------------------------------------------------------------------------

.PHONY: install dev build test docker-build docker-up deploy

# Install dependencies.
install:
	npm install

# Start everything for local dev (gateway plus Vite on :5173).
dev:
	npm run dev

# Build the frontend bundle.
build:
	npm run build

# Run the test suite.
test:
	npm test

# Build the Docker image.
docker-build:
	docker build -t discount-bot .

# Run locally via Docker Compose with the edge and llm profiles.
docker-up:
	docker compose --profile edge --profile llm up -d

# Deploy the ECS Fargate stack with Terraform.
# Requires AWS credentials in the environment and a var-file, for example:
#   make deploy TF_VARS=prod.tfvars
deploy:
	cd infra && terraform init && terraform apply -var-file=$(TF_VARS)
