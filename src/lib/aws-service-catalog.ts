/**
 * AWS service catalog metadata for billing tooltip descriptions.
 * Maps bill service labels to short explanations and, when possible, official AWS documentation pages.
 */

interface AwsServiceInfo {
  description: string;
  officialUrl?: string;
}

const DEFAULT_AWS_SERVICE_INFO: AwsServiceInfo = {
  description: "该服务的用途说明暂未配置，请结合 AWS 控制台中的同名服务查看具体资源和计费项。",
  officialUrl: "https://aws.amazon.com/products/",
};

const AWS_SERVICE_CATALOG: Record<string, AwsServiceInfo> = {
  "Amazon Elastic Compute Cloud - Compute": {
    description: "EC2 实例本身的计算费用，通常对应虚拟机运行时长和实例规格成本。",
    officialUrl: "https://aws.amazon.com/ec2/",
  },
  "EC2 - Other": {
    // AWS 账单中的聚合分类，通常覆盖 EC2 周边网络、存储或附加项费用。
    description: "EC2 相关的非实例计算费用，常见包括数据传输、EBS 附加项、弹性 IP 或其他配套计费。",
    officialUrl: "https://aws.amazon.com/ec2/pricing/",
  },
  "Amazon Relational Database Service": {
    description: "托管数据库 RDS 的费用，通常包含数据库实例、存储、备份或相关 I/O。",
    officialUrl: "https://aws.amazon.com/rds/",
  },
  "Amazon Virtual Private Cloud": {
    description: "VPC 网络相关费用，常见包括 NAT Gateway、流量处理、IP 地址或网络组件计费。",
    officialUrl: "https://aws.amazon.com/vpc/",
  },
  "Amazon Elastic Container Service for Kubernetes": {
    description: "EKS 容器集群控制面或相关 Kubernetes 管理服务费用。",
    officialUrl: "https://aws.amazon.com/eks/",
  },
  "Amazon Elastic Load Balancing": {
    description: "负载均衡器费用，通常来自 ALB/NLB 的运行时长和处理流量。",
    officialUrl: "https://aws.amazon.com/elasticloadbalancing/",
  },
  "Amazon Simple Storage Service": {
    description: "S3 对象存储费用，通常包含存储容量、请求次数和数据传输。",
    officialUrl: "https://aws.amazon.com/s3/",
  },
  "Amazon EC2 Container Registry (ECR)": {
    description: "容器镜像仓库费用，通常包含镜像存储和拉取相关流量。",
    officialUrl: "https://aws.amazon.com/ecr/",
  },
  "AWS Key Management Service": {
    description: "KMS 密钥管理费用，通常来自密钥数量和加解密请求次数。",
    officialUrl: "https://aws.amazon.com/kms/",
  },
  AmazonCloudWatch: {
    description: "CloudWatch 监控费用，常见包括指标、日志、告警和可观测性相关计费。",
    officialUrl: "https://aws.amazon.com/cloudwatch/",
  },
  "Amazon Route 53": {
    description: "Route 53 DNS 解析和域名路由费用，可能包含托管区域和查询请求。",
    officialUrl: "https://aws.amazon.com/route53/",
  },
  "Amazon Simple Email Service": {
    description: "SES 邮件发送费用，通常来自邮件发送量和附加流量。",
    officialUrl: "https://aws.amazon.com/ses/",
  },
  "AWS Lambda": {
    description: "Lambda 无服务器函数费用，通常按调用次数和执行时长计费。",
    officialUrl: "https://aws.amazon.com/lambda/",
  },
  "Amazon CloudFront": {
    description: "CloudFront CDN 加速费用，通常来自边缘流量和请求次数。",
    officialUrl: "https://aws.amazon.com/cloudfront/",
  },
  "Amazon API Gateway": {
    description: "API Gateway 网关费用，通常按 API 调用次数和传输量计费。",
    officialUrl: "https://aws.amazon.com/api-gateway/",
  },
  "Amazon Simple Notification Service": {
    description: "SNS 消息通知费用，通常来自发布、推送和投递请求。",
    officialUrl: "https://aws.amazon.com/sns/",
  },
  "AWS Glue": {
    description: "Glue 数据集成/ETL 费用，通常来自作业运行时长、爬虫或元数据目录使用。",
    officialUrl: "https://aws.amazon.com/glue/",
  },
};

/**
 * Returns billing tooltip metadata for an AWS service label.
 * Falls back to a generic AWS products entry when the service has no specific mapping.
 */
export function getAwsServiceInfo(service: string): AwsServiceInfo {
  return AWS_SERVICE_CATALOG[service] || DEFAULT_AWS_SERVICE_INFO;
}
