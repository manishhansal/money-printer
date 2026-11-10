# MoneyPrinter — AWS Production Deployment Guide

This guide walks through deploying the MoneyPrinter CloudEngine to AWS using
**ECS Fargate** (serverless containers), **RDS PostgreSQL**, **ElastiCache Redis**,
and **AWS Secrets Manager**. No servers to manage.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Step 1 — AWS Account & CLI Setup](#step-1--aws-account--cli-setup)
4. [Step 2 — VPC & Networking](#step-2--vpc--networking)
5. [Step 3 — RDS PostgreSQL](#step-3--rds-postgresql)
6. [Step 4 — ElastiCache Redis](#step-4--elasticache-redis)
7. [Step 5 — Secrets Manager](#step-5--secrets-manager)
8. [Step 6 — ECR — Build & Push Docker Image](#step-6--ecr--build--push-docker-image)
9. [Step 7 — ECS Fargate — Cluster & Task](#step-7--ecs-fargate--cluster--task)
10. [Step 8 — Application Load Balancer](#step-8--application-load-balancer)
11. [Step 9 — ECS Service](#step-9--ecs-service)
12. [Step 10 — Run Database Migrations](#step-10--run-database-migrations)
13. [Step 11 — IAM Roles & Policies](#step-11--iam-roles--policies)
14. [Step 12 — TLS Certificate (ACM)](#step-12--tls-certificate-acm)
15. [Step 13 — Chrome Extension Configuration](#step-13--chrome-extension-configuration)
16. [Step 14 — CloudWatch Monitoring](#step-14--cloudwatch-monitoring)
17. [Step 15 — Post-Deployment Checklist](#step-15--post-deployment-checklist)
18. [Environment Variable Reference](#environment-variable-reference)
19. [Cost Estimate](#cost-estimate)
20. [Teardown](#teardown)

---

## Architecture Overview

```
Internet
    │
    ▼
Application Load Balancer (HTTPS :443, WSS :443)
    │
    ▼
ECS Fargate Service (CloudEngine containers, private subnet)
    │                │
    ▼                ▼
RDS PostgreSQL    ElastiCache Redis
(Multi-AZ)        (cluster mode off)
    │
    ▼
AWS Secrets Manager (JWT keys, Dhan credentials, encryption key)
```

**Key design decisions:**
- CloudEngine runs in a **private subnet** — no direct internet access
- All inbound traffic goes through the ALB (HTTPS/WSS only)
- Database and Redis are in the **data tier subnet** — reachable only from the app subnet
- Secrets never touch environment variables in task definitions — pulled from Secrets Manager at runtime
- Static egress IP via a **NAT Gateway** — required by Dhan API (they whitelist by IP)

---

## Prerequisites

You need the following installed locally before starting:

```bash
# AWS CLI v2
brew install awscli              # macOS
aws --version                    # → aws-cli/2.x.x

# Docker Desktop (for building the image)
docker --version                 # → Docker 24+

# jq (for parsing JSON in scripts)
brew install jq
```

Also ensure you have:
- An AWS account with admin access (or at minimum the IAM permissions listed in Step 11)
- A registered domain name if you want HTTPS (needed for ACM certificate)
- Your Dhan credentials ready (`CLIENT_ID` + `ACCESS_TOKEN`)

---

## Step 1 — AWS Account & CLI Setup

### 1.1 Configure AWS CLI

```bash
aws configure
# AWS Access Key ID: <your-key>
# AWS Secret Access Key: <your-secret>
# Default region: ap-south-1    ← Mumbai (closest to NSE)
# Default output format: json
```

> **Region:** Use `ap-south-1` (Mumbai) for lowest latency to NSE/Dhan servers.

### 1.2 Set working variables

Paste this into your terminal — these values are referenced throughout the guide:

```bash
export AWS_REGION=ap-south-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export PROJECT=money-printer
export ENV=production

echo "Account: $AWS_ACCOUNT_ID  Region: $AWS_REGION"
```

---

## Step 2 — VPC & Networking

### 2.1 Create VPC

```bash
VPC_ID=$(aws ec2 create-vpc \
  --cidr-block 10.0.0.0/16 \
  --tag-specifications "ResourceType=vpc,Tags=[{Key=Name,Value=${PROJECT}-vpc}]" \
  --query Vpc.VpcId --output text)

aws ec2 modify-vpc-attribute --vpc-id $VPC_ID --enable-dns-hostnames
aws ec2 modify-vpc-attribute --vpc-id $VPC_ID --enable-dns-support

echo "VPC: $VPC_ID"
```

### 2.2 Create subnets

```bash
# Public subnets (for ALB and NAT Gateway)
PUBLIC_AZ1=$(aws ec2 create-subnet \
  --vpc-id $VPC_ID --cidr-block 10.0.1.0/24 --availability-zone ${AWS_REGION}a \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=${PROJECT}-public-az1}]" \
  --query Subnet.SubnetId --output text)

PUBLIC_AZ2=$(aws ec2 create-subnet \
  --vpc-id $VPC_ID --cidr-block 10.0.2.0/24 --availability-zone ${AWS_REGION}b \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=${PROJECT}-public-az2}]" \
  --query Subnet.SubnetId --output text)

# Private app subnets (for ECS tasks)
PRIVATE_AZ1=$(aws ec2 create-subnet \
  --vpc-id $VPC_ID --cidr-block 10.0.11.0/24 --availability-zone ${AWS_REGION}a \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=${PROJECT}-private-az1}]" \
  --query Subnet.SubnetId --output text)

PRIVATE_AZ2=$(aws ec2 create-subnet \
  --vpc-id $VPC_ID --cidr-block 10.0.12.0/24 --availability-zone ${AWS_REGION}b \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=${PROJECT}-private-az2}]" \
  --query Subnet.SubnetId --output text)

# Data subnets (for RDS + ElastiCache)
DATA_AZ1=$(aws ec2 create-subnet \
  --vpc-id $VPC_ID --cidr-block 10.0.21.0/24 --availability-zone ${AWS_REGION}a \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=${PROJECT}-data-az1}]" \
  --query Subnet.SubnetId --output text)

DATA_AZ2=$(aws ec2 create-subnet \
  --vpc-id $VPC_ID --cidr-block 10.0.22.0/24 --availability-zone ${AWS_REGION}b \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=${PROJECT}-data-az2}]" \
  --query Subnet.SubnetId --output text)

echo "Subnets created."
```

### 2.3 Internet Gateway + NAT Gateway

```bash
# Internet Gateway (for ALB and NAT)
IGW=$(aws ec2 create-internet-gateway \
  --tag-specifications "ResourceType=internet-gateway,Tags=[{Key=Name,Value=${PROJECT}-igw}]" \
  --query InternetGateway.InternetGatewayId --output text)

aws ec2 attach-internet-gateway --internet-gateway-id $IGW --vpc-id $VPC_ID

# Allocate Elastic IP for NAT Gateway (this is the static egress IP — register with Dhan)
EIP=$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)
STATIC_EGRESS_IP=$(aws ec2 describe-addresses \
  --allocation-ids $EIP --query Addresses[0].PublicIp --output text)

echo "⚠️  Static egress IP: $STATIC_EGRESS_IP"
echo "    Register this IP in your Dhan API settings as the allowed originating IP."

# NAT Gateway (in public subnet AZ1)
NAT_GW=$(aws ec2 create-nat-gateway \
  --subnet-id $PUBLIC_AZ1 \
  --allocation-id $EIP \
  --tag-specifications "ResourceType=natgateway,Tags=[{Key=Name,Value=${PROJECT}-nat}]" \
  --query NatGateway.NatGatewayId --output text)

echo "Waiting for NAT Gateway to become available..."
aws ec2 wait nat-gateway-available --nat-gateway-ids $NAT_GW
echo "NAT Gateway ready."
```

### 2.4 Route tables

```bash
# Public route table → Internet Gateway
PUBLIC_RTB=$(aws ec2 create-route-table --vpc-id $VPC_ID \
  --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=${PROJECT}-public-rtb}]" \
  --query RouteTable.RouteTableId --output text)
aws ec2 create-route --route-table-id $PUBLIC_RTB --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW
aws ec2 associate-route-table --route-table-id $PUBLIC_RTB --subnet-id $PUBLIC_AZ1
aws ec2 associate-route-table --route-table-id $PUBLIC_RTB --subnet-id $PUBLIC_AZ2

# Private route table → NAT Gateway (ECS tasks use this for outbound Dhan API calls)
PRIVATE_RTB=$(aws ec2 create-route-table --vpc-id $VPC_ID \
  --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=${PROJECT}-private-rtb}]" \
  --query RouteTable.RouteTableId --output text)
aws ec2 create-route --route-table-id $PRIVATE_RTB --destination-cidr-block 0.0.0.0/0 --nat-gateway-id $NAT_GW
aws ec2 associate-route-table --route-table-id $PRIVATE_RTB --subnet-id $PRIVATE_AZ1
aws ec2 associate-route-table --route-table-id $PRIVATE_RTB --subnet-id $PRIVATE_AZ2
aws ec2 associate-route-table --route-table-id $PRIVATE_RTB --subnet-id $DATA_AZ1
aws ec2 associate-route-table --route-table-id $PRIVATE_RTB --subnet-id $DATA_AZ2

echo "Route tables configured."
```

### 2.5 Security groups

```bash
# ALB security group
ALB_SG=$(aws ec2 create-security-group \
  --group-name "${PROJECT}-alb-sg" --description "ALB inbound HTTPS/WSS" \
  --vpc-id $VPC_ID --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $ALB_SG \
  --protocol tcp --port 443 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id $ALB_SG \
  --protocol tcp --port 443 --cidr ::/0

# ECS task security group (only accepts traffic from ALB)
ECS_SG=$(aws ec2 create-security-group \
  --group-name "${PROJECT}-ecs-sg" --description "ECS tasks — ALB only" \
  --vpc-id $VPC_ID --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $ECS_SG \
  --protocol tcp --port 3000 --source-group $ALB_SG
aws ec2 authorize-security-group-ingress --group-id $ECS_SG \
  --protocol tcp --port 3001 --source-group $ALB_SG

# RDS security group (only accepts from ECS)
RDS_SG=$(aws ec2 create-security-group \
  --group-name "${PROJECT}-rds-sg" --description "RDS — ECS only" \
  --vpc-id $VPC_ID --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $RDS_SG \
  --protocol tcp --port 5432 --source-group $ECS_SG

# ElastiCache security group (only accepts from ECS)
REDIS_SG=$(aws ec2 create-security-group \
  --group-name "${PROJECT}-redis-sg" --description "Redis — ECS only" \
  --vpc-id $VPC_ID --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $REDIS_SG \
  --protocol tcp --port 6379 --source-group $ECS_SG

echo "Security groups created."
echo "ALB SG: $ALB_SG  ECS SG: $ECS_SG  RDS SG: $RDS_SG  Redis SG: $REDIS_SG"
```

---

## Step 3 — RDS PostgreSQL

### 3.1 Create DB subnet group

```bash
aws rds create-db-subnet-group \
  --db-subnet-group-name "${PROJECT}-db-subnet-group" \
  --db-subnet-group-description "MoneyPrinter RDS subnets" \
  --subnet-ids $DATA_AZ1 $DATA_AZ2
```

### 3.2 Generate a strong DB password

```bash
DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')
echo "DB password: $DB_PASSWORD"
# Save this — you'll need it for Secrets Manager in the next step
```

### 3.3 Create RDS instance

```bash
aws rds create-db-instance \
  --db-instance-identifier "${PROJECT}-postgres" \
  --db-instance-class db.t4g.small \
  --engine postgres \
  --engine-version "15.6" \
  --master-username moneyprinter \
  --master-user-password "$DB_PASSWORD" \
  --db-name moneyprinter \
  --allocated-storage 20 \
  --max-allocated-storage 100 \
  --storage-type gp3 \
  --storage-encrypted \
  --vpc-security-group-ids $RDS_SG \
  --db-subnet-group-name "${PROJECT}-db-subnet-group" \
  --backup-retention-period 7 \
  --no-publicly-accessible \
  --multi-az \
  --deletion-protection \
  --tags Key=Project,Value=${PROJECT} Key=Env,Value=${ENV}

echo "RDS creating... (takes 5–10 minutes)"
aws rds wait db-instance-available --db-instance-identifier "${PROJECT}-postgres"

# Get the endpoint
RDS_ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier "${PROJECT}-postgres" \
  --query 'DBInstances[0].Endpoint.Address' --output text)

echo "RDS endpoint: $RDS_ENDPOINT"
```

> **Instance class:** `db.t4g.small` (2 vCPU, 2 GB) is enough for trading hours load.
> Scale to `db.t4g.medium` if you see connection wait times under full market load.

---

## Step 4 — ElastiCache Redis

### 4.1 Create cache subnet group

```bash
aws elasticache create-cache-subnet-group \
  --cache-subnet-group-name "${PROJECT}-redis-subnet-group" \
  --cache-subnet-group-description "MoneyPrinter Redis subnets" \
  --subnet-ids $DATA_AZ1 $DATA_AZ2
```

### 4.2 Create Redis cluster

```bash
REDIS_AUTH_TOKEN=$(openssl rand -base64 32 | tr -d '/+=')
echo "Redis auth token: $REDIS_AUTH_TOKEN"
# Save this — you'll need it for Secrets Manager

aws elasticache create-cache-cluster \
  --cache-cluster-id "${PROJECT}-redis" \
  --cache-node-type cache.t4g.small \
  --engine redis \
  --engine-version "7.1" \
  --num-cache-nodes 1 \
  --cache-subnet-group-name "${PROJECT}-redis-subnet-group" \
  --security-group-ids $REDIS_SG \
  --auth-token "$REDIS_AUTH_TOKEN" \
  --transit-encryption-enabled \
  --at-rest-encryption-enabled \
  --tags Key=Project,Value=${PROJECT} Key=Env,Value=${ENV}

echo "Redis creating..."
aws elasticache wait cache-cluster-available --cache-cluster-id "${PROJECT}-redis"

REDIS_ENDPOINT=$(aws elasticache describe-cache-clusters \
  --cache-cluster-id "${PROJECT}-redis" \
  --show-cache-node-info \
  --query 'CacheClusters[0].CacheNodes[0].Endpoint.Address' --output text)

echo "Redis endpoint: $REDIS_ENDPOINT"
```

---

## Step 5 — Secrets Manager

Store all sensitive values in AWS Secrets Manager. The CloudEngine retrieves them at
startup via `SecretsService` when `SECRETS_BACKEND=aws`.

### 5.1 Generate application secrets

```bash
# Generate JWT RS256 key pair
openssl genrsa -out /tmp/jwt_private.pem 2048
openssl rsa -in /tmp/jwt_private.pem -pubout -out /tmp/jwt_public.pem

JWT_PRIVATE=$(cat /tmp/jwt_private.pem | awk 'NF {sub(/\r/,""); printf "%s\\n",$0;}')
JWT_PUBLIC=$(cat /tmp/jwt_public.pem | awk 'NF {sub(/\r/,""); printf "%s\\n",$0;}')

# AES-256 encryption key
ENCRYPTION_KEY=$(openssl rand -hex 32)

echo "Secrets generated."
```

### 5.2 Store secrets in AWS Secrets Manager

```bash
# PostgreSQL credentials
aws secretsmanager create-secret \
  --name "${PROJECT}/DATABASE_URL" \
  --secret-string "postgresql://moneyprinter:${DB_PASSWORD}@${RDS_ENDPOINT}:5432/moneyprinter?sslmode=require"

# Redis connection string
aws secretsmanager create-secret \
  --name "${PROJECT}/REDIS_URL" \
  --secret-string "rediss://:${REDIS_AUTH_TOKEN}@${REDIS_ENDPOINT}:6379"

# JWT keys
aws secretsmanager create-secret \
  --name "${PROJECT}/JWT_PRIVATE_KEY" \
  --secret-string "$JWT_PRIVATE"

aws secretsmanager create-secret \
  --name "${PROJECT}/JWT_PUBLIC_KEY" \
  --secret-string "$JWT_PUBLIC"

# Encryption key
aws secretsmanager create-secret \
  --name "${PROJECT}/ENCRYPTION_KEY" \
  --secret-string "$ENCRYPTION_KEY"

# Dhan credentials (fill in your actual values)
aws secretsmanager create-secret \
  --name "${PROJECT}/DHAN_CLIENT_ID" \
  --secret-string "REPLACE_WITH_YOUR_DHAN_CLIENT_ID"

aws secretsmanager create-secret \
  --name "${PROJECT}/DHAN_ACCESS_TOKEN" \
  --secret-string "REPLACE_WITH_YOUR_DHAN_ACCESS_TOKEN"

echo "All secrets stored."
```

> **Update Dhan credentials:** When your Dhan access token rotates, update it with:
> ```bash
> aws secretsmanager update-secret \
>   --secret-id "${PROJECT}/DHAN_ACCESS_TOKEN" \
>   --secret-string "new_token_here"
> ```
> Then restart the ECS service to pick up the new value.

---

## Step 6 — ECR — Build & Push Docker Image

### 6.1 Create Dockerfile

Create `Dockerfile` in the project root:

```dockerfile
# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig*.json nest-cli.json ./
COPY src ./src

RUN npm run build

# ─── Production stage ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Only install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000 3001

CMD ["node", "dist/main"]
```

### 6.2 Create ECR repository and push

```bash
# Create ECR repository
aws ecr create-repository \
  --repository-name "${PROJECT}" \
  --image-scanning-configuration scanOnPush=true \
  --encryption-configuration encryptionType=AES256

ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${PROJECT}"

# Log in to ECR
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# Build and push
docker build -t ${PROJECT}:latest .
docker tag ${PROJECT}:latest ${ECR_URI}:latest
docker push ${ECR_URI}:latest

echo "Image pushed: ${ECR_URI}:latest"
```

> **Tag with git SHA for traceability:**
> ```bash
> GIT_SHA=$(git rev-parse --short HEAD)
> docker tag ${PROJECT}:latest ${ECR_URI}:${GIT_SHA}
> docker push ${ECR_URI}:${GIT_SHA}
> ```

---

## Step 7 — ECS Fargate — Cluster & Task

### 7.1 Create ECS cluster

```bash
aws ecs create-cluster \
  --cluster-name "${PROJECT}-cluster" \
  --capacity-providers FARGATE FARGATE_SPOT \
  --tags key=Project,value=${PROJECT}

echo "ECS cluster created."
```

### 7.2 Create CloudWatch log group

```bash
aws logs create-log-group \
  --log-group-name "/ecs/${PROJECT}" \
  --tags Project=${PROJECT}

aws logs put-retention-policy \
  --log-group-name "/ecs/${PROJECT}" \
  --retention-in-days 30
```

### 7.3 Get secret ARNs

```bash
SECRET_DATABASE_URL=$(aws secretsmanager describe-secret \
  --secret-id "${PROJECT}/DATABASE_URL" --query ARN --output text)
SECRET_REDIS_URL=$(aws secretsmanager describe-secret \
  --secret-id "${PROJECT}/REDIS_URL" --query ARN --output text)
SECRET_JWT_PRIVATE=$(aws secretsmanager describe-secret \
  --secret-id "${PROJECT}/JWT_PRIVATE_KEY" --query ARN --output text)
SECRET_JWT_PUBLIC=$(aws secretsmanager describe-secret \
  --secret-id "${PROJECT}/JWT_PUBLIC_KEY" --query ARN --output text)
SECRET_ENCRYPTION=$(aws secretsmanager describe-secret \
  --secret-id "${PROJECT}/ENCRYPTION_KEY" --query ARN --output text)
SECRET_DHAN_CLIENT_ID=$(aws secretsmanager describe-secret \
  --secret-id "${PROJECT}/DHAN_CLIENT_ID" --query ARN --output text)
SECRET_DHAN_TOKEN=$(aws secretsmanager describe-secret \
  --secret-id "${PROJECT}/DHAN_ACCESS_TOKEN" --query ARN --output text)

echo "Secret ARNs retrieved."
```

### 7.4 Create task definition

Create `task-definition.json`:

```bash
cat > /tmp/task-definition.json << EOF
{
  "family": "${PROJECT}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:aws:iam::${AWS_ACCOUNT_ID}:role/${PROJECT}-ecs-execution-role",
  "taskRoleArn": "arn:aws:iam::${AWS_ACCOUNT_ID}:role/${PROJECT}-ecs-task-role",
  "containerDefinitions": [
    {
      "name": "cloudengine",
      "image": "${ECR_URI}:latest",
      "essential": true,
      "portMappings": [
        {"containerPort": 3000, "protocol": "tcp"},
        {"containerPort": 3001, "protocol": "tcp"}
      ],
      "environment": [
        {"name": "NODE_ENV",             "value": "production"},
        {"name": "PORT",                 "value": "3000"},
        {"name": "WS_PORT",              "value": "3001"},
        {"name": "DATABASE_SSL",         "value": "true"},
        {"name": "REDIS_TLS",            "value": "true"},
        {"name": "SECRETS_BACKEND",      "value": "aws"},
        {"name": "AWS_REGION",           "value": "${AWS_REGION}"},
        {"name": "DAILY_LOSS_LIMIT_RUPEES", "value": "10000"},
        {"name": "NORMAL_MAX_LOTS_PER_SIGNAL", "value": "10"},
        {"name": "UNUSUAL_VOLATILITY_VIX_THRESHOLD", "value": "20.0"}
      ],
      "secrets": [
        {"name": "DATABASE_URL",        "valueFrom": "${SECRET_DATABASE_URL}"},
        {"name": "REDIS_URL",           "valueFrom": "${SECRET_REDIS_URL}"},
        {"name": "JWT_PRIVATE_KEY",     "valueFrom": "${SECRET_JWT_PRIVATE}"},
        {"name": "JWT_PUBLIC_KEY",      "valueFrom": "${SECRET_JWT_PUBLIC}"},
        {"name": "ENCRYPTION_KEY",      "valueFrom": "${SECRET_ENCRYPTION}"},
        {"name": "DHAN_CLIENT_ID",      "valueFrom": "${SECRET_DHAN_CLIENT_ID}"},
        {"name": "DHAN_ACCESS_TOKEN",   "valueFrom": "${SECRET_DHAN_TOKEN}"}
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/${PROJECT}",
          "awslogs-region": "${AWS_REGION}",
          "awslogs-stream-prefix": "cloudengine"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "wget -q -O- http://localhost:3000/ | grep -q 'running' || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      }
    }
  ]
}
EOF

aws ecs register-task-definition \
  --cli-input-json file:///tmp/task-definition.json

echo "Task definition registered."
```

---

## Step 8 — Application Load Balancer

### 8.1 Create ALB

```bash
ALB_ARN=$(aws elbv2 create-load-balancer \
  --name "${PROJECT}-alb" \
  --subnets $PUBLIC_AZ1 $PUBLIC_AZ2 \
  --security-groups $ALB_SG \
  --scheme internet-facing \
  --type application \
  --ip-address-type ipv4 \
  --tags Key=Project,Value=${PROJECT} \
  --query LoadBalancers[0].LoadBalancerArn --output text)

ALB_DNS=$(aws elbv2 describe-load-balancers \
  --load-balancer-arns $ALB_ARN \
  --query LoadBalancers[0].DNSName --output text)

echo "ALB ARN: $ALB_ARN"
echo "ALB DNS: $ALB_DNS"
```

### 8.2 Create target groups

```bash
# HTTP API target group
HTTP_TG=$(aws elbv2 create-target-group \
  --name "${PROJECT}-http-tg" \
  --protocol HTTP \
  --port 3000 \
  --vpc-id $VPC_ID \
  --target-type ip \
  --health-check-path "/" \
  --health-check-interval-seconds 30 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 \
  --query TargetGroups[0].TargetGroupArn --output text)

# WebSocket target group
WS_TG=$(aws elbv2 create-target-group \
  --name "${PROJECT}-ws-tg" \
  --protocol HTTP \
  --port 3001 \
  --vpc-id $VPC_ID \
  --target-type ip \
  --health-check-path "/" \
  --health-check-port 3000 \
  --health-check-interval-seconds 30 \
  --query TargetGroups[0].TargetGroupArn --output text)

# Enable stickiness on WebSocket target group (important for persistent WS connections)
aws elbv2 modify-target-group-attributes \
  --target-group-arn $WS_TG \
  --attributes Key=stickiness.enabled,Value=true Key=stickiness.type,Value=lb_cookie

echo "Target groups created."
```

### 8.3 Create HTTPS listener

> You need an ACM certificate before this step. See [Step 12 — TLS Certificate](#step-12--tls-certificate-acm).

```bash
# After completing Step 12, set:
# CERT_ARN=$(aws acm list-certificates --query 'CertificateSummaryList[0].CertificateArn' --output text)

HTTPS_LISTENER=$(aws elbv2 create-listener \
  --load-balancer-arn $ALB_ARN \
  --protocol HTTPS \
  --port 443 \
  --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 \
  --certificates CertificateArn=$CERT_ARN \
  --default-actions Type=forward,TargetGroupArn=$HTTP_TG \
  --query Listeners[0].ListenerArn --output text)

# Add WebSocket routing rule (path /ws/* → WS target group)
aws elbv2 create-rule \
  --listener-arn $HTTPS_LISTENER \
  --conditions Field=path-pattern,Values='/ws/*' \
  --priority 10 \
  --actions Type=forward,TargetGroupArn=$WS_TG

echo "HTTPS listener configured."
```

---

## Step 9 — ECS Service

```bash
aws ecs create-service \
  --cluster "${PROJECT}-cluster" \
  --service-name "${PROJECT}-service" \
  --task-definition "${PROJECT}" \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIVATE_AZ1,$PRIVATE_AZ2],securityGroups=[$ECS_SG],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=$HTTP_TG,containerName=cloudengine,containerPort=3000" \
  --health-check-grace-period-seconds 90 \
  --deployment-configuration "minimumHealthyPercent=100,maximumPercent=200" \
  --deployment-controller type=ECS \
  --enable-execute-command \
  --tags key=Project,value=${PROJECT}

echo "ECS service created. Waiting for it to become stable..."
aws ecs wait services-stable \
  --cluster "${PROJECT}-cluster" \
  --services "${PROJECT}-service"

echo "Service is running."
```

> **`--desired-count 1`:** The CloudEngine manages stateful in-process data (open positions,
> market regime, signal scoring) that is not safe to run as multiple replicas without a
> distributed locking layer. Run a single task and use ALB health checks for automatic
> replacement if the task fails.

---

## Step 10 — Run Database Migrations

Migrations must be run once before (or after) the first deploy, and again on any
subsequent deploy that includes new migration files.

### 10.1 Run migrations via ECS Exec (recommended)

```bash
# Get the running task ID
TASK_ID=$(aws ecs list-tasks \
  --cluster "${PROJECT}-cluster" \
  --service-name "${PROJECT}-service" \
  --query taskArns[0] --output text | awk -F/ '{print $NF}')

# Open a shell in the running container
aws ecs execute-command \
  --cluster "${PROJECT}-cluster" \
  --task $TASK_ID \
  --container cloudengine \
  --interactive \
  --command "/bin/sh"
```

Inside the container shell:

```bash
# Run migrations
node -e "
const { DataSource } = require('typeorm');
const { dataSourceOptions } = require('./dist/database/data-source');
const ds = new DataSource(dataSourceOptions);
ds.initialize().then(() => ds.runMigrations()).then(m => {
  console.log('Applied:', m.map(x => x.name));
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
"
```

### 10.2 Alternative — run migrations as a one-off ECS task

Create a separate task definition for migrations (same image, overridden command):

```bash
aws ecs run-task \
  --cluster "${PROJECT}-cluster" \
  --task-definition "${PROJECT}" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIVATE_AZ1],securityGroups=[$ECS_SG],assignPublicIp=DISABLED}" \
  --overrides '{
    "containerOverrides": [{
      "name": "cloudengine",
      "command": ["node", "-e",
        "const {DataSource}=require(\"typeorm\");const {dataSourceOptions}=require(\"./dist/database/data-source\");const ds=new DataSource(dataSourceOptions);ds.initialize().then(()=>ds.runMigrations()).then(m=>{console.log(\"Applied:\",m.map(x=>x.name));process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"
      ]
    }]
  }'
```

Watch the CloudWatch logs to confirm migrations complete before the main service starts.

---

## Step 11 — IAM Roles & Policies

### 11.1 ECS execution role (pulls image, writes logs, reads secrets)

```bash
# Trust policy
cat > /tmp/ecs-trust.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "ecs-tasks.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
EOF

aws iam create-role \
  --role-name "${PROJECT}-ecs-execution-role" \
  --assume-role-policy-document file:///tmp/ecs-trust.json

# Attach managed policy (ECR pull + CloudWatch logs)
aws iam attach-role-policy \
  --role-name "${PROJECT}-ecs-execution-role" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# Inline policy for Secrets Manager access
cat > /tmp/secrets-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["secretsmanager:GetSecretValue"],
    "Resource": "arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:${PROJECT}/*"
  }]
}
EOF

aws iam put-role-policy \
  --role-name "${PROJECT}-ecs-execution-role" \
  --policy-name "secrets-access" \
  --policy-document file:///tmp/secrets-policy.json
```

### 11.2 ECS task role (application-level permissions)

```bash
aws iam create-role \
  --role-name "${PROJECT}-ecs-task-role" \
  --assume-role-policy-document file:///tmp/ecs-trust.json

# Secrets Manager access (for SecretsService at runtime)
aws iam put-role-policy \
  --role-name "${PROJECT}-ecs-task-role" \
  --policy-name "secrets-runtime" \
  --policy-document file:///tmp/secrets-policy.json

# SSM for ECS Exec (allows aws ecs execute-command)
cat > /tmp/ssm-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel"
    ],
    "Resource": "*"
  }]
}
EOF

aws iam put-role-policy \
  --role-name "${PROJECT}-ecs-task-role" \
  --policy-name "ecs-exec" \
  --policy-document file:///tmp/ssm-policy.json

echo "IAM roles created."
```

---

## Step 12 — TLS Certificate (ACM)

```bash
# Request a certificate for your domain
aws acm request-certificate \
  --domain-name api.yourdomain.com \
  --subject-alternative-names "*.yourdomain.com" \
  --validation-method DNS \
  --tags Key=Project,Value=${PROJECT}

# → Copy the CNAME records shown in the console and add them to your DNS provider
# → Wait for validation (usually 1–5 minutes with Route 53)

CERT_ARN=$(aws acm list-certificates \
  --certificate-statuses ISSUED \
  --query 'CertificateSummaryList[?DomainName==`api.yourdomain.com`].CertificateArn' \
  --output text)

echo "Certificate ARN: $CERT_ARN"
```

Point your domain at the ALB:

```bash
# If using Route 53:
aws route53 change-resource-record-sets \
  --hosted-zone-id YOUR_ZONE_ID \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.yourdomain.com",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "ZP97RAFLXTNZK",
          "DNSName": "'"$ALB_DNS"'",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'
```

> **ALB Hosted Zone ID for `ap-south-1`:** `ZP97RAFLXTNZK`

---

## Step 13 — Chrome Extension Configuration

After deployment, update the extension to point at your production URLs.

In `extension/src/background/background.ts` (or via extension settings):

```typescript
const CLOUDENGINE_URL = 'https://api.yourdomain.com';   // HTTPS only
const WEBSOCKET_URL   = 'wss://api.yourdomain.com/ws';  // WSS only
```

The extension's `assertSecureUrl()` enforces `https://` and `wss://` — plain HTTP/WS
connections are rejected before any network call is made.

Reload the extension in Chrome after updating:
1. `chrome://extensions` → MoneyPrinter → **Reload**

---

## Step 14 — CloudWatch Monitoring

### 14.1 Key metrics to alarm on

```bash
# CPU utilisation > 80%
aws cloudwatch put-metric-alarm \
  --alarm-name "${PROJECT}-cpu-high" \
  --namespace AWS/ECS \
  --metric-name CPUUtilization \
  --dimensions Name=ClusterName,Value="${PROJECT}-cluster" Name=ServiceName,Value="${PROJECT}-service" \
  --period 300 --evaluation-periods 2 \
  --statistic Average --comparison-operator GreaterThanThreshold --threshold 80 \
  --alarm-actions arn:aws:sns:${AWS_REGION}:${AWS_ACCOUNT_ID}:${PROJECT}-alerts

# Memory utilisation > 85%
aws cloudwatch put-metric-alarm \
  --alarm-name "${PROJECT}-memory-high" \
  --namespace AWS/ECS \
  --metric-name MemoryUtilization \
  --dimensions Name=ClusterName,Value="${PROJECT}-cluster" Name=ServiceName,Value="${PROJECT}-service" \
  --period 300 --evaluation-periods 2 \
  --statistic Average --comparison-operator GreaterThanThreshold --threshold 85 \
  --alarm-actions arn:aws:sns:${AWS_REGION}:${AWS_ACCOUNT_ID}:${PROJECT}-alerts

# ALB 5xx error rate > 1%
aws cloudwatch put-metric-alarm \
  --alarm-name "${PROJECT}-5xx-errors" \
  --namespace AWS/ApplicationELB \
  --metric-name HTTPCode_Target_5XX_Count \
  --dimensions Name=LoadBalancer,Value=$(echo $ALB_ARN | cut -d: -f6) \
  --period 60 --evaluation-periods 3 \
  --statistic Sum --comparison-operator GreaterThanThreshold --threshold 5 \
  --treat-missing-data notBreaching \
  --alarm-actions arn:aws:sns:${AWS_REGION}:${AWS_ACCOUNT_ID}:${PROJECT}-alerts
```

### 14.2 Application log insights

The CloudEngine writes structured logs to CloudWatch. Useful queries:

```
# Error log filter (past 1 hour)
fields @timestamp, @message
| filter @message like /ERROR/
| sort @timestamp desc
| limit 50

# Trading activity
fields @timestamp, @message
| filter @message like /\[LiveTradingService\]/ or @message like /\[ExecutionService\]/
| sort @timestamp desc
| limit 100

# DB connection issues
fields @timestamp, @message
| filter @message like /Unable to connect/ or @message like /TypeOrmModule/
| sort @timestamp desc
```

---

## Step 15 — Post-Deployment Checklist

```
Infrastructure
  ✓ RDS PostgreSQL — multi-AZ, storage encrypted, deletion protection on
  ✓ ElastiCache Redis — in-transit encryption, auth token set
  ✓ ECS task running in private subnet (no public IP)
  ✓ ALB accepting HTTPS :443 only
  ✓ All SGs least-privilege (no 0.0.0.0/0 inbound to ECS/RDS/Redis)

Secrets
  ✓ All 7 secrets in Secrets Manager (no plaintext in task definition env vars)
  ✓ DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN contain real values
  ✓ JWT_PRIVATE_KEY is PEM format with \n escaping

Application
  ✓ Migrations applied (check CloudWatch logs for "Applied: [...]")
  ✓ curl https://api.yourdomain.com/ → "MoneyPrinter CloudEngine is running."
  ✓ CloudWatch logs show: "[Bootstrap] CloudEngine is running on http://localhost:3000"
  ✓ CloudWatch logs show: "[LiveTradingService] armed state: DISARMED"
  ✓ CloudWatch logs show: NO "Unable to connect to the database" errors

Network
  ✓ Static egress IP ($STATIC_EGRESS_IP) registered with Dhan API
  ✓ HTTPS certificate issued (not self-signed)
  ✓ Chrome Extension updated to point at production HTTPS/WSS URL

Trading
  ✓ Paper trading tested end-to-end before enabling live trading
  ✓ DAILY_LOSS_LIMIT_RUPEES set to an appropriate value
  ✓ Live trading arm/disarm cycle tested from Chrome Extension
```

---

## Environment Variable Reference

For the ECS task definition, set these as `environment` (non-sensitive) and `secrets`
(pulled from Secrets Manager):

**Non-sensitive (environment block):**

| Variable | Production Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `WS_PORT` | `3001` |
| `DATABASE_SSL` | `true` |
| `REDIS_TLS` | `true` |
| `SECRETS_BACKEND` | `aws` |
| `AWS_REGION` | `ap-south-1` |
| `JWT_EXPIRY_SECONDS` | `1800` |
| `DAILY_LOSS_LIMIT_RUPEES` | `10000` |
| `NORMAL_MAX_LOTS_PER_SIGNAL` | `10` |
| `UNUSUAL_VOLATILITY_VIX_THRESHOLD` | `20.0` |
| `VOLATILITY_PROTECTION_LIMIT_LOTS` | `2` |
| `VIX_RESTORE_CONTINUOUS_MINUTES` | `5` |

**Sensitive (secrets block → from Secrets Manager):**

| Variable | Secret Name |
|---|---|
| `DATABASE_URL` | `money-printer/DATABASE_URL` |
| `REDIS_URL` | `money-printer/REDIS_URL` |
| `JWT_PRIVATE_KEY` | `money-printer/JWT_PRIVATE_KEY` |
| `JWT_PUBLIC_KEY` | `money-printer/JWT_PUBLIC_KEY` |
| `ENCRYPTION_KEY` | `money-printer/ENCRYPTION_KEY` |
| `DHAN_CLIENT_ID` | `money-printer/DHAN_CLIENT_ID` |
| `DHAN_ACCESS_TOKEN` | `money-printer/DHAN_ACCESS_TOKEN` |

---

## Cost Estimate

Approximate monthly cost in `ap-south-1` (Mumbai) for a single-task production deployment:

| Resource | Spec | Est. Monthly Cost |
|---|---|---|
| ECS Fargate | 0.5 vCPU, 1 GB, ~8 h/day trading | ~$8–12 |
| RDS PostgreSQL | db.t4g.small, Multi-AZ, 20 GB gp3 | ~$40–50 |
| ElastiCache Redis | cache.t4g.small | ~$18–22 |
| ALB | 1 ALB, low LCU usage | ~$20–25 |
| NAT Gateway | ~1 GB/day data processed | ~$35–45 |
| ECR | <1 GB storage | ~$1 |
| Secrets Manager | 7 secrets, ~1,000 API calls/month | ~$3 |
| CloudWatch | Logs + basic alarms | ~$5–10 |
| **Total** | | **~$130–170 / month** |

> **Cost reduction tips:**
> - Use **FARGATE_SPOT** capacity for the ECS service (up to 70% cheaper; acceptable since
>   the task is stateless from a container lifecycle perspective and auto-recovers)
> - Run the ECS service with `desired_count=0` outside trading hours (09:00–16:00 IST)
>   using a scheduled EventBridge rule
> - Use `db.t4g.micro` for RDS if positions/trade volume is low

---

## Teardown

To destroy all resources:

```bash
# Scale down ECS service first
aws ecs update-service \
  --cluster "${PROJECT}-cluster" \
  --service "${PROJECT}-service" \
  --desired-count 0

aws ecs delete-service \
  --cluster "${PROJECT}-cluster" \
  --service "${PROJECT}-service" \
  --force

# Delete RDS (disable deletion protection first)
aws rds modify-db-instance \
  --db-instance-identifier "${PROJECT}-postgres" \
  --no-deletion-protection --apply-immediately
aws rds delete-db-instance \
  --db-instance-identifier "${PROJECT}-postgres" \
  --skip-final-snapshot

# Delete Redis
aws elasticache delete-cache-cluster \
  --cache-cluster-id "${PROJECT}-redis"

# Delete ALB and target groups
aws elbv2 delete-load-balancer --load-balancer-arn $ALB_ARN
aws elbv2 delete-target-group --target-group-arn $HTTP_TG
aws elbv2 delete-target-group --target-group-arn $WS_TG

# Delete secrets
for secret in DATABASE_URL REDIS_URL JWT_PRIVATE_KEY JWT_PUBLIC_KEY ENCRYPTION_KEY DHAN_CLIENT_ID DHAN_ACCESS_TOKEN; do
  aws secretsmanager delete-secret --secret-id "${PROJECT}/${secret}" --force-delete-without-recovery
done

# Release Elastic IP
aws ec2 release-address --allocation-id $EIP

# Delete NAT Gateway (and wait)
aws ec2 delete-nat-gateway --nat-gateway-id $NAT_GW
aws ec2 wait nat-gateway-deleted --nat-gateway-ids $NAT_GW

# Delete VPC (subnets, route tables, IGW, SGs first)
# ... (use the console or a CloudFormation stack for easier cleanup)

echo "Teardown complete."
```

> **⚠ Warning:** Deleting RDS and secrets is irreversible. Ensure you have a final DB
> snapshot before tearing down a production environment.
